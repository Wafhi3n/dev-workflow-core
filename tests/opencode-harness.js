'use strict';
// A simulated OpenCode 2.x plugin context, shared by the tests of opencode/plugin/ and of the smoke
// test (opencode/smoke/). It holds the slice of the context the plugin uses, nothing more.
const path = require('path');
const { pathToFileURL } = require('url');

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

// `node` is the test's own Node: inside OpenCode the plugin looks for `node` on the PATH.
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

module.exports = { load, channel, fakeContext, started, call, waitFor, check };
