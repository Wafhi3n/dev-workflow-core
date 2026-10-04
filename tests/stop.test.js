'use strict';
// testGuard: the project's checks at the end of a turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { write, project, hook } = require('./helpers');

const STOP = { session_id: 'test', stop_hook_active: false };
const stop = (root) => hook('stop-test-guard.js', STOP, root);

// A check command that prints each of `texts` on its own line, then exits with `code`. No backslash
// anywhere: cmd.exe would hand it to node as is, where sh would unescape it.
function node(texts, code) {
  const js = [].concat(texts).map((t) => "console.log('" + t + "');").join('') + 'process.exit(' + code + ')';
  return JSON.stringify(process.execPath) + ' -e "' + js + '"';
}

test('no testGuard section: nothing runs', () => {
  const root = project({ fileSizeGuard: { enabled: true } });
  assert.equal(stop(root).code, 0);
});

test('a passing check lets the turn end', () => {
  const root = project({ testGuard: { enabled: true, command: node('all good', 0) } });
  const r = stop(root);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
});

test('a failing check stops the turn and shows its output', () => {
  const root = project({ testGuard: { enabled: true, command: node('FAIL test_x', 1) } });
  const r = stop(root);
  assert.equal(r.code, 2);
  assert.match(r.err, /\[tests\] ".*" failed \(code 1\):/);
  assert.match(r.err, /FAIL test_x/);
  assert.match(r.err, /Fix the regression before concluding\./);
});

test('a turn restarted by the Stop hook is never blocked again', () => {
  const root = project({ testGuard: { enabled: true, command: node('FAIL', 1) } });
  assert.equal(hook('stop-test-guard.js', Object.assign({}, STOP, { stop_hook_active: true }), root).code, 0);
});

test('recorded failures are debt; a new one blocks and is the only one quoted', () => {
  const check = { name: 'lint', failurePattern: '\\[ERROR\\]', baseline: '.claude/lint.json' };
  const root = project({ testGuard: { enabled: true, checks: [Object.assign({ command: node('[ERROR] old', 1) }, check)] } });
  write(root, '.claude/lint.json', JSON.stringify(['[ERROR] old']));
  assert.equal(stop(root).code, 0);

  write(root, '.claude/dev-workflow.json', JSON.stringify({ testGuard: { enabled: true, checks: [Object.assign({ command: node(['[ERROR] old', '[ERROR] new'], 1) }, check)] } }));
  const r = stop(root);
  assert.equal(r.code, 2);
  // The header line quotes the command, which holds both texts: only the quoted failure lines count.
  assert.match(r.err, /^ {2}\[ERROR\] new$/m);
  assert.doesNotMatch(r.err, /^ {2}\[ERROR\] old$/m);
});

test('a failure the pattern cannot read blocks, it is not debt', () => {
  const root = project({ testGuard: { enabled: true, checks: [{ name: 'lint', command: node('tool crashed', 1), failurePattern: '\\[ERROR\\]', baseline: '.claude/lint.json' }] } });
  write(root, '.claude/lint.json', JSON.stringify(['[ERROR] old']));
  const r = stop(root);
  assert.equal(r.code, 2);
  assert.match(r.err, /tool crashed/);
});

test('runOnlyIfChanged: a green check reruns only when a watched file changed', () => {
  const cfg = (command) => ({ testGuard: { enabled: true, command, runOnlyIfChanged: ['*.lua'] } });
  const root = project(cfg(node('ok', 0)));
  const src = write(root, 'src/a.lua', 'x = 1\n');
  assert.equal(stop(root).code, 0);

  // The suite would now fail, but nothing it watches moved since its green run.
  write(root, '.claude/dev-workflow.json', JSON.stringify(cfg(node('FAIL', 1))));
  write(root, 'README.md', 'docs only\n');
  assert.equal(stop(root).code, 0);

  const later = new Date(Date.now() + 5000);
  fs.utimesSync(src, later, later);
  assert.equal(stop(root).code, 2);
});

test('a command the shell reports as not found warns without blocking', { skip: process.platform === 'win32' ? 'cmd.exe returns 1 for an unknown command, like a failing suite: that case blocks by design' : false }, () => {
  const root = project({ testGuard: { enabled: true, command: 'this-command-does-not-exist-dwc' } });
  const r = stop(root);
  assert.equal(r.code, 0);
  assert.match(r.err, /Couldn't run "this-command-does-not-exist-dwc"/);
});

test('the state of each check is kept in .claude/dev-workflow.teststate.json', () => {
  const root = project({ testGuard: { enabled: true, command: node('ok', 0) } });
  stop(root);
  const state = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'dev-workflow.teststate.json'), 'utf8'));
  assert.equal(state.checks.tests.lastOk, true);
});
