'use strict';
// setup.js: creates the project the OpenCode smoke test runs in (see README.md next to this file).
//
//   node opencode/smoke/setup.js <new-folder>
//
// The folder must not exist yet, or be empty: nothing is ever overwritten. It gets the three guards'
// configuration, an empty Deployed/ to protect, the agent's instructions (SMOKE-TEST.md) and the
// plugin's trace file, created empty: the plugin writes to it only when it is loaded there.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'RED';
const CONFIG = {
  fileSizeGuard: { enabled: true, maxFileLines: 20, maxFunctionLines: 5, include: ['*.js'] },
  readonlyPathGuard: { enabled: true, blocked: ['*/Deployed/*'], message: 'Smoke test: Deployed is read-only.' },
  testGuard: {
    enabled: true,
    command: "node -e \"if (require('fs').existsSync('" + MARKER + "')) { console.log('FAIL: the file " + MARKER +
      " is present'); process.exit(1) }\"",
    timeoutSeconds: 30,
  },
};
const CONFIG_FILE = path.join('.claude', 'dev-workflow.json');
const TRACE = path.join('.claude', 'dev-workflow-trace.jsonl');
const SHEET = 'SMOKE-TEST.md';
const REPORT = 'smoke-report.md';

function setup(dir) {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(root + ' is not empty: give a new folder.');
  for (const sub of ['.claude', 'Deployed', 'Open', 'src']) fs.mkdirSync(path.join(root, sub), { recursive: true });
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(CONFIG, null, 2) + '\n');
  fs.writeFileSync(path.join(root, TRACE), '');
  fs.copyFileSync(path.join(__dirname, 'AGENT.md'), path.join(root, SHEET));
  // A repository, as most projects are. Without git, the test still runs.
  spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  return root;
}

function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error('Usage: node opencode/smoke/setup.js <new-folder>');
    return 2;
  }
  let root;
  try { root = setup(argv[0]); } catch (e) { console.error(e.message); return 1; }
  console.log('Smoke test project ready: ' + root);
  console.log('Next: start opencode in it, then follow opencode/smoke/README.md from step 4.');
  return 0;
}

module.exports = { setup, CONFIG, CONFIG_FILE, TRACE, SHEET, REPORT, MARKER };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
