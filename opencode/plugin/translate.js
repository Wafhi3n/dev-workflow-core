// translate.js: what an OpenCode 2.x tool call means for the hook scripts, which were written for
// Claude Code's payload (tool_name, tool_input.file_path, tool_input.command, cwd).
//
// The built-in tools, as their input schemas declare them (packages/core/src/tool/plugin/*.ts,
// read on 2026-11-04 for OpenCode 2.2.5):
//   edit  { path, oldString, newString, replaceAll? }
//   write { path, content }
//   patch { patchText }      several files, named on "*** Add File:" style marker lines
//   shell { command, workdir?, timeout?, background? }
// A relative path resolves against the session's location, as the tools themselves do.
//
// Paths are made absolute HERE: the read-only guard matches its patterns ("*/X/*") against the raw
// string it's given, and a relative path would never match, letting every write through.

import path from 'node:path';

// Claude Code's tool names, which the scripts and their messages expect.
const FILE_TOOLS = { edit: 'Edit', write: 'Write', patch: 'Edit' };
const SHELL_TOOLS = { shell: 'Bash' };

// The marker lines of a patch that name a file it writes, moves to or deletes.
const PATCH_MARKER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/;

function absolute(file, baseDir) {
  if (typeof file !== 'string' || !file.trim()) return null;
  return path.resolve(baseDir, file.trim());
}

// Every file a patch touches, absolute, without duplicates.
export function patchFiles(patchText, baseDir) {
  const out = [];
  for (const line of String(patchText || '').split(/\r?\n/)) {
    const m = PATCH_MARKER.exec(line);
    const file = m && absolute(m[1], baseDir);
    if (file && !out.includes(file)) out.push(file);
  }
  return out;
}

// What a call targets, or null when no guard is concerned:
//   { kind: 'file', toolName, files: [absolute paths], cwd }
//   { kind: 'shell', toolName, command, cwd }
// cwd is the session's directory, or the shell's workdir: what Claude Code would send as cwd.
export function targetsOf(tool, input, baseDir) {
  const args = input && typeof input === 'object' ? input : {};
  if (FILE_TOOLS[tool]) {
    const files = tool === 'patch'
      ? patchFiles(args.patchText, baseDir)
      : [absolute(args.path ?? args.filePath ?? args.file_path, baseDir)].filter(Boolean);
    return files.length ? { kind: 'file', toolName: FILE_TOOLS[tool], files, cwd: baseDir } : null;
  }
  if (SHELL_TOOLS[tool] && typeof args.command === 'string' && args.command.trim()) {
    const cwd = typeof args.workdir === 'string' && args.workdir.trim() ? path.resolve(baseDir, args.workdir) : baseDir;
    return { kind: 'shell', toolName: SHELL_TOOLS[tool], command: args.command, cwd };
  }
  return null;
}

// The Claude Code payloads for one call: one per file, one for a command.
export function payloadsFor(target, sessionID, event) {
  const base = { session_id: String(sessionID || ''), hook_event_name: event, tool_name: target.toolName, cwd: target.cwd };
  if (target.kind === 'shell') return [Object.assign({}, base, { tool_input: { command: target.command } })];
  return target.files.map((file) => Object.assign({}, base, { tool_input: { file_path: file } }));
}

// A tool result with a text appended, whatever form its content takes (string, list of parts, or
// none). The model reads the content; the structured output is kept as is.
export function appendText(result, text) {
  const r = result && typeof result === 'object' ? result : {};
  const content = r.content;
  if (Array.isArray(content)) return Object.assign({}, r, { content: content.concat([{ type: 'text', text }]) });
  let before = typeof content === 'string' ? content : '';
  if (!before && r.output !== undefined) before = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
  return Object.assign({}, r, { content: before ? before + '\n\n' + text : text });
}
