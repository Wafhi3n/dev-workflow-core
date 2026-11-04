'use strict';
// Shared by the hook tests: throwaway projects, a hook run the way Claude Code runs it (JSON payload
// on stdin), the interpreters the size guard can use, found the way CI provides them, and a git
// clone that is behind its origin.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'hooks', 'scripts');

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A project with its .claude/dev-workflow.json. No config at all when cfg is null.
function project(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dwc-test-'));
  if (cfg) write(root, '.claude/dev-workflow.json', JSON.stringify(cfg, null, 2));
  return root;
}

// The environment every hook run starts from: this machine's own CLAUDE_* variables are dropped,
// so a test means the same thing here and in CI.
function baseEnv(root, extra) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^CLAUDE_/.test(k)) delete env[k];
  env.CLAUDE_PROJECT_DIR = root;
  return Object.assign(env, extra || {});
}

// Runs one hook script with a payload. Returns { code, out, err }.
function hook(script, payload, root, env) {
  const run = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
    input: JSON.stringify(payload),
    cwd: root,
    encoding: 'utf8',
    env: baseEnv(root, env),
  });
  return { code: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim() };
}

// A Lua 5.1 for check_size.lua: CLAUDE_LUA_EXE when this machine sets it, else an unzipped Elune
// in WOW_ELUNE_DIR (what CI gives). Returns { exe, env } or null.
function findLua() {
  const fromEnv = process.env.CLAUDE_LUA_EXE;
  if (fromEnv && fs.existsSync(fromEnv)) return { exe: fromEnv, env: {} };
  const dir = process.env.WOW_ELUNE_DIR;
  if (!dir || !fs.existsSync(dir)) return null;
  const tops = [dir].concat(fs.readdirSync(dir).map((n) => path.join(dir, n)));
  for (const top of tops) {
    for (const name of ['lua.exe', 'lua5.1', 'lua']) {
      const exe = path.join(top, 'bin', name);
      if (!fs.existsSync(exe) || fs.statSync(exe).isDirectory()) continue;
      // Elune's macOS build can't find its own library as shipped.
      return { exe, env: { DYLD_LIBRARY_PATH: path.join(top, 'lib') } };
    }
  }
  return null;
}

// A Python 3 for check_size.py. Returns the environment that makes the hook use it, or null.
// The hook only takes a configured path that exists; a Microsoft Store install reports an app
// alias that fs.existsSync can't see, and is then left for the hook to find by name on the PATH,
// as it would in real use.
function findPython() {
  for (const name of ['python3', 'python', 'py']) {
    const run = spawnSync(name, ['-c', 'import sys; print(sys.version_info[0], sys.executable)'], { encoding: 'utf8' });
    if (run.error || run.status !== 0) continue;
    const m = String(run.stdout).trim().match(/^3 (.+)$/);
    if (!m) continue;
    return fs.existsSync(m[1]) ? { CLAUDE_PYTHON_EXE: m[1] } : {};
  }
  return null;
}

// Lines of n trivial statements, for bodies of a known length.
function lines(n, prefix) {
  return Array.from({ length: n }, (_, i) => (prefix || '  ') + 'x = ' + i).join('\n');
}

// GIT_AUTHOR_* and GIT_COMMITTER_* override each clone's user.name (CI sets them to "ci"), and the
// coordination guard's message names the author: they're left out so Bob's commit is really Bob's.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
}

// Alice's clone, behind origin by one commit of Bob's on src/shared.lua. Returns Alice's root.
function behindOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwc-coord-'));
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', origin);
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const alice = path.join(base, 'alice');
  const bob = path.join(base, 'bob');
  git(base, 'clone', '-q', origin, alice);
  git(alice, 'checkout', '-q', '-b', 'main');
  git(alice, 'config', 'user.name', 'Alice');
  git(alice, 'config', 'user.email', 'alice@example.com');
  write(alice, 'src/shared.lua', 'x = 1\n');
  write(alice, 'src/other.lua', 'y = 1\n');
  write(alice, '.claude/dev-workflow.json', JSON.stringify({ coordinationGuard: { enabled: true, fetchMinutes: 10, exclude: ['*/.claude/*'] } }));
  git(alice, 'add', '-A');
  git(alice, 'commit', '-q', '-m', 'init');
  git(alice, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', origin, bob);
  git(bob, 'config', 'user.name', 'Bob');
  git(bob, 'config', 'user.email', 'bob@example.com');
  write(bob, 'src/shared.lua', 'x = 2\n');
  git(bob, 'commit', '-q', '-am', 'bob changes shared');
  git(bob, 'push', '-q');
  return alice;
}

module.exports = { SCRIPTS, write, project, hook, findLua, findPython, lines, behindOrigin };
