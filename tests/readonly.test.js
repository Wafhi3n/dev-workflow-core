'use strict';
// readonlyPathGuard: explicit paths, and the write constructs it reads in a command line.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { project, hook } = require('./helpers');

const CFG = { readonlyPathGuard: { enabled: true, blocked: ['*/Deployed/*'], message: 'Edit the source, then deploy.' } };

function setup() {
  const root = project(CFG);
  const command = (cmd) => hook('readonly-path-guard.js', { tool_input: { command: cmd }, cwd: root }, root);
  const edit = (rel) => hook('readonly-path-guard.js', { tool_input: { file_path: path.join(root, rel) }, cwd: root }, root);
  return { root, command, edit };
}

test('no configuration: nothing is blocked', () => {
  const root = project(null);
  const r = hook('readonly-path-guard.js', { tool_input: { file_path: path.join(root, 'Deployed', 'a.lua') }, cwd: root }, root);
  assert.equal(r.code, 0);
});

test('an Edit into a read-only path is blocked, with the project message', () => {
  const r = setup().edit('Deployed/a.lua');
  assert.equal(r.code, 2);
  assert.match(r.err, /BLOCKED: '.*a\.lua' is read-only \(rule: \*\/Deployed\/\*\)/);
  assert.match(r.err, /Edit the source, then deploy\./);
});

test('an Edit anywhere else goes through', () => {
  assert.equal(setup().edit('src/a.lua').code, 0);
});

test('unambiguous shell writes into a read-only path are blocked', () => {
  const { command } = setup();
  for (const cmd of [
    'echo x > Deployed/a.lua',
    'echo x >> "Deployed/a.lua"',
    "sed -i 's/a/b/' Deployed/a.lua",
    'cat a | tee Deployed/a.lua',
    'cp src/a.lua Deployed/a.lua',
    'rm -f Deployed/a.lua',
    'Set-Content -Path Deployed/a.lua -Value x',
  ]) {
    assert.equal(command(cmd).code, 2, cmd);
  }
});

test('reading from a read-only path is not a write', () => {
  const { command } = setup();
  assert.equal(command('cp Deployed/a.lua src/a.lua').code, 0);
  assert.equal(command('cat Deployed/a.lua > src/copy.lua').code, 0);
});

test('a write hidden in an interpreter warns without blocking', () => {
  const r = setup().command("python - <<PY\nopen('Deployed/a.lua', 'w')\nPY");
  assert.equal(r.code, 0);
  assert.match(r.err, /Warning: 'Deployed\/a\.lua' is read-only/);
});
