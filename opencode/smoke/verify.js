'use strict';
// verify.js: the verdict of the OpenCode smoke test (see README.md next to this file).
//
//   node opencode/smoke/verify.js <test-folder>
//
// It reads the plugin's trace and the project's files, never what the model says it saw: a file
// that isn't there proves nothing on its own (the guard refused it, a permission prompt was denied,
// or the call was never made), so every refusal must also be in the trace.
// Exit code: 0 when every check passes, 1 otherwise, 2 on bad arguments.

const fs = require('fs');
const path = require('path');
const { CONFIG, CONFIG_FILE, TRACE, REPORT } = require('./setup');

function readTrace(root) {
  const file = path.join(root, TRACE);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
const names = (e, rel) => (e.files || []).some((f) => norm(f).endsWith('/' + rel.toLowerCase()));
const fileCalls = (trace, kind, rel) => trace.filter((e) => e.event === kind && e.covered && names(e, rel));
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const result = (ok, text) => ({ ok, text });

function control(root, trace) {
  const seen = fileCalls(trace, 'before', 'Open/a.txt').filter((e) => !e.refused.length);
  if (seen.length && exists(root, 'Open/a.txt')) return result(true, 'control: Open/a.txt written through "' + seen[0].tool + '", seen by the plugin');
  if (exists(root, 'Open/a.txt')) return result(false, 'control: Open/a.txt was written by a tool the plugin doesn\'t cover (see "tools seen")');
  return result(false, 'control: Open/a.txt was never written, so the refusals below can\'t be told from a broken tool');
}

function refusal(root, trace, rel, isCall, label) {
  const calls = trace.filter((e) => e.event === 'before' && e.covered && isCall(e));
  const refused = calls.find((e) => e.refused.some((m) => /BLOCKED/.test(m) && m.includes(CONFIG.readonlyPathGuard.message)));
  if (exists(root, rel)) return result(false, label + ': ' + rel + ' was written' + (calls.length ? ' although the plugin saw the call' : ', and the plugin never saw a covered call'));
  if (refused) return result(true, label + ': refused through "' + refused.tool + '", with the project\'s message');
  if (calls.length) return result(false, label + ': the plugin saw the call but didn\'t refuse it, and ' + rel + ' is missing anyway');
  return result(false, label + ': ' + rel + ' is missing, but no refusal is in the trace (call never made, or a permission prompt denied)');
}

function size(root, trace) {
  const after = fileCalls(trace, 'after', 'src/big.js');
  const flagged = after.find((e) => e.appended.some((m) => /\[size\]/.test(m)));
  if (flagged) return result(true, 'size: the [size] message was appended to the result of "' + flagged.tool + '"');
  if (!exists(root, 'src/big.js')) return result(false, 'size: src/big.js was never written');
  if (!after.length) return result(false, 'size: src/big.js was written, but no completed covered call is in the trace');
  return result(false, 'size: the call was seen, but nothing was appended to its result');
}

function stops(trace) {
  const checks = trace.filter((e) => e.event === 'stop-check');
  const first = checks.findIndex((e) => e.reprompt);
  const before = first < 0 ? checks : checks.slice(0, first);
  const out = [];
  const green = before.find((e) => !e.active && e.code === 0);
  out.push(green ? result(true, 'end of part 1: checked, passed, nothing sent')
    : result(false, 'end of part 1: ' + (checks.length ? 'no passing check before RED (codes: ' + before.map((e) => e.code).join(', ') + ')'
      : 'no end-of-turn check at all (' + trace.filter((e) => /^session\.execution/.test(e.event)).length + ' end-of-turn events seen)')));
  const reprompts = checks.filter((e) => e.reprompt).length;
  out.push(reprompts === 1 ? result(true, 'end of part 2: RED failed the check, and the failure was sent back once')
    : result(false, 'end of part 2: the failure was sent back ' + reprompts + ' times (expected 1)'));
  const retried = first >= 0 && checks.slice(first + 1).some((e) => e.active);
  out.push(retried ? result(true, 'retried turn: it ended without a second message (anti-loop)')
    : result(false, 'retried turn: no check of the turn started by the automatic message (it never ended, or verify ran too early)'));
  return out;
}

function configKept(root) {
  let now = null;
  try { now = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')); } catch (e) { /* below */ }
  const ok = JSON.stringify(now) === JSON.stringify(CONFIG);
  return result(ok, ok ? 'configuration untouched' : 'the configuration was changed or removed: the run doesn\'t count');
}

function verify(dir) {
  const root = path.resolve(dir);
  const trace = readTrace(root);
  if (trace === null) return { ok: false, checks: [result(false, 'no trace file: run setup.js on this folder first')], info: [] };
  const loaded = trace.find((e) => e.event === 'loaded');
  if (!loaded) return { ok: false, checks: [result(false, 'the plugin never loaded in ' + root + ': is plugins/dev-workflow-core.js installed, and did OpenCode start in this folder?')], info: [] };
  const checks = [result(true, 'plugin loaded, from ' + loaded.root), control(root, trace),
    refusal(root, trace, 'Deployed/a.txt', (e) => names(e, 'Deployed/a.txt'), 'write into Deployed'),
    refusal(root, trace, 'Deployed/b.txt', (e) => e.command !== undefined && norm(e.command).includes('deployed/b.txt'), 'shell into Deployed'),
    size(root, trace)].concat(stops(trace), [configKept(root)]);
  const tools = new Map();
  trace.filter((e) => e.event === 'before').forEach((e) => tools.set(e.tool, e.covered ? 'covered' : 'not covered, args: ' + e.args.join(', ')));
  const info = ['tools seen: ' + (Array.from(tools, ([t, c]) => t + ' (' + c + ')').join('; ') || 'none'),
    'the agent\'s report: ' + (exists(root, REPORT) ? path.join(root, REPORT) : 'not written')];
  return { ok: checks.every((c) => c.ok), checks, info };
}

function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error('Usage: node opencode/smoke/verify.js <test-folder>');
    return 2;
  }
  const r = verify(argv[0]);
  r.checks.forEach((c) => console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.text));
  r.info.forEach((i) => console.log('INFO  ' + i));
  console.log(r.ok ? 'All checks passed.' : 'Some checks failed.');
  return r.ok ? 0 : 1;
}

module.exports = { verify, readTrace };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
