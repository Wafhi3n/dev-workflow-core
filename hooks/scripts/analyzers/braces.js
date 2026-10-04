// braces.js: per-function analysis for brace languages, by counting depth. The starting heuristic
// comes from a Python script (check_monolithic.py) ported to JS and extended to JS/TS so it needs
// NO dependency: it's the only per-function analyzer available everywhere.
//
// This is not a parser. An unusual signature can be missed, and a template literal holding
// unbalanced braces would throw the count off. A false negative is acceptable for an advisory
// guard; a false positive wouldn't be, hence signatures that are deliberately strict.

const fs = require('fs');
const path = require('path');

// No chain of regexes here. No order works: blanking strings before comments breaks
// `// don't do this` (the apostrophe opens a string that runs to the next one, dozens of lines
// further), and the reverse order breaks `"http://x"` (the // of the URL cuts the line).
// A state machine handles both correctly in one pass.

// C# / Java: at least one modifier, then a name followed by '('.
const SIG_CSHARP = new RegExp(
  '^\\s*' +
  '(?:(?:public|private|protected|internal|static|virtual|override|abstract|' +
  'async|partial|sealed|new|unsafe|extern|final|synchronized)\\s+)+' +
  '(?!(?:class|struct|interface|enum|namespace|record)\\b)' +
  '(?:[\\w<>\\[\\]?,\\s.]+?\\s+)?' +
  '([A-Za-z_]\\w*)\\s*\\('
);

// JS / TS: four common shapes. Order doesn't matter, the first match wins.
const SIG_JS = [
  // function foo(...)  /  export async function foo(...)
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  // const foo = (...) => {   /  let foo = async function (...)
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  // class or object method: foo(...) {   with optional TS modifiers
  /^\s*(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{/,
  // Inline callback passed to a call: router.get('/x', async (req, res) => {
  // Covers Express handlers and big .map()/.forEach() bodies, where logic piles up without ever
  // getting a name: the blind spot of the three shapes above.
  /^\s*(?:\w+\.)*(\w+)\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{/,
];

// Keywords that look like a call but open a control block.
const NOT_A_FUNCTION = new Set([
  'If', 'For', 'While', 'Switch', 'Catch', 'Finally', 'Using', 'Lock', 'Do', 'Try',
  'if', 'for', 'while', 'switch', 'catch', 'finally', 'do', 'try', 'return', 'typeof',
  'await', 'new', 'delete', 'void', 'in', 'of', 'with', 'yield',
]);

// End of a line comment, a block comment, or a C# verbatim literal.
function endOfComment(src, i, n) {
  if (src[i + 1] === '/') {
    const e = src.indexOf('\n', i);
    return e === -1 ? n : e;
  }
  const e = src.indexOf('*/', i + 2);
  return e === -1 ? n : e + 2;
}

function endOfVerbatim(src, i, n) {
  let k = i + 2;
  while (k < n) {
    if (src[k] !== '"') { k++; continue; }
    if (src[k + 1] === '"') { k += 2; continue; }  // "" is an escaped quote
    return k + 1;
  }
  return n;
}

// A single- or double-quoted string does NOT run past the end of the line: that's what keeps a
// stray apostrophe from swallowing the rest of the file. A template literal (backtick) legitimately
// spans lines.
function endOfString(src, i, n, quote) {
  let k = i + 1;
  while (k < n) {
    if (src[k] === '\\') { k += 2; continue; }
    if (src[k] === quote) return k + 1;
    if (src[k] === '\n' && quote !== '`') return k;
    k++;
  }
  return n;
}

// Blanks comments and literals while KEEPING the newlines: a region replaced by shorter text would
// shift every line number after it, and the reported bounds would be wrong.
function strip(source) {
  const n = source.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const c = source[i];
    const d = i + 1 < n ? source[i + 1] : '';
    let end = -1;

    if (c === '/' && (d === '/' || d === '*')) end = endOfComment(source, i, n);
    else if (c === '@' && d === '"') end = endOfVerbatim(source, i, n);
    else if (c === '"' || c === "'" || c === '`') end = endOfString(source, i, n, c);

    if (end === -1) { out += c; i++; continue; }

    for (; i < end && i < n; i++) out += source[i] === '\n' ? '\n' : ' ';
  }

  return out;
}

// The line of the opening brace, within the 4 lines after the signature. None means an abstract
// method, a TS overload, or an interface declaration.
function findOpeningBrace(lines, from) {
  for (let i = from; i < Math.min(from + 5, lines.length); i++) {
    if (lines[i].includes('{')) return i;
  }
  return -1;
}

// Counts until the depth goes back to zero.
function findClosingLine(lines, openLine) {
  let depth = 0;
  for (let i = openLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function matchSignature(line, dialect) {
  if (dialect === 'js') {
    for (const re of SIG_JS) {
      const m = line.match(re);
      if (m) return m[1];
    }
    return null;
  }
  const m = line.match(SIG_CSHARP);
  return m ? m[1] : null;
}

// [{ name, startLine, length }] for the functions longer than maxFunc.
// dialect: 'csharp' (default) or 'js'.
function analyze(source, maxFunc, dialect) {
  const lines = strip(source).split(/\r?\n/);
  const violations = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const name = matchSignature(lines[i], dialect);
    if (!name || NOT_A_FUNCTION.has(name)) continue;

    const open = findOpeningBrace(lines, i);
    if (open === -1) continue;

    const close = findClosingLine(lines, open);
    if (close === -1) continue;

    // A nested function can be matched twice when its signature sits on a line already covered;
    // each pair of bounds is reported once.
    const key = i + ':' + close;
    if (seen.has(key)) continue;
    seen.add(key);

    const length = close - i + 1;
    if (length > maxFunc) violations.push({ name, startLine: i + 1, length });
  }

  return violations;
}

// ------------------------------------------------------------ dialect and formatting
//
// These three used to live in file-size-guard.js. They moved here because the command line below
// needs them too, and a second copy would be worse than a plain duplicate: the line format is READ
// BACK by baseline.js (its PARSE regex). Two definitions of a string someone else parses is a
// baseline that stops filtering, silently, the day one of them changes.

const DIALECTS = [
  [/\.(cs|java)$/i, 'csharp'],
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/i, 'js'],
];

// 'csharp', 'js', or null when no brace dialect applies.
function dialectFor(file) {
  for (const [re, name] of DIALECTS) if (re.test(file)) return name;
  return null;
}

// A file that ends with a newline (nearly all of them) gives split() an empty last element.
// Counting it reports 377 lines for a file that has 376, one off from wc, from Get-Content and from
// any home-made guard counting alongside. Python's splitlines() never had that defect: this is
// where the analyzers disagreed. Measured on 2026-08-30.
function countLines(source) {
  const parts = source.split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function formatFile(file, lines, maxFile) {
  return '[FILE] ' + path.basename(file) + ': ' + lines +
         ' lines (max ' + maxFile + ', +' + (lines - maxFile) + ')';
}

function formatFunction(file, v, maxFunc) {
  return '[FUNCTION] ' + path.basename(file) + ':' + v.startLine + '  ' + v.name +
         '(): ' + v.length + ' lines (max ' + maxFunc + ', +' + (v.length - maxFunc) + ')';
}

// ------------------------------------------------------------------ command line
//
// This analyzer is called two ways. As a library by file-size-guard.js, which is JS too and has no
// reason to pay for a spawn. And as a subprocess by everything else: a check script run by hand,
// a CI job, a Makefile.
//
//   node braces.js [--porcelain] <maxFile> <maxFunction> <file...>
//
// Without the option, the format is the one of check_size.lua and check_size.py, character for
// character. It's meant for a person, and read back by baseline.js, which makes it awkward for
// anyone else to parse: it shortens the path to the file name.
//
// --porcelain prints one tab-separated record per finding instead, with fixed fields and the full
// path, for a caller that does its own formatting:
//
//   CONTRACT         braces    2
//   FILE             <path>    <lines>       <max>
//   FUNCTION         <path>    <startLine>   <name>   <lines>   <max>
//   UNREADABLE       <path>    <reason>
//   UNKNOWN-DIALECT  <path>
//
// CONTRACT comes FIRST and ALWAYS, even when there's nothing to report. It carries the format's
// version, but its real purpose is elsewhere: before 1.1.0, this file was only a module. Running
// it as a subprocess loaded the module and exited 0 without a line, which a caller would read as
// "nothing over the limit". An outdated plugin would have given an unearned green, on the very day
// you pull. A caller that requires this line can't mistake "analyzed, nothing found" for "never
// analyzed".
//
// The last two say "this file was NOT analyzed". In human format they go to stderr, where a reader
// sees them; in porcelain they are records like the others, because a caller that only reads
// stdout would miss them, conclude "nothing over the limit" and show an unearned green. It also
// spares the caller from redirecting stderr: in PowerShell 5.1, redirecting a native program's
// error stream wraps each line in an ErrorRecord and fails $? on an exit code of 0.
//
// They do NOT count as violations: a file that wasn't analyzed isn't a faulty file. The exit code
// only speaks about violations.
//
// Exit codes: 0 nothing over the limit, 1 at least one, 2 the analysis didn't run. A caller must
// NEVER read any other code as "nothing to report".

// Goes up when the shape of the records changes in a way an existing caller couldn't read. Adding a
// TYPE of record isn't a break: callers already filter on the first field.
// Version 2 (dev-workflow-core 2.0.0): the record names went from French (CONTRAT, FICHIER,
// FONCTION, ILLISIBLE, DIALECTE-INCONNU) to English. A v1 caller looking for CONTRAT finds none and
// must report the analysis as not done, never as clean.
const PORCELAIN_VERSION = 2;

function parseArgs(argv) {
  const porcelain = argv.includes('--porcelain');
  const rest = argv.filter((a) => a !== '--porcelain');
  const maxFile = Number(rest[0]);
  const maxFunc = Number(rest[1]);
  const files = rest.slice(2);

  if (!Number.isFinite(maxFile) || maxFile <= 0) return null;
  if (!Number.isFinite(maxFunc) || maxFunc <= 0) return null;
  if (files.length === 0) return null;

  return { porcelain, maxFile, maxFunc, files };
}

// Reports a file that couldn't be analyzed without stopping the others: the caller wants the
// fullest picture possible, not a stop at the first snag.
function reportSkipped(out, o, kind, file, humanText, extra) {
  if (o.porcelain) out.push([kind, file].concat(extra || []).join('\t'));
  else console.error('  [!] ' + humanText);
}

// { lines, violations }: the lines to print, and how many of them are real violations. The two
// aren't the same: see the comment about UNREADABLE.
function checkFile(file, o) {
  const out = [];
  let source;

  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (e) {
    reportSkipped(out, o, 'UNREADABLE', file,
                  'Unreadable: ' + file + ' (' + e.message + ')', [e.code || e.message]);
    return { lines: out, violations: 0 };
  }

  let violations = 0;
  const total = countLines(source);

  if (total > o.maxFile) {
    violations++;
    out.push(o.porcelain ? ['FILE', file, total, o.maxFile].join('\t')
                         : formatFile(file, total, o.maxFile));
  }

  // An extension without a brace dialect: the line count still holds, the per-function analysis
  // doesn't. Say so, rather than report zero violations, which would read as "no function too
  // long".
  const dialect = dialectFor(file);
  if (!dialect) {
    reportSkipped(out, o, 'UNKNOWN-DIALECT', file,
                  'Unknown dialect, file level only: ' + file);
    return { lines: out, violations };
  }

  for (const v of analyze(source, o.maxFunc, dialect)) {
    violations++;
    out.push(o.porcelain ? ['FUNCTION', file, v.startLine, v.name, v.length, o.maxFunc].join('\t')
                         : formatFunction(file, v, o.maxFunc));
  }

  return { lines: out, violations };
}

function main(argv) {
  const o = parseArgs(argv);
  if (!o) {
    console.error('usage: node braces.js [--porcelain] <maxFile> <maxFunction> <file...>');
    return 2;
  }

  if (o.porcelain) console.log(['CONTRACT', 'braces', PORCELAIN_VERSION].join('\t'));

  let violations = 0;
  for (const file of o.files) {
    const r = checkFile(file, o);
    violations += r.violations;
    r.lines.forEach((line) => console.log(line));
  }

  // The summary is PRESENTATION, so it has no place in porcelain, where every line must be a
  // record. file-size-guard.js already filters it out for the same reason, on the baseline side
  // (see runAnalyzer).
  if (violations > 0 && !o.porcelain) {
    console.log('=> ' + violations + ' over the limit.');
  }

  return violations > 0 ? 1 : 0;
}

// process.exitCode, not process.exit(): when stdout is piped, writing is asynchronous and
// process.exit() truncates the output without warning. Letting Node exit on its own flushes first.
if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { analyze, countLines, dialectFor, formatFile, formatFunction };
