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
// and stop-test-guard.js lets it end whatever happens. One retry, never an endless loop.
//
// Subagent sessions (a parentID) are skipped: Claude Code doesn't run Stop for a subagent either.

const EVENT = 'session.execution.succeeded';
export const STOP_PREFIX = "[dev-workflow-core] The project's checks failed after your last turn:\n";

export function createStopState() {
  return { retried: new Set(), running: new Set() };
}

// One end of turn. `deps`: { session (the plugin context's), run (script, payload, opts) => result,
// directoryOf (sessionID) => directory }. Resolves to what happened, for the tests.
export async function handleStop(sessionID, state, deps) {
  if (!sessionID || state.running.has(sessionID)) return 'busy';
  let info = null;
  try { info = await deps.session.get({ sessionID }); } catch (e) { /* unknown: treated as a root session */ }
  if (info && info.parentID) return 'subagent';

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
    for await (const event of ctx.event.subscribe({ types: [EVENT], signal: controller.signal })) {
      const id = event && event.data && event.data.sessionID;
      if (id) handleStop(id, state, deps).catch((e) => console.warn('[dev-workflow-core] Stop guard: ' + (e && e.message)));
    }
  })().catch((e) => {
    if (!controller.signal.aborted) console.warn('[dev-workflow-core] Stop guard stopped listening: ' + (e && e.message));
  });
  return () => controller.abort();
}
