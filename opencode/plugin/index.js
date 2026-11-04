// dev-workflow-core for OpenCode 2.x: the same guards as in Claude Code, run by the same scripts
// (hooks/scripts/*.js), on OpenCode's tool hooks and session events. Nothing is reimplemented
// here: this file only translates OpenCode's calls into the payloads the scripts already read, and
// their exit codes into what OpenCode understands.
//
//   Claude Code (hooks/hooks.json)          OpenCode 2.x
//   PreToolUse  readonly-path-guard     ->  tool execute.before, edit|write|patch|shell; a refusal throws
//   PreToolUse  coordination-guard      ->  tool execute.before, edit|write|patch
//   PostToolUse file-size-guard         ->  tool execute.after, same tools; the message is appended
//                                           to the tool's result, which the model reads
//   Stop        stop-test-guard         ->  "session.execution.succeeded"; see stop.js
//
// Same rule as in Claude Code: without a .claude/dev-workflow.json in the project, every script
// exits 0 and the plugin does nothing.
//
// A plain object is exported on purpose: Plugin.define() from @opencode/plugin returns its argument
// unchanged, and doing without it spares the plugin any dependency to install.
// OpenCode 1.x isn't supported: its plugins use another API.

import { runHook, PLUGIN_ROOT } from './run-hook.js';
import { targetsOf, payloadsFor, appendText } from './translate.js';
import { watchStops } from './stop.js';
import { trace } from './trace.js';

// The session's directory, the one its tools resolve relative paths against. ctx.location is the
// plugin's own location, which isn't every session's: it's only the fallback.
async function directoryOf(ctx, sessionID, known) {
  try {
    const info = known || (await ctx.session.get({ sessionID }));
    const dir = info && info.location && info.location.directory;
    if (dir) return dir;
  } catch (e) { /* fall back below */ }
  return ctx.location && ctx.location.directory ? ctx.location.directory : process.cwd();
}

// Runs one script on each payload; returns the stderr of those that exited 2.
async function refusals(run, script, payloads, projectDir) {
  const out = [];
  for (const payload of payloads) {
    const r = await run(script, payload, { projectDir });
    if (r.code === 2 && r.err) out.push(r.err);
  }
  return out;
}

// What the trace keeps of a call: the files or command the guards were given, or, for a tool they
// don't cover, the names of its arguments (enough to see a write the plugin didn't translate).
function seen(event, target) {
  const base = { session: event.sessionID, tool: event.tool };
  if (!target) return Object.assign(base, { covered: false, args: Object.keys(event.input || {}) });
  return Object.assign(base, { covered: true, files: target.files, command: target.command });
}

async function beforeTool(ctx, run, event) {
  const dir = await directoryOf(ctx, event.sessionID);
  const target = targetsOf(event.tool, event.input, dir);
  let messages = [];
  if (target) {
    const payloads = payloadsFor(target, event.sessionID, 'PreToolUse');
    // Read-only first: a write it refuses must not use up the coordination guard's one warning.
    messages = await refusals(run, 'readonly-path-guard.js', payloads, dir);
    if (messages.length === 0 && target.kind === 'file') {
      messages = await refusals(run, 'coordination-guard.js', payloads, dir);
    }
  }
  trace(dir, Object.assign({ event: 'before' }, seen(event, target), { refused: messages }));
  if (messages.length) throw new Error(messages.join('\n'));
}

async function afterTool(ctx, run, event) {
  const dir = await directoryOf(ctx, event.sessionID);
  const target = event.status === 'completed' ? targetsOf(event.tool, event.input, dir) : null;
  let messages = [];
  if (target) {
    messages = await refusals(run, 'file-size-guard.js', payloadsFor(target, event.sessionID, 'PostToolUse'), dir);
    if (messages.length) event.result = appendText(event.result, messages.join('\n'));
  }
  trace(dir, Object.assign({ event: 'after', status: event.status }, seen(event, target), { appended: messages }));
}

export default {
  id: 'dev-workflow-core',
  async setup(ctx) {
    const options = (ctx && ctx.options) || {};
    const run = (script, payload, opts) => runHook(script, payload, Object.assign({ node: options.node }, opts));
    const own = ctx.location && ctx.location.directory;
    trace(own, { event: 'loaded', directory: own, root: PLUGIN_ROOT });

    await ctx.tool.hook('execute.before', (event) => beforeTool(ctx, run, event));
    // execute.after may not fail in OpenCode: an error there would be a defect, never a message.
    await ctx.tool.hook('execute.after', async (event) => {
      try { await afterTool(ctx, run, event); } catch (e) { console.warn('[dev-workflow-core] size guard: ' + (e && e.message)); }
    });

    return watchStops(ctx, {
      session: ctx.session,
      run,
      directoryOf: (sessionID, info) => directoryOf(ctx, sessionID, info),
      ownDirectory: own,
    });
  },
};
