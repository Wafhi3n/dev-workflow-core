// baseline.js: known debt. Only violations that are NEW, or worse than recorded, get reported.
//
// This is what makes the size guard adoptable on an existing codebase. Without a baseline, turning
// the hook on in an old repository produces dozens of warnings on the first edit: people ignore
// them, then they ignore the real ones. With a baseline, what exists is recorded once and only
// what gets worse speaks up.
//
// Format (one entry per file, path relative to the project root):
//   { "src/models.py": { "[FILE]": 1502, "[FUNCTION] build_all": 95 } }
//
// Baselines written before 2.0.0 use the French keys "[FICHIER]" and "[FONCTION] name": they are
// read as "[FILE]" and "[FUNCTION] name", so an existing baseline keeps filtering after the update.

const fs = require('fs');

// The analyzers print formatted lines; the key and the count are read back from them. The format
// is ours, shared by check_size.lua, check_size.py and braces.js:
//   [FILE] name.lua: 812 lines (max 500, +312)
//   [FUNCTION] name.lua:42  myFunction(): 95 lines (max 60, +35)
// The French lines of the 1.x analyzers ("[FICHIER] ... : 812 lignes") are still understood.
const PARSE = /^\s*(\[FILE\]|\[FUNCTION\]|\[FICHIER\]|\[FONCTION\])\s+(.+?)\s*:\s*(\d+)\s+(?:lines|lignes)\b/;

const LEGACY_KEYS = [['[FICHIER]', '[FILE]'], ['[FONCTION]', '[FUNCTION]']];

// "[FONCTION] foo" -> "[FUNCTION] foo"; any other key is returned as is.
function currentKey(key) {
  for (const [legacy, current] of LEGACY_KEYS) {
    if (key === legacy || key.startsWith(legacy + ' ')) return current + key.slice(legacy.length);
  }
  return key;
}

// { key, count }, or null when the line isn't a violation (a summary line, for instance).
function parseViolation(line) {
  const m = String(line).match(PARSE);
  if (!m) return null;

  const kind = currentKey(m[1]);
  const count = Number(m[3]);

  if (kind === '[FILE]') return { key: '[FILE]', count };

  // "name.lua:42  myFunction()" -> "[FUNCTION] myFunction"
  // The start line is left out of the key on purpose: adding code ABOVE a function would shift it
  // and make the function look new.
  const fn = m[2].replace(/^.*?:\d+\s+/, '').replace(/\(\)\s*$/, '');
  return { key: '[FUNCTION] ' + fn, count };
}

// Reads a baseline, with every entry's keys brought to the current spelling.
function load(path) {
  if (!path || !fs.existsSync(path)) return null;
  let data;
  try {
    const raw = fs.readFileSync(path, 'utf8');
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  for (const file of Object.keys(data)) {
    const entry = data[file];
    if (!entry || typeof entry !== 'object') continue;
    const renamed = {};
    for (const key of Object.keys(entry)) renamed[currentKey(key)] = entry[key];
    data[file] = renamed;
  }
  return data;
}

// Keeps the violations the baseline doesn't know, or that are worse than it says.
// A violation that improves without going away stays quiet: the point is to stop things getting
// worse, not to demand perfection.
function filterNew(lines, entry) {
  if (!entry) return lines;

  return lines.filter(function (line) {
    const v = parseViolation(line);
    if (!v) return true;
    const known = entry[v.key];
    if (typeof known !== 'number') return true;
    return v.count > known;
  });
}

// A file's entry built from its violations, for /setup-project when it writes the baseline.
function buildEntry(lines) {
  const entry = {};
  lines.forEach(function (line) {
    const v = parseViolation(line);
    if (v) entry[v.key] = v.count;
  });
  return entry;
}

module.exports = { parseViolation, load, filterNew, buildEntry };
