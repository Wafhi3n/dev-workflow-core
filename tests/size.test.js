'use strict';
// fileSizeGuard, its analyzers and its baseline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, write, project, hook, findLua, findPython, lines } = require('./helpers');
const baseline = require('../hooks/scripts/baseline');

const LUA = findLua();
const PYTHON = findPython();
// With WOW_REQUIRE_LUA (CI), a missing Lua fails the run instead of skipping it: a silent skip
// would leave check_size.lua untested with a green result.
const needsLua = LUA || process.env.WOW_REQUIRE_LUA ? {} : { skip: 'no Lua 5.1: set CLAUDE_LUA_EXE, or WOW_ELUNE_DIR to an unzipped Elune' };
const needsPython = PYTHON ? {} : { skip: 'no Python 3 on the PATH' };

const LIMITS = { enabled: true, maxFileLines: 20, maxFunctionLines: 5, include: ['*.js', '*.lua', '*.py', '*.txt'] };
const BIG_JS = 'function big() {\n' + lines(10) + ';\n}\n';
const BIG_LUA = 'local function big()\n' + lines(10) + '\nend\n';
const edit = (file, root) => ({ tool_input: { file_path: file }, cwd: root });

test('no configuration: the size guard says nothing', () => {
  const root = project(null);
  const file = write(root, 'big.js', BIG_JS + '// pad\n'.repeat(40));
  const r = hook('file-size-guard.js', edit(file, root), root);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
});

test('a JS function over the limit is reported, with its line and length', () => {
  const root = project({ fileSizeGuard: LIMITS });
  const file = write(root, 'src/big.js', BIG_JS);
  const r = hook('file-size-guard.js', edit(file, root), root);
  assert.equal(r.code, 2);
  assert.match(r.err, /\[FUNCTION\] big\.js:1 {2}big\(\): 12 lines \(max 5, \+7\)/);
});

test('a file under the limits passes', () => {
  const root = project({ fileSizeGuard: LIMITS });
  const file = write(root, 'src/small.js', 'function s() {\n  return 1;\n}\n');
  assert.equal(hook('file-size-guard.js', edit(file, root), root).code, 0);
});

test('a language without an analyzer is measured at the file level', () => {
  const root = project({ fileSizeGuard: LIMITS });
  const file = write(root, 'notes.txt', 'line\n'.repeat(30));
  const r = hook('file-size-guard.js', edit(file, root), root);
  assert.equal(r.code, 2);
  assert.match(r.err, /\[FILE\] notes\.txt: 30 lines \(max 20, \+10\)/);
});

test('a write made through Bash is found by its fresh mtime', () => {
  const root = project({ fileSizeGuard: LIMITS });
  write(root, 'src/big.js', BIG_JS);
  const r = hook('file-size-guard.js', { tool_input: { command: "sed -i 's/a/b/' src/big.js" }, cwd: root }, root);
  assert.equal(r.code, 2);
  assert.match(r.err, /big\.js:1/);
});

test('excluded paths are never measured', () => {
  const root = project({ fileSizeGuard: Object.assign({}, LIMITS, { exclude: ['*/Libs/*'] }) });
  const file = write(root, 'Libs/big.js', BIG_JS);
  assert.equal(hook('file-size-guard.js', edit(file, root), root).code, 0);
});

test('an override raises the file limit for the files it matches', () => {
  const root = project({ fileSizeGuard: Object.assign({}, LIMITS, { overrides: { '*/registry.txt': 100 } }) });
  const file = write(root, 'registry.txt', 'line\n'.repeat(30));
  assert.equal(hook('file-size-guard.js', edit(file, root), root).code, 0);
});

test('a baseline written by 1.x (French keys) still silences the recorded debt', () => {
  const root = project({ fileSizeGuard: Object.assign({}, LIMITS, { baseline: '.claude/baseline.json' }) });
  const file = write(root, 'src/big.js', BIG_JS + '// pad\n'.repeat(20));
  write(root, '.claude/baseline.json', JSON.stringify({ 'src/big.js': { '[FICHIER]': 32, '[FONCTION] big': 12 } }));
  assert.equal(hook('file-size-guard.js', edit(file, root), root).code, 0);

  write(root, 'src/big.js', 'function big() {\n' + lines(14) + ';\n}\n' + '// pad\n'.repeat(20));
  const worse = hook('file-size-guard.js', edit(file, root), root);
  assert.equal(worse.code, 2);
  assert.match(worse.err, /big\(\): 16 lines/);
  assert.match(worse.err, /\[FILE\] big\.js: 36 lines/, '36 lines is worse than the 32 recorded');
});

test('a Lua function over the limit is measured by check_size.lua', needsLua, () => {
  assert.ok(LUA, 'WOW_REQUIRE_LUA is set but no Lua 5.1 was found (CLAUDE_LUA_EXE, WOW_ELUNE_DIR)');
  const root = project({ fileSizeGuard: LIMITS });
  const file = write(root, 'Addon/Core.lua', BIG_LUA);
  const r = hook('file-size-guard.js', edit(file, root), root, Object.assign({ CLAUDE_LUA_EXE: LUA.exe }, LUA.env));
  assert.equal(r.code, 2);
  assert.match(r.err, /\[FUNCTION\] Core\.lua:1 {2}big\(\): 12 lines \(max 5, \+7\)/);
});

test('without any Lua, a .lua file falls back to the file level instead of breaking', () => {
  const root = project({ fileSizeGuard: LIMITS });
  const file = write(root, 'Addon/Core.lua', BIG_LUA);
  // Only node's own folder on the PATH: no lua, lua5.1 or luajit to find.
  const r = hook('file-size-guard.js', edit(file, root), root, { PATH: path.dirname(process.execPath), CLAUDE_LUA_EXE: path.join(root, 'no-lua') });
  assert.equal(r.code, 0, 'a 12-line file is under the 20-line file limit, and functions are not measured');
});

test('a Python function over the limit is measured by check_size.py', needsPython, () => {
  const root = project({ fileSizeGuard: LIMITS });
  const file = write(root, 'tool/big.py', 'def big():\n' + lines(10, '    ') + '\n');
  const r = hook('file-size-guard.js', edit(file, root), root, PYTHON);
  assert.equal(r.code, 2);
  assert.match(r.err, /\[FUNCTION\] big\.py:1 {2}big\(\): 11 lines \(max 5, \+6\)/);
});

test('braces.js --porcelain: CONTRACT first, one record per finding, exit 1', () => {
  const root = project(null);
  const js = write(root, 'big.js', BIG_JS);
  const txt = write(root, 'notes.txt', 'x\n');
  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'analyzers', 'braces.js'), '--porcelain', '20', '5', js, txt], { encoding: 'utf8' });
  const out = run.stdout.trim().split(/\r?\n/);
  assert.equal(run.status, 1);
  assert.equal(out[0], 'CONTRACT\tbraces\t2');
  assert.equal(out[1], ['FUNCTION', js, 1, 'big', 12, 5].join('\t'));
  assert.equal(out[2], 'UNKNOWN-DIALECT\t' + txt);
});

test('braces.js with bad arguments exits 2, never 0', () => {
  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'analyzers', 'braces.js'), '--porcelain', 'x'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

test('baseline: old and new line formats give the same key', () => {
  assert.deepEqual(baseline.parseViolation('[FUNCTION] a.lua:42  foo(): 95 lines (max 60, +35)'), { key: '[FUNCTION] foo', count: 95 });
  assert.deepEqual(baseline.parseViolation('[FONCTION] a.lua:42  foo() : 95 lignes (max 60, +35)'), { key: '[FUNCTION] foo', count: 95 });
  assert.deepEqual(baseline.parseViolation('[FICHIER] a.lua : 812 lignes (max 500, +312)'), { key: '[FILE]', count: 812 });
  assert.equal(baseline.parseViolation('=> 2 over the limit.'), null);
});

test('baseline: a 1.x file is read with the current keys', () => {
  const root = project(null);
  const file = write(root, 'b.json', '﻿' + JSON.stringify({ 'a.lua': { '[FICHIER]': 600, '[FONCTION] foo': 70 } }));
  assert.deepEqual(baseline.load(file), { 'a.lua': { '[FILE]': 600, '[FUNCTION] foo': 70 } });
  assert.equal(baseline.load(path.join(root, 'missing.json')), null);
  fs.rmSync(root, { recursive: true, force: true });
});
