// readonly-path-guard.js: PreToolUse hook. Blocks a write when the TARGET path falls in an area
// declared read-only (raw extraction, installed game folder, vendored dependency, deployed copy...).
//
// Two payload shapes are inspected:
//
//   Edit|Write|MultiEdit|NotebookEdit -> tool_input.file_path, an explicit path.
//   Bash|PowerShell                   -> tool_input.command, from which the WRITE targets are
//                                        extracted (see below).
//
// Only the PATH is inspected, never the content: a file that merely mentions a forbidden path in a
// comment goes through.
//
// Configuration: <project>/.claude/dev-workflow.json, section "readonlyPathGuard".
// No config file => this hook does nothing.
//
//   "readonlyPathGuard": {
//     "enabled": true,
//     "blocked": ["*/OfficialFiles/*", "*Raw_Extrac*"],
//     "message": "Edit the source, then deploy with deploy.ps1."
//   }
//
// exit 0 = allowed; exit 2 = blocked (the message goes to Claude).
//
// ---------------------------------------------------------------------------------------------
// THE BASH BRANCH IS INCOMPLETE ON PURPOSE, AND YOU NEED TO KNOW IT.
//
// Added on 2026-08-30: until then this hook only saw Edit/Write, so an edit made with `sed -i`,
// `tee` or `cat > file` went through without triggering anything, and Claude Code's auto mode
// explicitly steers toward those forms. The hole was total.
//
// It isn't total anymore, it's still real: only UNAMBIGUOUS write constructs are blocked
// (redirection, sed -i, tee, cp/mv/rm, PowerShell write cmdlets). A write made INSIDE an
// interpreter -- `python - <<PY ... open(p,'w') ... PY`, `node -e "fs.writeFileSync(...)"` --
// can't be detected by a regex on the command line, and pretending otherwise would be worse than
// doing nothing. That case gets a WARNING, never a block.
//
// In other words: this hook catches the slip, not the deliberate workaround. That's the realistic
// threat model; don't credit it with another one.
// ---------------------------------------------------------------------------------------------

const path = require('path');
const { readPayload, getConfig, matchesAny, isEnabled } = require('./config');

// The "blocked" patterns are anchored and written absolute ("*/docs/API/*"). A token picked out of
// a command line is nearly always relative ("docs/API/misc.md") and would NEVER match: it has to
// be resolved against the working directory before comparing.
function toAbsolute(token, cwd) {
  try {
    return path.resolve(cwd || process.cwd(), token);
  } catch (e) {
    return null;
  }
}

// Strips a token's quotes, and rejects what can't be a path (option, variable, stream descriptor,
// substitution).
function cleanToken(raw) {
  if (!raw) return null;
  let t = String(raw).trim().replace(/^["']|["']$/g, '');
  if (!t) return null;
  if (/^-/.test(t)) return null;              // an option, not a path
  if (/^\d+$/.test(t)) return null;           // 2>&1 and friends
  if (/^[&$`(){};|]/.test(t)) return null;
  return t;
}

function pushAll(dest, values) {
  values.forEach(function (v) {
    const t = cleanToken(v);
    if (t) dest.push(t);
  });
}

// The write targets of a command line, from unambiguous constructs only.
function writeTargets(cmd) {
  const out = [];

  // Redirection: > file, >> file. >&N and 2>&1 are left out.
  let m;
  const redir = /(?:^|[\s;|&])\d?>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
  while ((m = redir.exec(cmd)) !== null) pushAll(out, [m[1]]);

  // sed -i / sed --in-place: the target is an argument of the segment.
  const segments = cmd.split(/[;|&]{1,2}|\n/);
  segments.forEach(function (seg) {
    if (!/\bsed\b/.test(seg)) return;
    if (!/\s-[a-zA-Z]*i\b|--in-place/.test(seg)) return;
    // Everything that looks like a path in this segment: casting wide is fine, a false positive here
    // only costs an explicit, readable block.
    pushAll(out, seg.split(/\s+/).slice(1));
  });

  // tee [-a] file
  const tee = /\btee\b(?:\s+-\w+)*\s+("[^"]+"|'[^']+'|[^\s;|&]+)/g;
  while ((m = tee.exec(cmd)) !== null) pushAll(out, [m[1]]);

  // cp / mv: the destination is the last argument. rm / truncate: all of them.
  segments.forEach(function (seg) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const verb = path.basename(words[0]);
    const args = words.slice(1).filter(function (a) { return !/^-/.test(a); });
    if (!args.length) return;
    if (verb === 'cp' || verb === 'mv' || verb === 'install') {
      pushAll(out, [args[args.length - 1]]);
    } else if (verb === 'rm' || verb === 'truncate' || verb === 'shred') {
      pushAll(out, args);
    }
  });

  // dd of=file
  const dd = /\bof=("[^"]+"|'[^']+'|[^\s;|&]+)/g;
  while ((m = dd.exec(cmd)) !== null) pushAll(out, [m[1]]);

  // PowerShell write cmdlets, positional or -Path/-LiteralPath/-FilePath.
  const ps = /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|Remove-Item|New-Item|Move-Item|Copy-Item)\b((?:\s+(?:-\w+\s+)?(?:"[^"]+"|'[^']+'|[^\s;|&]+))+)/gi;
  while ((m = ps.exec(cmd)) !== null) {
    pushAll(out, m[1].split(/\s+/).filter(function (a) { return a && !/^-/.test(a); }));
  }

  return out;
}

// A forbidden path cited somewhere in a command that runs an interpreter: undecidable by regex.
// Warn, don't block.
function looksLikeInterpreter(cmd) {
  return /\b(?:python3?|node|perl|ruby|php|pwsh|powershell)\b/.test(cmd) || /<<-?\s*['"]?\w+/.test(cmd);
}

// Everything that looks like a path, wherever it sits in the command. Only used for the warning:
// never a block on this.
//
// Stripping the quotes matters, it isn't cosmetic: a token picked out of embedded code arrives as
// 'docs/API/misc.md', and since the */docs/API/* pattern is anchored, the leading apostrophe alone
// would let it slip through.
function allTokens(cmd) {
  return cmd
    .split(/[\s;|&()<>,]+/)
    .map(cleanToken)
    .filter(function (t) { return t && /[\/\\]/.test(t); });
}

function firstBlocked(candidates, cwd, blocked) {
  for (let i = 0; i < candidates.length; i++) {
    const abs = toAbsolute(candidates[i], cwd);
    if (!abs) continue;
    const hit = blocked.find(function (pattern) {
      return pattern && String(pattern).trim() && matchesAny(abs, [pattern]);
    });
    if (hit) return { path: candidates[i], rule: hit };
  }
  return null;
}

function refuse(found, g) {
  console.error("BLOCKED: '" + found.path + "' is read-only (rule: " + found.rule + ').');
  if (g.message && String(g.message).trim()) console.error(g.message);
  return 2;
}

function main() {
  const payload = readPayload();
  if (!payload || !payload.tool_input) return 0;

  const file = payload.tool_input.file_path;
  const cmd = payload.tool_input.command;
  if (!file && !cmd) return 0;

  const cfg = getConfig(file || payload.cwd || process.cwd());
  if (!cfg) return 0;

  const g = cfg.readonlyPathGuard;
  if (!isEnabled(g)) return 0;
  if (!Array.isArray(g.blocked)) return 0;

  // --- Explicit path (Edit/Write/MultiEdit/NotebookEdit) ---
  if (file) {
    const hit = g.blocked.find(function (pattern) {
      return pattern && String(pattern).trim() && matchesAny(file, [pattern]);
    });
    if (!hit) return 0;
    return refuse({ path: file, rule: hit }, g);
  }

  // --- Command line (Bash/PowerShell) ---
  const cwd = payload.cwd || process.cwd();

  const found = firstBlocked(writeTargets(cmd), cwd, g.blocked);
  if (found) return refuse(found, g);

  // Nothing unambiguous, but a forbidden path still shows up in a command that could write through
  // an interpreter: say so, without blocking.
  if (looksLikeInterpreter(cmd)) {
    const cited = firstBlocked(allTokens(cmd), cwd, g.blocked);
    if (cited) {
      console.error("Warning: '" + cited.path + "' is read-only (rule: " +
                    cited.rule + "), and this command goes through an interpreter: " +
                    "this hook can't tell whether it writes there. Check before going on.");
    }
  }

  return 0;
}

process.exit(main());
