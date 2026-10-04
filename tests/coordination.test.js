'use strict';
// coordinationGuard: a file changed on origin and not pulled, against two real clones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { write, hook } = require('./helpers');

// GIT_AUTHOR_* and GIT_COMMITTER_* override each clone's user.name (CI sets them to "ci"), and the
// hook's message names the author: they're left out so Bob's commit is really Bob's.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
}

// Alice's clone, behind origin by one commit of Bob's on src/shared.lua.
function behindOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwc-coord-'));
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', origin);
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const alice = path.join(base, 'alice');
  const bob = path.join(base, 'bob');
  git(base, 'clone', '-q', origin, alice);
  git(alice, 'checkout', '-q', '-b', 'main');
  for (const [repo, name] of [[alice, 'Alice']]) {
    git(repo, 'config', 'user.name', name);
    git(repo, 'config', 'user.email', name.toLowerCase() + '@example.com');
  }
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
