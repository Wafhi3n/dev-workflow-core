'use strict';
// The OpenCode smoke test's own tooling (opencode/smoke/): setup.js builds the project, and
// verify.js must pass a good run and refuse to call a missing file a refusal. The run is played
// here against the simulated context, the way a model following AGENT.md would make it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { write } = require('./helpers');
const { started, call, waitFor } = require('./opencode-harness');
const { setup, CONFIG, CONFIG_FILE, TRACE, SHEET } = require('../opencode/smoke/setup');
const { verify, readTrace } = require('../opencode/smoke/verify');

const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dwc-smoke-')), 'project');
const BIG = ['function big() {', '  let x = 0;'].concat([1, 2, 3, 4, 5, 6, 7, 8].map((n) => '  x = ' + n + ';'), ['  return x;', '}', '']).join('\n');

test('setup builds the project once, and never into a folder that has something in it', () => {
  const root = setup(fresh());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')), CONFIG);
  assert.equal(fs.readFileSync(path.join(root, TRACE), 'utf8'), '', 'the trace starts empty');
  assert.ok(fs.existsSync(path.join(root, SHEET)));
  assert.ok(fs.statSync(path.join(root, 'Deployed')).isDirectory());
  assert.throws(() => setup(root), /is not empty/);
});

test('a trace with nothing in it means the plugin never loaded there', () => {
  const r = verify(setup(fresh()));
  assert.equal(r.ok, false);
  assert.match(r.checks[0].text, /never loaded/);
});

// Part 1 and part 2 of AGENT.md, as OpenCode would hand them to the plugin.
async function playRun(root) {
  const { hooks, events, prompts, cleanup } = await started(root);
  const writeTool = async (rel, content) => {
    await hooks['execute.before'](call('write', { path: rel, content }));
    write(root, rel, content);
    const done = call('write', { path: rel, content }, { status: 'completed', result: { content: 'Wrote file successfully.' } });
    await hooks['execute.after'](done);
    return done;
  };
  const stopChecks = () => readTrace(root).filter((e) => e.event === 'stop-check').length;
  const endTurn = async (count) => {
    events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    assert.ok(await waitFor(() => stopChecks() === count, 15000), 'end-of-turn check ' + count + ' ran');
  };

  await writeTool('Open/a.txt', 'hello');
  await assert.rejects(hooks['execute.before'](call('write', { path: 'Deployed/a.txt', content: 'hello' })), /BLOCKED/);
  await assert.rejects(hooks['execute.before'](call('shell', { command: 'echo x > Deployed/b.txt' })), /BLOCKED/);
  assert.match((await writeTool('src/big.js', BIG)).result.content, /\[size\]/);
  await hooks['execute.before'](call('read', { filePath: 'SMOKE-TEST.md' }));
  await endTurn(1);
  write(root, 'RED', 'red');
  await endTurn(2);
  assert.equal(prompts.length, 1);
  await endTurn(3);
  cleanup();
}

test('verify passes a good run, judged from the trace and the files', async () => {
  const root = setup(fresh());
  await playRun(root);
  const r = verify(root);
  assert.ok(r.ok, r.checks.filter((c) => !c.ok).map((c) => c.text).join('\n'));
  assert.equal(r.checks.length, 9, 'one per row of opencode/smoke/README.md');
  assert.match(r.info[0], /read \(not covered, args: filePath\)/);
});

test('another session, or a message sent after the retried turn, doesn\'t change the verdict', async () => {
  const root = setup(fresh());
  await playRun(root);
  const line = (e) => fs.appendFileSync(path.join(root, TRACE), JSON.stringify(Object.assign({ event: 'stop-check' }, e)) + '\n');
  line({ session: 'ses_2', active: false, code: 2, reprompt: true });
  line({ session: 'ses_1', active: false, code: 2, reprompt: true });
  const r = verify(root);
  assert.ok(r.ok, r.checks.filter((c) => !c.ok).map((c) => c.text).join('\n'));
  assert.match(r.info[2], /session judged: ses_1; other sessions left out: ses_2/);
});

test('a file that is missing without a refusal in the trace is not a pass', async () => {
  const root = setup(fresh());
  await playRun(root);
  const file = path.join(root, TRACE);
  const kept = readTrace(root).filter((e) => !(e.event === 'before' && e.refused && e.refused.length && e.files));
  fs.writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = verify(root);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && /Deployed\/a\.txt is missing, but no refusal is in the trace/.test(c.text)));
  assert.ok(r.checks.some((c) => c.ok && /shell into Deployed/.test(c.text)), 'the shell refusal still stands');
});

test('a run where the configuration was changed doesn\'t count', async () => {
  const root = setup(fresh());
  await playRun(root);
  const cfg = Object.assign({}, CONFIG, { readonlyPathGuard: { enabled: false } });
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(cfg));
  const r = verify(root);
  assert.equal(r.ok, false);
  assert.match(r.checks[r.checks.length - 1].text, /configuration was changed/);
});
