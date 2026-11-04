'use strict';
// The OpenCode 2.x plugin (opencode/plugin/), driven through a simulated plugin context against
// the REAL hook scripts. What this can't prove: that OpenCode itself calls the hooks this way.
// That part was read in OpenCode's source (2.2.5), never observed running.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { write, project, lines, behindOrigin } = require('./helpers');

const PLUGIN = path.join(__dirname, '..', 'opencode', 'plugin');
const load = (name) => import(pathToFileURL(path.join(PLUGIN, name)).href);

// The server's event stream: every subscriber gets every event, until its signal aborts. What
// ctx.event.subscribe returns is one subscriber's async iterable.
function channel() {
  const subscribers = new Set();
  return {
    push(item) { subscribers.forEach((s) => s.push(item)); },
    iterate(signal) {
      const items = [];
      let wake = null;
      let closed = false;
      const notify = () => { if (wake) { wake(); wake = null; } };
      const sub = { push(item) { items.push(item); notify(); } };
      subscribers.add(sub);
      if (signal) signal.addEventListener('abort', () => { closed = true; subscribers.delete(sub); notify(); });
      return (async function* () {
        for (;;) {
          if (items.length) { yield items.shift(); continue; }
          if (closed) return;
          await new Promise((resolve) => { wake = resolve; });
        }
      })();
    },
  };
}

// The slice of the plugin context the plugin uses. `node` is the test's own Node: inside OpenCode
// the plugin looks for `node` on the PATH.
// opts: parentID (every session is a subagent), sessionDir (where the sessions live, else dir),
// events (a channel shared with another instance, as the server's one stream is).
function fakeContext(dir, opts) {
  const o = opts || {};
  const hooks = {};
  const prompts = [];
  const events = o.events || channel();
  const ctx = {
    location: { directory: dir },
    options: { node: process.execPath },
    tool: { hook: async (name, callback) => { hooks[name] = callback; return { dispose: async () => {} }; } },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, parentID: o.parentID, location: { directory: o.sessionDir || dir } }),
      prompt: async (input) => { prompts.push(input); return {}; },
    },
    event: { subscribe: (options) => events.iterate(options && options.signal) },
  };
  return { ctx, hooks, prompts, events };
}

async function started(dir, opts) {
  const plugin = (await load('index.js')).default;
  const fake = fakeContext(dir, opts);
  fake.cleanup = await plugin.setup(fake.ctx);
  return fake;
}

const call = (tool, input, extra) => Object.assign({ tool, input, sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_1' }, extra);

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

// A check command that prints `text`, then exits with `code` (no backslash: see stop.test.js).
const check = (text, code) => JSON.stringify(process.execPath) + ' -e "console.log(\'' + text + '\');process.exit(' + code + ')"';

// --- translate.js ----------------------------------------------------------------------------

test('a relative edit path is made absolute against the session directory', async () => {
  const { targetsOf, payloadsFor } = await load('translate.js');
  const t = targetsOf('edit', { path: 'src/a.lua', oldString: 'x', newString: 'y' }, path.resolve('/work/p'));
  assert.deepEqual(t.files, [path.resolve('/work/p', 'src/a.lua')]);
  const [p] = payloadsFor(t, 'ses_1', 'PreToolUse');
  assert.equal(p.tool_name, 'Edit');
  assert.equal(p.tool_input.file_path, path.resolve('/work/p', 'src/a.lua'));
  assert.equal(p.session_id, 'ses_1');
});

test('a patch names every file it adds, updates, moves to or deletes', async () => {
  const { patchFiles } = await load('translate.js');
  const base = path.resolve('/work/p');
  const text = ['*** Begin Patch', '*** Add File: new.ts', '+x', '*** Update File: old.ts', '*** Move to: moved.ts',
    '@@', '-a', '+b', '*** Delete File: gone.ts', '*** Update File: old.ts', '*** End Patch'].join('\n');
  assert.deepEqual(patchFiles(text, base), ['new.ts', 'old.ts', 'moved.ts', 'gone.ts'].map((f) => path.join(base, f)));
});

test('shell keeps its command and its workdir; other tools are none of the guards\' business', async () => {
  const { targetsOf } = await load('translate.js');
  const base = path.resolve('/work/p');
  const t = targetsOf('shell', { command: 'echo hi > out.txt', workdir: 'sub' }, base);
  assert.equal(t.toolName, 'Bash');
  assert.equal(t.cwd, path.join(base, 'sub'));
  assert.equal(targetsOf('read', { path: 'a.lua' }, base), null);
  assert.equal(targetsOf('edit', {}, base), null);
});

test('a message is appended to a result whatever form its content takes', async () => {
  const { appendText } = await load('translate.js');
  assert.equal(appendText({ content: 'Edited a.lua' }, 'NOTE').content, 'Edited a.lua\n\nNOTE');
  assert.deepEqual(appendText({ content: [{ type: 'text', text: 'ok' }] }, 'NOTE').content,
    [{ type: 'text', text: 'ok' }, { type: 'text', text: 'NOTE' }]);
  assert.equal(appendText({ output: { exit: 0 } }, 'NOTE').content, '{"exit":0}\n\nNOTE');
  assert.equal(appendText(undefined, 'NOTE').content, 'NOTE');
});

// --- tool hooks --------------------------------------------------------------------------------

const READONLY = { readonlyPathGuard: { enabled: true, blocked: ['*/Deployed/*'], message: 'Edit the source, then deploy.' } };

test('a write into a read-only path is refused before it runs, relative path included', async () => {
  const root = project(READONLY);
  const { hooks, cleanup } = await started(root);
  await assert.rejects(hooks['execute.before'](call('write', { path: 'Deployed/a.lua', content: 'x' })),
    /BLOCKED: '.*a\.lua' is read-only \(rule: \*\/Deployed\/\*\)[\s\S]*Edit the source, then deploy\./);
  await assert.rejects(hooks['execute.before'](call('shell', { command: 'echo x > Deployed/b.txt' })), /BLOCKED/);
  await hooks['execute.before'](call('write', { path: 'src/a.lua', content: 'x' }));
  cleanup();
});

test('a patch is refused when one of its files is read-only', async () => {
  const root = project(READONLY);
  const { hooks, cleanup } = await started(root);
  const patchText = '*** Begin Patch\n*** Add File: src/ok.lua\n+x\n*** Delete File: Deployed/old.lua\n*** End Patch';
  await assert.rejects(hooks['execute.before'](call('patch', { patchText })), /BLOCKED: '.*old\.lua'/);
  cleanup();
});

test('without a project configuration, nothing is refused and nothing is added', async () => {
  const root = project(null);
  const { hooks, cleanup } = await started(root);
  const file = write(root, 'Deployed/big.js', 'function f() {\n' + lines(200) + ';\n}\n');
  await hooks['execute.before'](call('write', { path: file, content: '' }));
  const event = call('write', { path: file }, { status: 'completed', result: { content: 'Wrote it' } });
  await hooks['execute.after'](event);
  assert.equal(event.result.content, 'Wrote it');
  cleanup();
});

test('a file written over the size limits gets the guard\'s message in its result', async () => {
  const root = project({ fileSizeGuard: { enabled: true, maxFileLines: 20, maxFunctionLines: 5, include: ['*.js'] } });
  const { hooks, cleanup } = await started(root);
  write(root, 'src/big.js', 'function big() {\n' + lines(10) + ';\n}\n');
  const event = call('edit', { path: 'src/big.js' }, { status: 'completed', result: { content: 'Edited src/big.js' } });
  await hooks['execute.after'](event);
  assert.match(event.result.content, /^Edited src\/big\.js\n\n\[size\] Over the limits/);
  assert.match(event.result.content, /big\(\): 12 lines \(max 5, \+7\)/);

  const failed = call('edit', { path: 'src/big.js' }, { status: 'error', error: { message: 'no match' } });
  await hooks['execute.after'](failed);
  assert.equal(failed.result, undefined, 'a failed call is left alone');
  cleanup();
});

test('a file changed on origin and not pulled is refused once per session', async () => {
  const alice = behindOrigin();
  const { hooks, cleanup } = await started(alice);
  const edit = (session) => hooks['execute.before'](call('edit', { path: 'src/shared.lua' }, { sessionID: session }));
  await assert.rejects(edit('ses_a'), /NOT UP TO DATE: src\/shared\.lua changed on origin\/main/);
  await edit('ses_a');
  await assert.rejects(edit('ses_b'), /NOT UP TO DATE/, 'a new session is told again');
  cleanup();
});

// --- end of turn -------------------------------------------------------------------------------

test('a failing check sends its failure back once, then lets the retried turn end', async () => {
  const { handleStop, createStopState, STOP_PREFIX } = await load('stop.js');
  const { runHook } = await load('run-hook.js');
  const root = project({ testGuard: { enabled: true, command: check('FAIL test_x', 1) } });
  const { ctx, prompts } = fakeContext(root);
  const deps = { session: ctx.session, run: (s, p, o) => runHook(s, p, Object.assign({ node: process.execPath }, o)), directoryOf: async () => root };
  const state = createStopState();

  assert.equal(await handleStop('ses_1', state, deps), 'reprompted');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionID, 'ses_1');
  assert.ok(prompts[0].text.startsWith(STOP_PREFIX));
  assert.match(prompts[0].text, /FAIL test_x[\s\S]*Fix the regression before concluding\./);

  assert.equal(await handleStop('ses_1', state, deps), 'passed', 'the retried turn may end');
  assert.equal(prompts.length, 1);
});

test('a passing check and a subagent session send nothing', async () => {
  const { handleStop, createStopState } = await load('stop.js');
  const { runHook } = await load('run-hook.js');
  const run = (s, p, o) => runHook(s, p, Object.assign({ node: process.execPath }, o));
  const green = project({ testGuard: { enabled: true, command: check('ok', 0) } });
  const a = fakeContext(green);
  assert.equal(await handleStop('ses_1', createStopState(), { session: a.ctx.session, run, directoryOf: async () => green }), 'passed');
  assert.equal(a.prompts.length, 0);

  const red = project({ testGuard: { enabled: true, command: check('FAIL', 1) } });
  const b = fakeContext(red, { parentID: 'ses_parent' });
  assert.equal(await handleStop('ses_child', createStopState(), { session: b.ctx.session, run, directoryOf: async () => red }), 'subagent');
  assert.equal(b.prompts.length, 0);
});

test('the plugin listens for the end of a turn and stops listening on cleanup', async () => {
  const root = project({ testGuard: { enabled: true, command: check('FAIL wired', 1) } });
  const { events, prompts, cleanup } = await started(root);
  events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_9' } });
  assert.ok(await waitFor(() => prompts.length === 1, 15000), 'the failure came back as a prompt');
  assert.equal(prompts[0].sessionID, 'ses_9');
  assert.match(prompts[0].text, /FAIL wired/);
  cleanup();
});

test('with two projects loaded, only the session\'s own location sends the failure back', async () => {
  const mine = project({ testGuard: { enabled: true, command: check('FAIL here', 1) } });
  const other = project({ testGuard: { enabled: true, command: check('FAIL there', 1) } });
  const events = channel();
  const a = await started(mine, { events, sessionDir: mine });
  const b = await started(other, { events, sessionDir: mine });
  events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
  assert.ok(await waitFor(() => a.prompts.length === 1, 15000));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.prompts.length, 0, 'the other location stays quiet');
  assert.equal(a.prompts.length, 1);
  a.cleanup();
  b.cleanup();
});

test('a retried turn that is interrupted doesn\'t exempt the next one', async () => {
  const root = project({ testGuard: { enabled: true, command: check('FAIL again', 1) } });
  const { events, prompts, cleanup } = await started(root);
  events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
  assert.ok(await waitFor(() => prompts.length === 1, 15000));
  events.push({ type: 'session.execution.interrupted', data: { sessionID: 'ses_1', reason: 'user' } });
  events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
  assert.ok(await waitFor(() => prompts.length === 2, 15000), 'checked again, not waved through');
  cleanup();
});
