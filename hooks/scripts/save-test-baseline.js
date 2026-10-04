// save-test-baseline.js: records the current failures of a testGuard check.
//
//   node save-test-baseline.js <project-root> <check-name>
//
// Runs the check's command, keeps the lines that match its failurePattern, and writes them to the
// file its "baseline" key names. From then on, only a NEW line blocks.
//
// Run it again after fixing errors, so the debt paid off can't come back silently.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.argv[2];
const wanted = process.argv[3];

if (!root || !wanted) {
  console.error('usage: node save-test-baseline.js <project-root> <check-name>');
  process.exit(2);
}

const cfgPath = path.join(root, '.claude', 'dev-workflow.json');
let cfg;
try {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
} catch (e) {
  console.error('Unreadable configuration: ' + cfgPath);
  process.exit(2);
}

const checks = (cfg.testGuard && cfg.testGuard.checks) || [];
const check = checks.find((c) => c && c.name === wanted);
if (!check) {
  console.error('No check named "' + wanted + '". Available: ' + checks.map((c) => c.name).join(', '));
  process.exit(2);
}
if (!check.failurePattern || !check.baseline) {
  console.error('This check has no failurePattern and baseline: nothing to record.');
  process.exit(2);
}

console.log('Running "' + check.command + '"...');
const run = spawnSync(String(check.command), {
  shell: true, cwd: root, encoding: 'utf8',
  timeout: (Number(check.timeoutSeconds) || 300) * 1000,
});

if (run.error) {
  console.error('Couldn\'t run it: ' + run.error.message);
  process.exit(2);
}

const output = ((run.stdout || '') + '\n' + (run.stderr || '')).trim();
const re = new RegExp(check.failurePattern);
const lines = Array.from(new Set(
  output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && re.test(l))
));

const dest = path.resolve(root, check.baseline);
fs.writeFileSync(dest, JSON.stringify(lines, null, 2), 'utf8');

console.log('  exit code: ' + run.status);
console.log('  ' + lines.length + ' failure(s) recorded in ' + path.relative(root, dest).replace(/\\/g, '/'));
if (lines.length === 0) console.log('  (nothing to record: the check is green)');
