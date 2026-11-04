// stop.js: the Stop hook (the project's checks at the end of a turn) on OpenCode 2.x.
//
// OpenCode has no event that can keep a turn from ending. The closest one is
// "session.execution.succeeded", sent once the turn HAS ended without error or interruption (a
// "session.status" idle also follows a failure or an interrupt, where Claude Code runs no Stop
// hook). So the guard can't block the conclusion: when a check fails, it sends the failure back
// as a new prompt in the same session, and the model has to fix it. Same outcome as Claude Code's
// exit 2 on Stop, one message later.
//
// The anti-loop is Claude Code's: the turn started by that prompt is flagged (stop_hook_active),
// and stop-test-guard.js lets it end whatever happens. One retry, never an endless loop. When that
// retried turn fails or is interrupted instead, the flag goes, so the next turn is checked again.
//
// Skipped: subagent sessions (a parentID), as Claude Code doesn't run Stop for a subagent either;
// and sessions of another location. OpenCode loads one instance of the plugin per location, while
// the event stream is the whole server's: without that filter, every loaded project would run
// the checks and send its own copy of the failure.

import path from 'node:path';

const ENDED = 'session.execution.succeeded';
const CANCELLED = ['session.execution.failed', 'session.execution.interrupted'];
export const STOP_PREFIX = "[dev-workflow-core] The project's checks failed after your last turn:\n";

export function createStopState() {
  return { retried: new Set(), running: new Set() };
}

function sameDirectory(a, b) {
  const norm = (p) => {
    const r = path.resolve(String(p));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// One end of turn. `deps`: { session (the plugin context's), run (script, payload, opts) => result,
// directoryOf (sessionID, info) => directory, ownDirectory (this instance's location) }.
// Resolves to what happened, for the tests.
export async function handleStop(sessionID, state, deps) {
  if (!sessionID || state.running.has(sessionID)) return 'busy';
  let info = null;
  try { info = await deps.session.get({ sessionID }); } catch (e) { /* below */ }
  // A session this instance can't read is skipped, rather than checked by every loaded instance.
  if (!info) return 'unknown';
  if (info.parentID) return 'subagent';
  const where = info.location && info.location.directory;
  if (deps.ownDirectory && where && !sameDirectory(where, deps.ownDirectory)) return 'elsewhere';

  const active = state.retried.delete(sessionID);
  state.running.add(sessionID);
  try {
    const dir = await deps.directoryOf(sessionID, info);
    const payload = { session_id: sessionID, hook_event_name: 'Stop', stop_hook_active: active, cwd: dir };
    const r = await deps.run('stop-test-guard.js', payload, { projectDir: dir });
    if (r.code !== 2 || active) return 'passed';
    state.retried.add(sessionID);
    await deps.session.prompt({ sessionID, text: STOP_PREFIX + r.err });
    return 'reprompted';
  } finally {
    state.running.delete(sessionID);
  }
}

// Listens for ends of turn until the returned function is called (the plugin's cleanup).
export function watchStops(ctx, deps) {
  const controller = new AbortController();
  const state = createStopState();
  (async () => {
    const types = [ENDED].concat(CANCELLED);
    for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
      const id = event && event.data && event.data.sessionID;
      if (!id) continue;
      if (event.type !== ENDED) { state.retried.delete(id); continue; }
      handleStop(id, state, deps).catch((e) => console.warn('[dev-workflow-core] Stop guard: ' + (e && e.message)));
    }
  })().catch((e) => {
    if (!controller.signal.aborted) console.warn('[dev-workflow-core] Stop guard stopped listening: ' + (e && e.message));
  });
  return () => controller.abort();
}
