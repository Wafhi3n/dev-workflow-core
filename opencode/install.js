#!/usr/bin/env node
'use strict';
// install.js: installs dev-workflow-core into OpenCode 2.x, from this clone.
//
//   node opencode/install.js                  global: ~/.config/opencode
//   node opencode/install.js --project <dir>  one project: <dir>/.opencode
//   node opencode/install.js --dir <dir>      any OpenCode config folder
//   add --uninstall to remove what it wrote, --dry-run to only print what it would do.
//
// What it writes:
//   plugins/dev-workflow-core.js   a pointer to opencode/plugin/ in this clone (the hooks)
//   agents/<name>.md               converted from agents/
//   commands/<name>.md             converted from commands/
//   skills/<name>/SKILL.md         converted from skills/
// Every file carries a marker. A file without it is someone else's: it's never overwritten nor
// removed, and the run ends with code 1 so it can't go unnoticed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const convert = require('./convert');

const ROOT = path.resolve(__dirname, '..');

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || '?';
  } catch (e) {
    return '?';
  }
}

function parseArgs(argv) {
  const args = { uninstall: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall') args.uninstall = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--project' || a === '--dir') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--project and --dir need a folder.');
      args[a.slice(2)] = value;
    } else throw new Error('Unknown argument: ' + a);
  }
  return args;
}

function targetDir(args) {
  if (args.dir) return path.resolve(args.dir);
  if (args.project) return path.join(path.resolve(args.project), '.opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

function markdownFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch (e) { return []; }
}

// Every file to write: { rel, content }, rel relative to the OpenCode config folder.
function plan(root) {
  const v = version();
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const items = [{
    rel: 'plugins/dev-workflow-core.js',
    content: convert.pluginPointer({ version: v }, pathToFileURL(path.join(root, 'opencode', 'plugin', 'index.js')).href),
  }];
  for (const name of markdownFiles(path.join(root, 'agents'))) {
    items.push({ rel: 'agents/' + name, content: convert.agent(read('agents/' + name), { version: v, source: 'agents/' + name }) });
  }
  for (const name of markdownFiles(path.join(root, 'commands'))) {
    const source = 'commands/' + name;
    items.push({ rel: source, content: convert.command(read(source), { version: v, source, root }) });
  }
  let skills = [];
  try { skills = fs.readdirSync(path.join(root, 'skills')).sort(); } catch (e) { /* none */ }
  for (const name of skills) {
    const source = 'skills/' + name + '/SKILL.md';
    if (!fs.existsSync(path.join(root, source))) continue;
    items.push({ rel: source, content: convert.skill(read(source), { version: v, source }) });
  }
  return items;
}

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

// Writes the plan into target. Returns [{ rel, status }]: written, unchanged, refused.
function install(target, items, dryRun) {
  return items.map((item) => {
    const file = path.join(target, item.rel);
    const current = readOrNull(file);
    if (current !== null && !current.includes(convert.MARK)) return { rel: item.rel, status: 'refused' };
    if (current === item.content) return { rel: item.rel, status: 'unchanged' };
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, item.content, 'utf8');
    }
    return { rel: item.rel, status: 'written' };
  });
}

// Removes what install wrote. Returns [{ rel, status }]: removed, absent, refused.
function uninstall(target, items, dryRun) {
  return items.map((item) => {
    const file = path.join(target, item.rel);
    const current = readOrNull(file);
    if (current === null) return { rel: item.rel, status: 'absent' };
    if (!current.includes(convert.MARK)) return { rel: item.rel, status: 'refused' };
    if (!dryRun) {
      fs.unlinkSync(file);
      const dir = path.dirname(file);
      if (item.rel.startsWith('skills/')) { try { fs.rmdirSync(dir); } catch (e) { /* not empty: left */ } }
    }
    return { rel: item.rel, status: 'removed' };
  });
}

const AFTER_INSTALL = [
  'The plugin file points at this clone: the hooks follow its updates. The agents, the command and',
  'the skills are copies: run this again after each update.',
  'Restart OpenCode if it was running. The guards stay off in a project until it has a',
  '.claude/dev-workflow.json: run /setup-project there to write one.',
];

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const target = targetDir(args);
  const items = plan(ROOT);
  const results = args.uninstall ? uninstall(target, items, args.dryRun) : install(target, items, args.dryRun);

  const verb = args.uninstall ? 'Uninstalling' : 'Installing';
  console.log(verb + ' dev-workflow-core ' + version() + ' for OpenCode in ' + target + (args.dryRun ? ' (dry run)' : '') + ':');
  results.forEach((r) => console.log('  ' + r.status.padEnd(10) + r.rel));
  const refused = results.filter((r) => r.status === 'refused');
  if (refused.length) {
    console.error('Not ours (no "' + convert.MARK + '" marker), left as is: ' + refused.map((r) => r.rel).join(', '));
    return 1;
  }
  if (!args.uninstall && !args.dryRun) AFTER_INSTALL.forEach((l) => console.log(l));
  return 0;
}

module.exports = { parseArgs, targetDir, plan, install, uninstall, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
