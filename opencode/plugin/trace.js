// trace.js: an opt-in log of what the plugin saw and decided, for finding out why a guard didn't
// fire: was the plugin loaded, which tool names did OpenCode send, what did each script answer.
//
// It's on in a project once <project>/.claude/dev-workflow-trace.jsonl exists: create the file
// empty, and the plugin appends one JSON line per event. Delete it to turn the trace off. The smoke
// test (opencode/smoke/) creates it, so that an empty trace after a run proves the plugin never
// loaded there.
//
// It never throws: a throw inside execute.before refuses the tool call, so a trace that can't be
// written must not cost anything but the trace.

import fs from 'node:fs';
import path from 'node:path';

export const TRACE_FILE = path.join('.claude', 'dev-workflow-trace.jsonl');

export function trace(directory, entry) {
  try {
    if (!directory) return;
    const file = path.join(String(directory), TRACE_FILE);
    if (!fs.existsSync(file)) return;
    fs.appendFileSync(file, JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + '\n');
  } catch (e) { /* the trace never gets in the way */ }
}
