// config.js: how every hook of dev-workflow-core finds and reads the project's configuration.
//
// The rule that makes the plugin safe to leave on everywhere: no project configuration, no effect.
// A hook that finds no .claude/dev-workflow.json exits 0 without a word.

const fs = require('fs');
const path = require('path');

// Drops a UTF-8 byte order mark. Node keeps it when reading and JSON.parse rejects it. Two sources
// add one without telling you: a Windows editor saving the config file, and PowerShell, which puts
// one in front of what it pipes into a native program's stdin. Left in, the hook exits 0 without a
// word, the hardest failure there is to track down.
// Compares the code unit rather than a literal character in this source.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// The hook's JSON payload from stdin, or null when there is none or it doesn't parse.
function readPayload() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    return null;
  }
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(stripBom(raw));
  } catch (e) {
    return null;
  }
}

// Walks up from dir looking for .claude/dev-workflow.json.
function walkUp(dir) {
  let current = dir;
  while (current) {
    const candidate = path.join(current, '.claude', 'dev-workflow.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// Finds the config: walking up from the file being edited first (so each subproject of a monorepo
// can have its own limits), then in the project root Claude Code gives, then from the working
// directory.
//
// readonlyPathGuard needs the CLAUDE_PROJECT_DIR fallback: what it protects usually sits OUTSIDE
// the project (a deployed copy, a raw extraction), with no .claude folder above it.
function findConfig(startPath) {
  if (startPath) {
    let dir = startPath;
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
    } catch (e) {
      dir = path.dirname(dir);
    }
    const found = walkUp(dir);
    if (found) return found;
  }

  if (process.env.CLAUDE_PROJECT_DIR) {
    const candidate = path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'dev-workflow.json');
    if (fs.existsSync(candidate)) return candidate;
  }

  return walkUp(process.cwd());
}

// The parsed config, or null when there is none or it doesn't parse.
function getConfig(startPath) {
  const file = findConfig(startPath);
  if (!file) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return null;
  }
}

// One separator for patterns and paths alike, so "*\Data\*" written on Windows and a POSIX path
// meet on "/".
function normalize(value) {
  return String(value).replace(/\\/g, '/');
}

// A wildcard pattern (* and ?) as an anchored, case-insensitive regular expression.
function patternToRegExp(pattern) {
  const escaped = normalize(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + body + '$', 'i');
}

// True when value matches at least one of the patterns.
function matchesAny(value, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const subject = normalize(value);
  return patterns.some(function (p) {
    if (!p || !String(p).trim()) return false;
    return patternToRegExp(p).test(subject);
  });
}

// True unless the section is missing or says enabled: false.
function isEnabled(section) {
  return !!section && section.enabled !== false;
}

// The project root, from the config's own path: <root>/.claude/dev-workflow.json. Baseline keys
// are made relative to it, so a baseline reads the same on every machine.
function projectRootFrom(configPath) {
  if (!configPath) return null;
  return path.dirname(path.dirname(configPath));
}

module.exports = { readPayload, getConfig, findConfig, projectRootFrom, matchesAny, isEnabled };
