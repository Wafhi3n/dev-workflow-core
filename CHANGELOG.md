# Changelog

The `version` in `.claude-plugin/plugin.json` goes up with every release: Claude Code files an
installed plugin by its version, so an update that keeps the same number may never reach people
who already installed it.

## 2.1.0 - 2026-11-04

- **OpenCode 2.x.** `node opencode/install.js` installs the guards, skills, agents and command into
  OpenCode from a clone of this repository. The hooks are the same scripts, run by a plugin
  (`opencode/plugin/`) that translates OpenCode's tool calls into the payloads they read. One
  difference: the checks at the end of a turn run once the turn has ended, and a failure comes back
  as a new message instead of holding the answer. See "In OpenCode" in the README. Tested against
  a simulated plugin context, not yet inside OpenCode.
- An opt-in trace for the OpenCode plugin (`.claude/dev-workflow-trace.jsonl`), and a smoke test
  for a real OpenCode (`opencode/smoke/`): a model follows `AGENT.md`, and `verify.js` judges the
  run from the trace and the files, not from what the model reports.
- Nothing changes for Claude Code.

## 2.0.1 - 2026-11-03

- The plugin has its own repository and marketplace, `Wafhi3n/dev-workflow-core`. It used to live
  in `Wafhi3n/wow-addon-workspace`, where nobody outside WoW addons would look for it. Nothing
  changes in the code.
- Already installed as `dev-workflow-core@wow-addon-workspace`? It keeps working and updating:
  that marketplace now fetches the plugin from here. Don't install it from both, or every hook runs
  twice.
- `/dev-workflow-core:setup-project` gives the install id of either marketplace.

## 2.0.0 - 2026-10-04

First public version, published in `Wafhi3n/wow-addon-workspace`. The 1.x line lived in a private
marketplace, in French; this one is the same code with its messages, docs and records in English.

- Hooks: the project's checks before Claude hands back (`testGuard`), files and functions measured
  after every write (`fileSizeGuard`), writes to read-only paths blocked (`readonlyPathGuard`), a
  warning before editing a file that changed on origin (`coordinationGuard`). All off until a
  project has a `.claude/dev-workflow.json`.
- `/dev-workflow-core:setup-project`, the `feature-spec` and `human-verification` skills, the
  `spec-updater` and `docs-consistency-auditor` agents.
- Coming from 1.x: size baselines with French keys (`[FICHIER]`, `[FONCTION] name`) still work, they
  are read as `[FILE]` and `[FUNCTION] name`. `braces.js --porcelain` moved to contract 2: its
  records are now `CONTRACT`, `FILE`, `FUNCTION`, `UNREADABLE`, `UNKNOWN-DIALECT`, so a script that
  looks for `CONTRAT` will report the analysis as not done until it's updated. The Stop hook is now
  `stop-test-guard.js` (`node --test` took `test-guard.js` for a test file and waited on its stdin
  forever). The `apiReference` hooks (generated API corpus for Unity/IL2CPP projects) are not part
  of this version.
