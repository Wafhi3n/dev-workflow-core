---
name: setup-project
description: "Looks at the current project and writes the dev-workflow-core configuration (.claude/dev-workflow.json), with limits and exclusions measured on its code. Nothing is overwritten."
argument-hint: "[lines per file] [lines per function]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, PowerShell
---

Set up `dev-workflow-core` on this project. The goal: a size guard and a read-only guard that are
on and **right**, not generic limits that complain about everything.

## 1. Overwrite nothing

If `.claude/dev-workflow.json` already exists, read it and **stop**: show its content and ask what
should change. Never rewrite it without the user's go.

## 2. Recognize the project

Count the source files by extension (generated folders left out) to find the main language or
languages. Use the root markers too: `*.csproj` / `*.sln`, `package.json`, `pyproject.toml` /
`requirements.txt`, `go.mod`, `Cargo.toml`, `*.toc` (WoW addon), `pom.xml` / `build.gradle`.

Then measure **what the repository actually looks like** before choosing the limits: the
distribution of source file sizes (median, 90th percentile, maximum). A limit under the existing
90th percentile turns the hook into constant noise, and it gets ignored: that's the trap to avoid.
Aim for a limit that only flags the real tail of the distribution.

## 3. Write the configuration

Create `.claude/dev-workflow.json`:

```json
{
  "fileSizeGuard": {
    "enabled": true,
    "maxFileLines": 500,
    "maxFunctionLines": 60,
    "include": ["*.cs"],
    "exclude": ["*/bin/*", "*/obj/*"]
  },
  "readonlyPathGuard": {
    "enabled": false,
    "blocked": [],
    "message": ""
  }
}
```

Rules:

- `include`: only the extensions that are really there. Don't list absent languages "just in
  case".
- `exclude`: the project's generated, vendored and build folders: `node_modules`, `bin`, `obj`,
  `dist`, `build`, `target`, `vendor`, `__pycache__`, `.venv`, generated migrations, code a tool
  writes. In a WoW addon workspace, embedded libraries (`*/Libs/*`) too.
- **Patterns are wildcards (`*` and `?`), not regexes**: `*/bin/*`, never `.*[\\/]bin[\\/].*`.
  Both separators are the same (`*\bin\*` equals `*/bin/*`), so one configuration works on Windows
  and on POSIX. Prefer `/`, easier to read in JSON, where a backslash has to be written `\\`.
- `readonlyPathGuard`: leave `enabled: false` when there's nothing obvious to protect. Turn it on
  only for a real read-only area: a deployed copy (an addon copied into the game's
  `Interface/AddOns`, for instance), a raw extraction, a vendored dependency, an install folder.
  Always ask before setting it to `true`: a false positive here **blocks** a write.
- `overrides`: suggest a higher limit for **legitimate central registries** found during the scan
  (a file far above the others, with a repetitive structure: models, contracts, generated
  constants). Don't invent any: only suggest one if the scan really showed one.
- Per-function analysis exists for `.py` (`ast` module), `.lua` (tokenizer), `.cs`/`.java` and
  `.ts`/`.js` (brace heuristic). For any other language, `maxFunctionLines` is written but does
  nothing: say so, don't let the user believe otherwise.
- Set `luaExe` / `pythonExe` when the interpreter isn't on the `PATH`; otherwise the check silently
  falls back to the file level.

## 3a. Wire the checks

Look for the project's real check command: a `test` script in `package.json`, `pytest`/`tox.ini`,
a `run_tests` script, a `make test` target, a `*.Tests.csproj` project. Never point it inside
`~/.claude/plugins/cache/`: an installed plugin moves to a new folder at every update, and the
command would break silently. **Invent nothing**: without an existing suite, don't write
`testGuard`, and say so. A hook that runs a command that doesn't exist would block every end
of turn.

When a suite exists, run it **once** to check that it passes and to time it, then write:

```json
"testGuard": {
  "enabled": true,
  "command": "<the command you ran>",
  "timeoutSeconds": <measured time x3, at least 60>,
  "runOnlyIfChanged": ["<source code extensions>"]
}
```

**If the check is already red**, two ways, and never wire it as it is: that would make it
impossible to conclude any turn.

- Its output lists errors line by line (`[ERROR] ...`, `FAILED ...`): give it a `failurePattern`
  and a `baseline`, then record what exists with
  `node ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/save-test-baseline.js <root> <name>`. Only a new error
  will block. **This is the way to prefer**: a check left off until there's "time for it" never
  gets wired again.
- Its output can't be read line by line: leave `enabled: false` and say so plainly.

Several checks go in `checks`, each with its own `runOnlyIfChanged`: a build shouldn't rerun when
only data changed.

Tell the user the measured time: that's what they'll pay at every stop.

## 3b. Record the existing debt

On a repository that has some history, write the **baseline** too, or the guard will report what
already exists on every edit and be ignored within two days.

Run the analyzers on the files `include` covers, collect their violations, and write
`.claude/dev-workflow.baseline.json` as `{ "relative/path": { "[FILE]": 812,
"[FUNCTION] name": 95 } }` (paths relative to the root, `/` separators). Then add
`"baseline": ".claude/dev-workflow.baseline.json"` to the config.

Say how many violations were recorded. If the repository is clean, don't create the file: an empty
baseline adds nothing.

## 4. Check it for real

Don't stop at writing the file. Run the hook by hand on the project's biggest source file, the way
Claude Code does. The payload must be **valid JSON**, so build the string with a tool, never by
hand (a Windows backslash that isn't doubled makes invalid JSON, the hook exits 0 and the test
lies).

```powershell
$env:CLAUDE_PROJECT_DIR = "<project root>"
$j = @{ tool_input = @{ file_path = "<biggest file>" } } | ConvertTo-Json -Compress
$j | & node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/file-size-guard.js"
```

```bash
CLAUDE_PROJECT_DIR="<root>" \
  node -e 'console.log(JSON.stringify({tool_input:{file_path:process.argv[1]}}))' "<file>" \
  | node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/file-size-guard.js"
```

Exit code 0 = under the limits, 2 = something over them was reported. Report the result you got,
not the one you expected.

## 5. Conclude

Say:

- what was written and why these limits (quote the measured numbers);
- how to turn the plugin on for the project: `enabledPlugins` in the project's
  `.claude/settings.json`, with `"dev-workflow-core@wow-addon-workspace": true`;
- that **the hooks manifest is only read when a session starts**: restart for the hooks to take
  effect;
- **if `node` isn't on the `PATH`**: the hooks are written in JavaScript and won't run. Check it
  (`node --version`) and say so plainly rather than deliver a configuration that will never run.

If `$ARGUMENTS` holds numbers, use them as the file and function limits instead of the measured
ones.
