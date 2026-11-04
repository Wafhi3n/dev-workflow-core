// run-hook.js: runs one of the plugin's hook scripts the way Claude Code does (JSON payload on
// stdin, exit code 2 = "tell the model", stderr = the message), from inside the OpenCode server.
//
// Two things differ from a Claude Code hook, both on purpose:
// - The run is ASYNCHRONOUS. The plugin lives in the server process: a spawnSync of the Stop checks
//   (up to 150 s) would freeze every session and the terminal UI with it.
// - The interpreter is `node` from the PATH, never process.execPath: inside OpenCode that is the
//   OpenCode binary itself, not Node. The plugin option "node" (or DEV_WORKFLOW_NODE) overrides it.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
export const SCRIPTS = path.join(PLUGIN_ROOT, 'hooks', 'scripts');

// The timeouts of hooks/hooks.json, in milliseconds. A hook cut off by its timeout lets the call
// through, as in Claude Code.
export const TIMEOUTS = {
  'readonly-path-guard.js': 15000,
  'coordination-guard.js': 20000,
  'file-size-guard.js': 30000,
  'stop-test-guard.js': 180000,
};

let warnedMissingNode = false;

// Resolves to { code, out, err }. code is null when the script couldn't run or ran out of time:
// that never blocks anything.
export function runHook(script, payload, options) {
  const opts = options || {};
  const projectDir = opts.projectDir || payload.cwd || process.cwd();
  const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
  const exe = opts.node || process.env.DEV_WORKFLOW_NODE || 'node';

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    };

    let child;
    try {
      child = spawn(exe, [path.join(SCRIPTS, script)], { cwd: projectDir, env, windowsHide: true });
    } catch (e) {
      return finish(null);
    }
    timer = setTimeout(() => { child.kill(); finish(null); }, opts.timeoutMs || TIMEOUTS[script] || 30000);

    child.on('error', (e) => {
      if (e && e.code === 'ENOENT' && !warnedMissingNode) {
        warnedMissingNode = true;
        console.warn('[dev-workflow-core] "' + exe + '" not found: the guards are off. Install Node.js, ' +
                     'or give its path in the plugin option "node".');
      }
      finish(null);
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* the script may exit before reading everything */ });
    child.stdin.end(JSON.stringify(payload));
  });
}
