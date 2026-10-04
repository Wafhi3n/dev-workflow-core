// coordination-guard.js: PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit). Warns when the file
// about to be modified changed ON ORIGIN and wasn't pulled. You would be writing over a version
// you've never seen.
//
// WHAT IT CATCHES, AND WHAT IT DOESN'T
// ------------------------------------
// It catches session drift: you work for two hours, someone pushes meanwhile, and you edit a file
// they just changed without knowing.
//
// It does NOT catch two people starting the same thing at the same time: as long as nothing is
// pushed, nothing can be observed. That limit isn't theoretical, it's exactly the 2026-08-14
// incident that prompted this guard, and the first version, which reported "recently touched by
// someone else", wouldn't have seen it either. It did report dozens of files already pulled, so
// already seen: a lot of noise for little information. Against that case only a claim published
// BEFORE starting works (a pushed branch, a ticket, a handover board).
//
// WHY THIS GUARD BLOCKS WHEN IT WOULD RATHER WARN
// -----------------------------------------------
// For a PreToolUse hook, exit 0 sends NOTHING to the model: stdout goes to the debug log, and
// `systemMessage` only speaks to the human. There's no `additionalContext` for this event. Only
// exit 2 gets a message to Claude, and exit 2 blocks the call.
//
// So a non-blocking warning isn't possible. The compromise: block ONCE per file and per session,
// then stay quiet. Making the same edit again goes through without a word. That also bounds the
// cost: a block costs a lost call plus a retry, and a guard that cost ten per session would spend
// more than it saves.
//
// Configuration: <project>/.claude/dev-workflow.json, section "coordinationGuard".
// No section => this hook does nothing (the plugin's rule).
//
//   "coordinationGuard": {
//     "enabled": true,
//     "fetchMinutes": 10,
//     "exclude": ["*/CHANGELOG.md", "*/.claude/*"]
//   }
//
// exit 0 = allowed; exit 2 = blocked once (the message goes to Claude).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readPayload, getConfig, findConfig, projectRootFrom, matchesAny, isEnabled } = require('./config');

// Both are machine-local state, rebuilt on their own: projects put them in .gitignore. The names
// are kept from 1.x so those .gitignore lines still hold.
const CACHE = '.coordination-cache.json';
const SEEN = '.coordination-vus.json';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (e) {
    // A cache that can't be written must never stop an edit.
  }
}

// No shell, never a stderr redirection, and a time limit: a git command that fails (outside a
// repository, git missing, network down) must return null, not bring the hook down or hang the
// edit.
function git(root, args, timeoutMs) {
  try {
    return execFileSync('git', ['-C', root].concat(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs || 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    return null;
  }
}

// What to compare HEAD with: the current branch on origin when it exists there, else the trunk.
// Without that, a new local branch (a worktree) would make git complain about an unknown ref.
function upstreamRef(root) {
  const branch = (git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();

  if (branch && branch !== 'HEAD') {
    if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch]) !== null) {
      return 'origin/' + branch;
    }
  }

  const trunk = (git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) || '').trim();
  const candidate = trunk || 'origin/master';
  return git(root, ['rev-parse', '--verify', '--quiet', candidate]) !== null ? candidate : null;
}

// One record per commit, separated by \x01 to tell the header line from the file lines that follow
// it without ambiguity.
function buildCache(root, fetchMs) {
  // One fetch every `fetchMinutes` at most, never on every edit. Its failure isn't fatal: the local
  // refs, older, are used instead.
  git(root, ['fetch', '--quiet'], fetchMs);

  const upstream = upstreamRef(root);
  if (!upstream) return null;

  const raw = git(root, ['log', 'HEAD..' + upstream, '--format=%x01%H%x09%an%x09%aI%x09%s', '--name-only']);
  if (raw === null) return null;

  const files = {};
  raw.split('\x01').forEach(function (block) {
    const lines = block.split('\n').filter(function (l) { return l.trim(); });
    if (lines.length === 0) return;

    const head = lines[0].split('\t');
    if (head.length < 4) return;

    lines.slice(1).forEach(function (file) {
      // git log goes from newest to oldest: the first one seen for a file is the right one, the
      // next ones are older.
      if (files[file]) return;
      files[file] = { who: head[1], sha: head[0].slice(0, 7), when: head[2], subject: head[3] };
    });
  });

  return { generated: new Date().toISOString(), upstream: upstream, files: files };
}

function loadCache(claudeDir, root, g) {
  const file = path.join(claudeDir, CACHE);
  const minutes = Number(g.fetchMinutes) > 0 ? Number(g.fetchMinutes) : 10;

  const cache = readJson(file);
  // A 1.x cache uses other field names: it's treated as missing and rebuilt.
  if (cache && cache.generated && cache.files) {
    const age = (Date.now() - Date.parse(cache.generated)) / 60000;
    if (age >= 0 && age < minutes) return cache;
  }

  const fresh = buildCache(root, Math.min(minutes * 60000, 8000));
  if (!fresh) return cache && cache.files ? cache : null;
  writeJson(file, fresh);
  return fresh;
}

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!isFinite(minutes) || minutes < 0) return 'at an unknown time';
  if (minutes < 60) return minutes + ' min ago';
  if (minutes < 60 * 24) return Math.round(minutes / 60) + ' h ago';
  return Math.round(minutes / (60 * 24)) + ' days ago';
}

// True when this file was already reported in THIS session. Marks it otherwise.
// The state resets as soon as the session changes: only one session is ever kept, or this file
// would grow forever.
function alreadyReported(claudeDir, session, relative) {
  const file = path.join(claudeDir, SEEN);
  const seen = readJson(file);

  if (seen && seen.session === session && Array.isArray(seen.files)) {
    if (seen.files.indexOf(relative) >= 0) return true;
    seen.files.push(relative);
    writeJson(file, seen);
    return false;
  }

  writeJson(file, { session: session, files: [relative] });
  return false;
}

function main() {
  const payload = readPayload();
  if (!payload || !payload.tool_input) return 0;

  const file = payload.tool_input.file_path;
  if (!file) return 0;

  const cfg = getConfig(file);
  if (!cfg) return 0;

  const g = cfg.coordinationGuard;
  if (!isEnabled(g)) return 0;

  const root = projectRootFrom(findConfig(file));
  if (!root) return 0;

  const relative = path.relative(root, path.resolve(file)).replace(/\\/g, '/');

  // Outside the project (deployed copy, raw extraction): not our business.
  if (!relative || relative.indexOf('..') === 0) return 0;
  if (g.exclude && matchesAny(relative, g.exclude)) return 0;

  const claudeDir = path.join(root, '.claude');
  const cache = loadCache(claudeDir, root, g);
  if (!cache || !cache.files) return 0;

  const info = cache.files[relative];
  if (!info) return 0;

  if (alreadyReported(claudeDir, payload.session_id || 'no-session', relative)) return 0;

  console.error('NOT UP TO DATE: ' + relative + ' changed on ' + cache.upstream + ', and this repository hasn\'t pulled it.');
  console.error('  ' + info.who + ', ' + ago(info.when) + ': ' + info.sha + ' "' + info.subject + '"');
  console.error('  See:  git log -p HEAD..' + cache.upstream + ' -- ' + relative);
  console.error('  Pull: git pull --ff-only');
  console.error('  Writing over it without pulling will redo someone\'s work, or overwrite it.');
  console.error('  If that\'s intended, make the edit again: this block won\'t come back.');
  return 2;
}

process.exit(main());
