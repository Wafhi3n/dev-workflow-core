'use strict';
// Shared by the hook tests: throwaway projects, a hook run the way Claude Code runs it (JSON payload
// on stdin), and the interpreters the size guard can use, found the way CI provides them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

module.exports = { SCRIPTS, write, project, hook, findLua, findPython, lines };
