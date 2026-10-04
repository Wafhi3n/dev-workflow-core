// stop-test-guard.js: Stop hook. Runs the project's checks and PREVENTS handing back on a regression.
//
// Unlike the other guards, which warn, this one blocks: exit 2 on a Stop hook cancels the stop and
// sends the failure back to Claude, which then has to fix it before concluding. It's the session's
// counterpart of a deploy script that refuses to deploy when the test suite returns 1.
//
// Configuration: <project>/.claude/dev-workflow.json, section "testGuard".
// No config file => this hook does nothing.
//
//   "testGuard": {
//     "enabled": true,
//     "checks": [
//       { "name": "build",  "command": "dotnet build x.csproj",
//         "runOnlyIfChanged": ["*.cs"] },
//       { "name": "schemas", "command": "python validate.py",
//         "runOnlyIfChanged": ["*.yaml"],
//         "failurePattern": "\\[ERROR\\]",
//         "baseline": ".claude/dev-workflow.schemas.json" }
//     ]
//   }
//
// Short form for a single check: "command" at the top level.
//
// Each check has its own trigger, so changing a .cs doesn't rerun the .yaml validation, and the
// other way round.
//
// THE SESSION'S WORKTREES
// -----------------------
// The project folder often isn't where the work happens: when several sessions share a checkout,
// each one edits in a worktree of its scratchpad, and the main checkout stays on the default
// branch. Testing only the project meant testing a branch nobody touches, and never seeing the
// session's changes.
//
// So the guard ALSO tests every folder of the session's scratchpad (depth 1 or 2) that carries its
// own .claude/dev-workflow.json: a worktree of the repository, as soon as the config is committed
// there. The scratchpad belongs to the session: another session's worktree is never in it, even
// if this session just read it.
// The scratchpad comes from the payload (scratchpad_dir), failing that from the transcript's path;
// when it can't be found, only the project is tested, as before.
//
// A budget bounds the whole thing ("budgetSeconds", 150 by default, under the manifest's 180 s
// timeout): the session's worktrees go first, and what couldn't run is reported without blocking.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPayload, getConfig, findConfig, projectRootFrom, matchesAny, isEnabled } = require('./config');

const STATE_FILE = '.claude/dev-workflow.teststate.json';
const CONFIG_FILE = '.claude/dev-workflow.json';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'obj', 'bin', '.venv', '__pycache__', 'target']);
const TOOLING_FAILURE = [127, 9009];
const DEFAULT_BUDGET_SECONDS = 150;

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    return null;
  }
}

function writeJson(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) { /* never blocking */ }
}

// Accepts the short form ("command" at the top level) as a single check.
function normalizeChecks(g) {
  if (Array.isArray(g.checks) && g.checks.length) {
    return g.checks.filter((c) => c && c.command).map((c, i) => Object.assign({ name: 'check' + (i + 1) }, c));
  }
  if (g.command) return [{ name: 'tests', command: g.command, runOnlyIfChanged: g.runOnlyIfChanged, exclude: g.exclude, timeoutSeconds: g.timeoutSeconds }];
  return [];
}

// The newest modification time among the watched files. The walk is bounded: a node_modules would
// make the hook slower than the check itself.
function newestChange(dir, patterns, exclude, deadline) {
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }

  for (const e of entries) {
    if (Date.now() > deadline) return newest;
    const p = path.join(dir, e.name);
    if (matchesAny(p, exclude)) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      newest = Math.max(newest, newestChange(p, patterns, exclude, deadline));
      continue;
    }
    if (!matchesAny(e.name, patterns) && !matchesAny(p, patterns)) continue;
    try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch (err) { /* ignore */ }
  }
  return newest;
}

// Rerunning a green check when nothing watched has moved is time lost on every stop.
function shouldRun(root, check, previous) {
  if (!Array.isArray(check.runOnlyIfChanged) || check.runOnlyIfChanged.length === 0) return true;
  if (!previous || !previous.lastOk) return true;
  return newestChange(root, check.runOnlyIfChanged, check.exclude, Date.now() + 3000) > previous.lastRunAt;
}

// The usable failure lines. Without a pattern the output can't be read: every failure then blocks.
function extractFailures(output, pattern) {
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern); } catch (e) { return null; }
  return output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && re.test(l));
}

// Filters out the failures already known. Same idea as fileSizeGuard's baseline: the existing debt
// is recorded, only a NEW error blocks. That's what lets a check be wired on a project you know
// isn't green yet, instead of leaving it off.
function newFailures(root, check, failures) {
  if (!check.baseline || failures === null) return failures;
  const known = readJson(path.resolve(root, check.baseline));
  if (!Array.isArray(known)) return failures;
  const set = new Set(known);
  return failures.filter((l) => !set.has(l));
}

// The check's timeout is capped by what's left of the budget: a check cut off by its timeout warns
// without blocking, whereas a hook killed by Claude Code would say nothing.
function runCheck(root, check, remainingMs) {
  const timeout = Math.max(1000, Math.min((Number(check.timeoutSeconds) || 120) * 1000, remainingMs));
  const run = spawnSync(String(check.command), { shell: true, cwd: root, encoding: 'utf8', timeout });

  if (run.error || TOOLING_FAILURE.includes(run.status)) {
    const why = run.error ? run.error.message : 'command not found (code ' + run.status + ')';
    return { ok: true, warn: '[' + check.name + '] Couldn\'t run "' + check.command + '": ' + why };
  }
  if (run.status === 0) return { ok: true };

  const output = ((run.stdout || '') + '\n' + (run.stderr || '')).trim();
  const recognized = extractFailures(output, check.failurePattern);
  const failures = newFailures(root, check, recognized);

  // Recorded debt: the pattern RECOGNIZED failure lines, and all of them are in the baseline. A
  // failure where NO line matches the pattern isn't debt, it's output the pattern can't read (a
  // broken tool, a format that changed): it blocks, with the end of the output. Before
  // 2026-10-02 it went through silently as soon as a pattern was given, even without a baseline.
  if (failures !== null && failures.length === 0 && recognized.length > 0) return { ok: true, knownDebt: true };

  const shown = failures !== null && failures.length > 0 ? failures : output.split(/\r?\n/).slice(-25);
  return { ok: false, name: check.name, command: check.command, status: run.status, lines: shown };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).toLowerCase();
  return process.platform === 'win32' ? norm(a) === norm(b) : path.resolve(a) === path.resolve(b);
}

// THIS session's scratchpad. Failing the payload's field, it's derived from the transcript's path
// (<tmp>/claude/<project>/<session>/scratchpad), and only trusted when it exists. A session_id
// outside the expected alphabet is never used to build a path.
function scratchpadOf(payload) {
  if (payload.scratchpad_dir && isDir(payload.scratchpad_dir)) return payload.scratchpad_dir;
  const session = String(payload.session_id || '');
  if (!payload.transcript_path || !/^[A-Za-z0-9-]+$/.test(session)) return null;
  const project = path.basename(path.dirname(String(payload.transcript_path)));
  const guess = path.join(os.tmpdir(), 'claude', project, session, 'scratchpad');
  return isDir(guess) ? guess : null;
}

// The scratchpad's folders (depth 1 and 2) that carry their own config: in practice, the
// repository's worktrees. A root once found isn't descended into.
function sessionRoots(scratch) {
  const roots = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, CONFIG_FILE))) { roots.push(p); continue; }
      if (depth < 2) visit(p, depth + 1);
    }
  };
  visit(scratch, 1);
  return roots;
}

// The roots to check, in order: the session's worktrees first (that's where it works), then the
// project. Each with ITS config and ITS state.
function targetsFor(payload) {
  const projectRoot = projectRootFrom(findConfig(null));
  const targets = [];
  const scratch = scratchpadOf(payload);
  if (scratch) {
    for (const root of sessionRoots(scratch)) {
      if (projectRoot && samePath(root, projectRoot)) continue;
      targets.push({ root, cfg: readJson(path.join(root, CONFIG_FILE)), label: '[' + path.relative(scratch, root) + '] ' });
    }
  }
  if (projectRoot) targets.push({ root: projectRoot, cfg: getConfig(null), label: '' });
  return targets;
}

function checkRoot(target, deadline, out) {
  const { root, cfg, label } = target;
  const checks = normalizeChecks(cfg.testGuard);
  if (checks.length === 0) return;
  const statePath = path.join(root, STATE_FILE);
  const state = readJson(statePath) || { checks: {} };
  state.checks = state.checks || {};

  for (const check of checks) {
    if (!shouldRun(root, check, state.checks[check.name])) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      out.warnings.push(label + '[' + check.name + '] not run: the Stop time budget is spent (' + root + ').');
      continue;
    }
    const result = runCheck(root, check, remaining);
    if (result.warn) { out.warnings.push(label + result.warn); continue; }
    state.checks[check.name] = { lastRunAt: Date.now(), lastOk: result.ok, command: check.command };
    if (!result.ok) out.failures.push(Object.assign({ label, root }, result));
  }
  writeJson(statePath, state);
}

function main() {
  const payload = readPayload();
  if (!payload) return 0;

  // Anti-loop: Claude Code flags the turns restarted BY a Stop hook. Without this, a check that
  // can't be satisfied would run forever.
  if (payload.stop_hook_active) return 0;

  const targets = targetsFor(payload).filter((t) => t.cfg && isEnabled(t.cfg.testGuard));
  if (targets.length === 0) return 0;

  const budget = Number(targets[targets.length - 1].cfg.testGuard.budgetSeconds);
  const deadline = Date.now() + (budget >= 0 ? budget : DEFAULT_BUDGET_SECONDS) * 1000;
  const out = { failures: [], warnings: [] };
  for (const target of targets) checkRoot(target, deadline, out);

  out.warnings.forEach((w) => console.error(w));
  if (out.failures.length === 0) return 0;

  for (const f of out.failures) {
    const where = f.label ? ' in ' + f.root : '';
    console.error(f.label + '[' + f.name + '] "' + f.command + '" failed' + where + ' (code ' + f.status + '):');
    f.lines.forEach((l) => console.error('  ' + l));
  }
  console.error('Fix the regression before concluding.');
  return 2;
}

process.exit(main());
