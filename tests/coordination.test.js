'use strict';
// coordinationGuard: a file changed on origin and not pulled, against two real clones.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { write, hook, behindOrigin } = require('./helpers');

const edit = (root, rel, session) => hook('coordination-guard.js', { session_id: session || 's1', tool_input: { file_path: path.join(root, rel) }, cwd: root }, root);

test('editing a file that changed on origin is blocked once, then let through', () => {
  const alice = behindOrigin();
  const first = edit(alice, 'src/shared.lua');
  assert.equal(first.code, 2);
  assert.match(first.err, /NOT UP TO DATE: src\/shared\.lua changed on origin\/main/);
  assert.match(first.err, /Bob, .* "bob changes shared"/);
  assert.equal(edit(alice, 'src/shared.lua').code, 0);
  assert.equal(edit(alice, 'src/shared.lua', 's2').code, 2, 'a new session is told again');
});

test('a file nobody changed on origin goes through', () => {
  const alice = behindOrigin();
  assert.equal(edit(alice, 'src/other.lua').code, 0);
});

test('without a coordinationGuard section, nothing is checked', () => {
  const alice = behindOrigin();
  write(alice, '.claude/dev-workflow.json', JSON.stringify({ fileSizeGuard: { enabled: true } }));
  assert.equal(edit(alice, 'src/shared.lua').code, 0);
});
