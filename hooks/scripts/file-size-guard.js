// file-size-guard.js: PostToolUse hook (Edit|Write|MultiEdit|Bash|PowerShell), the size guard.
// Warns when a file that was just written goes over the project's limits.
//
// TWO paths, because a guard that depends on which tool did the writing isn't a guard: Edit/Write
// announce their `file_path` and that file gets measured; Bash and PowerShell announce nothing
// (sed, heredoc, script), so the guard looks for watched files whose mtime is brand new. Without
// that second path, any `sed -i` went through without ever being measured.
//
// Not blocking: the file is already written. Exit 2 just hands the message to Claude so it thinks
// about splitting.
//
// Configuration: <project>/.claude/dev-workflow.json, section "fileSizeGuard".
// No config file => this hook does nothing.
//
//   "fileSizeGuard": {
//     "enabled": true,
//     "maxFileLines": 500,
//     "maxFunctionLines": 60,
//     "include": ["*.py", "*.cs"],
//     "exclude": ["*/node_modules/*", "*/obj/*"],
//     "overrides": { "*/models.py": 1500, "*/Contracts/*.cs": 1200 },
//     "baseline": ".claude/dev-workflow.baseline.json",
//     "luaExe": "", "pythonExe": ""
//   }
//
// Per-FUNCTION analysis by language:
//   .lua                -> check_size.lua       (tokenizer, exact)   -- needs lua
//   .py                 -> check_size.py        (ast module, exact)  -- needs python
//   .cs / .java / JS/TS -> analyzers/braces.js  (heuristic)          -- no dependency
//   anything else       -> FILE level only

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPayload, getConfig, findConfig, projectRootFrom, matchesAny, isEnabled } = require('./config');
const braces = require('./analyzers/braces');
const baseline = require('./baseline');

// Finds an interpreter: config, then environment variable, then the usual names on the PATH.
function resolveExe(configured, envVar, names) {
  for (const candidate of [configured, process.env[envVar]]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  for (const name of names) {
    if (!spawnSync(name, ['-v'], { encoding: 'utf8' }).error) return name;
    if (!spawnSync(name, ['--version'], { encoding: 'utf8' }).error) return name;
  }
  return null;
}

// Runs an external analyzer. Contract: <maxFile> <maxFunction> <path>, one line per violation on
// stdout, exit code 1 when there are any.
// Returns null when the analysis couldn't run (the caller then falls back).
function runAnalyzer(exe, script, maxFile, maxFunc, file) {
  if (!exe || !fs.existsSync(script)) return null;
  const run = spawnSync(exe, [script, String(maxFile), String(maxFunc), file], { encoding: 'utf8' });
  if (run.error || run.status === null) return null;
  if (run.status === 0) return [];
  // Only the VIOLATIONS are kept. The summary line ("=> N over the limit") our analyzers print is
  // presentation: left in, it would survive the baseline filter and raise the alarm on its own,
  // with all the debt recorded.
  return String(run.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('=>'));
}

// The extension table, the two line formats and the line count live in braces.js, which exports
// them: its command line must print exactly the same strings as this hook, and baseline.js reads
// both back. One definition.
//
// countLines is worth sharing: a file ending with a newline gives split() an empty last element,
// and counting it reports 377 lines for a file that has 376. Both analyzers did that, Python's
// splitlines() didn't: three counters and two verdicts on the same file. Measured on 2026-08-30.
const { countLines, dialectFor, formatFile, formatFunction } = braces;

// The file's limit: the first "overrides" pattern that matches wins, else maxFileLines. Lets a
// central registry that is legitimately big stop shouting forever without turning the guard off
// for everything else.
function fileLimitFor(file, g) {
  const overrides = g.overrides;
  if (overrides && typeof overrides === 'object') {
    for (const pattern of Object.keys(overrides)) {
      if (matchesAny(file, [pattern])) return Number(overrides[pattern]) || Number(g.maxFileLines) || 500;
    }
  }
  return Number(g.maxFileLines) || 500;
}

// Picks the analyzer from the extension. Null when none applies.
function analyzeByLanguage(file, g, maxFile, maxFunc) {
  if (/\.lua$/i.test(file)) {
    const exe = resolveExe(g.luaExe, 'CLAUDE_LUA_EXE', ['lua', 'lua5.1', 'luajit']);
    return runAnalyzer(exe, path.join(__dirname, 'check_size.lua'), maxFile, maxFunc, file);
  }
  if (/\.py$/i.test(file)) {
    const exe = resolveExe(g.pythonExe, 'CLAUDE_PYTHON_EXE', ['python3', 'python', 'py']);
    return runAnalyzer(exe, path.join(__dirname, 'check_size.py'), maxFile, maxFunc, file);
  }
  const braceDialect = dialectFor(file);
  if (braceDialect) {
    const source = fs.readFileSync(file, 'utf8');
    const out = braces.analyze(source, maxFunc, braceDialect).map((v) => formatFunction(file, v, maxFunc));
    const total = countLines(source);
    if (total > maxFile) out.unshift(formatFile(file, total, maxFile));
    return out;
  }
  return null;
}

// How long a write counts as "the one that just happened". Wide enough for a slow command, short
// enough not to report again an edit from ten minutes ago.
const FRESH_MS = 60 * 1000;
const WALK_SKIP = new Set(['node_modules', 'obj', 'bin', 'dist', 'build', '.venv', '__pycache__', 'target']);
const MAX_CANDIDATES = 25;

// Watched files written in the last minute. The tree is walked rather than asking git: a repository
// can IGNORE the very folders that hold the code (seen for real: each addon is its own repository
// and the root ignores them all, so `git status` at the root sees none of those writes).
function recentlyWritten(dir, g, cutoff, out, deadline) {
  if (out.length >= MAX_CANDIDATES || Date.now() > deadline) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (out.length >= MAX_CANDIDATES || Date.now() > deadline) return out;
    const p = path.join(dir, e.name);
    if (matchesAny(p, g.exclude)) continue;
    if (e.isDirectory()) {
      if (WALK_SKIP.has(e.name) || e.name.startsWith('.')) continue;
      recentlyWritten(p, g, cutoff, out, deadline);
      continue;
    }
    if (Array.isArray(g.include) && g.include.length > 0 &&
        !matchesAny(p, g.include) && !matchesAny(e.name, g.include)) continue;
    try { if (fs.statSync(p).mtimeMs >= cutoff) out.push(p); } catch (err) { /* ignore */ }
  }
  return out;
}

// Measures ONE file and returns what's over the limit (an empty list means it's fine).
function violationsFor(file, g, configPath) {
  if (Array.isArray(g.include) && g.include.length > 0) {
    if (!matchesAny(file, g.include) && !matchesAny(path.basename(file), g.include)) return [];
  }
  if (matchesAny(file, g.exclude)) return [];

  const maxFile = fileLimitFor(file, g);
  const maxFunc = Number(g.maxFunctionLines) || 60;

  let violations = analyzeByLanguage(file, g, maxFile, maxFunc);

  // The fallback for every language without an analyzer (or whose analyzer couldn't run, its
  // interpreter missing): the file-level check.
  if (violations === null) {
    violations = [];
    const lines = countLines(fs.readFileSync(file, 'utf8'));
    if (lines > maxFile) violations.push(formatFile(file, lines, maxFile));
  }

  // Known debt: only what gets worse is reported.
  if (g.baseline) {
    const root = projectRootFrom(configPath);
    const data = baseline.load(path.resolve(root || '.', g.baseline));
    if (data) {
      // The separator is normalized without a regex: a literal backslash in a source that goes
      // through editing tools sometimes arrives single and breaks the pattern.
      const key = path.relative(root || '.', file).split(path.sep).join('/');
      violations = baseline.filterNew(violations, data[key]);
    }
  }
  return violations;
}

function main() {
  const payload = readPayload();
  if (!payload) return 0;

  const direct = payload.tool_input && payload.tool_input.file_path;
  const anchor = direct || payload.cwd || null;

  const configPath = findConfig(anchor);
  const cfg = getConfig(anchor);
  if (!cfg) return 0;

  const g = cfg.fileSizeGuard;
  if (!isEnabled(g)) return 0;

  // Which file(s) to measure: the one the tool announces, else the ones just written under the
  // project root.
  let files;
  if (direct) {
    files = fs.existsSync(direct) ? [direct] : [];
  } else {
    const root = projectRootFrom(configPath) || payload.cwd;
    if (!root) return 0;
    files = recentlyWritten(root, g, Date.now() - FRESH_MS, [], Date.now() + 2000);
  }
  if (files.length === 0) return 0;

  const maxFile = Number(g.maxFileLines) || 500;
  const maxFunc = Number(g.maxFunctionLines) || 60;
  const all = [];
  for (const f of files) {
    try { all.push.apply(all, violationsFor(f, g, configPath)); } catch (e) { /* unreadable: stay quiet */ }
  }
  if (all.length === 0) return 0;

  console.error('[size] Over the limits (max ' + maxFile + ' lines per file, ' +
                maxFunc + ' lines per function):');
  all.forEach((v) => console.error('  ' + v));
  console.error('Consider splitting this file or this function.');
  return 2;
}

process.exit(main());
