# dev-workflow-core

Workflow guardrails for Claude Code that work on any project, whatever the language. I use them on
my WoW addons and on C# and JavaScript projects too: nothing in here knows about the game.

## The rule

**Without a configuration file in the project, the hooks do nothing.**

So installing the plugin has no effect until a project turns it on. You can leave it enabled
everywhere and wire it only where it helps.

## What's in it

| Part | When it's active |
|---|---|
| **Hooks**: the project's checks at the end of a turn, size, read-only paths, work done elsewhere | once the project has a configuration, see below |
| **`/setup-project`** command | when you run it |
| **`feature-spec`** and **`human-verification`** skills | always, no configuration |
| **`spec-updater`** and **`docs-consistency-auditor`** agents | when Claude (or you) calls them, no configuration |

`human-verification` deals with a different problem than the hooks: what to do with what an agent
**can't observe**: what shows on screen, how a UI or a game behaves, a device, an operation that
takes a right the agent doesn't have. The default reflex is bad both ways: either the conclusion
slides ("the files are right" becomes "it works", when the first only says something is
*declared*), or an honest "not verified" settles in and never gets lifted. The skill gives the test
sheet format, the known-good control (without it, a failure can't tell a bad change from a bad test
procedure), and the dated log that closes the loop.

## Requirements

**Node** on your `PATH`. The hooks are JavaScript run by `node`. That's forced: `hooks.json` is
static JSON and can't branch on the operating system. Shipping a PowerShell script *and* a shell
script would make one of them fail on every edit, depending on the machine. One implementation in
an interpreter every platform has avoids that failure and two versions of the same guard drifting
apart. Windows, Linux and macOS are handled the same way.

The per-function size analysis also uses **Lua** for `.lua` files and **Python** for `.py` files
when they're around (see below); without them it falls back to counting lines.

## Turning it on in a project

The easy way, from the project:

```
/dev-workflow-core:setup-project
```

The command finds the main language, measures how big the files really are so the limits don't
complain about everything, writes the configuration and tries it on the biggest file of the
repository. It refuses to overwrite an existing configuration.

Otherwise, by hand: create `.claude/dev-workflow.json` at the project root
([`examples/dev-workflow.json`](examples/dev-workflow.json) has every section):

```json
{
  "fileSizeGuard": {
    "enabled": true,
    "maxFileLines": 500,
    "maxFunctionLines": 60,
    "include": ["*.lua"],
    "exclude": ["*/Libs/*", "*/Locale/*"]
  },
  "readonlyPathGuard": {
    "enabled": true,
    "blocked": ["*/World of Warcraft/*/Interface/AddOns/*"],
    "message": "That's the deployed copy: edit the source, then deploy."
  },
  "testGuard": {
    "enabled": true,
    "command": "npm test",
    "runOnlyIfChanged": ["*.lua"]
  }
}
```

The hooks walk up from the file being written to find that `.claude/dev-workflow.json`, then fall
back on `$CLAUDE_PROJECT_DIR`, then on the working directory. A monorepo can therefore have
different limits per subproject.

Patterns are **wildcards** (`*` and `?`), never regular expressions: `*/bin/*`, not
`.*[\\/]bin[\\/].*`. Both separators are the same: `*\Data\*` and `*/Data/*` match a Windows path
and a POSIX path alike, so one configuration works on both. In JSON, a backslash is written `\\`.

Hooks are read when a session starts: after turning the plugin on, start a new session.

## The guards

### `testGuard`: the project's checks (Stop)

The only guard that **stops** instead of warning. When Claude is about to hand back, it runs the
project's checks; if one fails, it cancels the stop and sends the output back, and Claude has to
fix it before concluding.

```json
"testGuard": {
  "enabled": true,
  "checks": [
    { "name": "build", "command": "dotnet build src/Core/Core.csproj -c Release", "runOnlyIfChanged": ["*.cs"] },
    {
      "name": "schemas",
      "command": "python tools/validate.py --no-color",
      "runOnlyIfChanged": ["*.yaml"],
      "failurePattern": "\\[ERROR\\]",
      "baseline": ".claude/dev-workflow.schemas.json"
    }
  ]
}
```

Each check has **its own trigger**: changing C# doesn't rerun the YAML validation, and the other
way round. The short form `"command": "npm test"` at the top level still works for a single check.
`timeoutSeconds` (120 by default) caps one check.

**The checks stay in your repository.** The plugin only carries the trigger: it runs a command and
reads an exit code, knowing nothing about the language. A suite that knows your domain belongs with
the code it checks, not in a shared plugin.

`runOnlyIfChanged` avoids rerunning a green check when nothing it watches moved: touching a README
reruns nothing. The state lives in `.claude/dev-workflow.teststate.json` (put it in `.gitignore`).
Without that filter the suite runs at every stop, and a suite that runs for nothing ends up turned
off.

What it does in the corner cases:

- **Anti-loop**: Claude Code flags the turns a Stop hook restarted (`stop_hook_active`); the guard
  doesn't block those again, or a check that can't be fixed would run forever.
- **Timeout**: warns without blocking. A tooling problem mustn't stop you from working.
- **Command not found**: when the shell says so plainly (exit code 127, or 9009 on Windows), the
  guard warns without blocking. But `cmd.exe` in some languages returns `1` with a translated
  message for an unknown command, exactly like a failing suite: that one blocks, with the shell's
  message, and you fix the command in ten seconds. Missing a regression costs more.

#### The session's worktrees

When several sessions share a checkout, each one works in a worktree of **its** scratchpad, and the
main checkout stays on the default branch. Testing only that one meant testing a branch nobody
touches. So the guard also tests every folder of the session's scratchpad (depth 1 or 2) that
carries its own `.claude/dev-workflow.json`: a worktree of the repository, as soon as the config is
**committed**. Each root has its config and its state; the messages name the worktree.

- The scratchpad comes from the payload (`scratchpad_dir`), failing that from the transcript's path;
  when it can't be found, only the project is tested.
- Another session's worktree is never tested, even if this session just read it: it isn't in this
  scratchpad.
- A worktree seen for the first time is checked right away, even if nothing moved in it. The
  guard's commands must therefore cope with a **partial** worktree: a nested repository that's
  missing should be skipped, not counted as a failure, through an option only the guard passes, so
  your release checks stay strict.
- A worktree opened on a branch that's **already red** (to read someone else's work, say) blocks
  again at every turn while it stays red. The fix is a `baseline`, or removing the worktree once
  you're done reading.
- `"budgetSeconds"` (150 by default, under the 180 s the manifest allows) bounds the whole run:
  the session's worktrees go first, and what couldn't run is reported without blocking.

#### Wiring a check that's already red: `failurePattern` + `baseline`

A useful check is often red the day you find it. Leaving it off until you "have the time" means
never wiring it.

With a `failurePattern`, the guard reads the output line by line; with a `baseline`, today's
failures are recorded and **only a new line blocks**, the same idea as `fileSizeGuard`'s baseline.
The message then quotes only what's new, not the known errors.

```
node hooks/scripts/save-test-baseline.js <project-root> <check-name>
```

Run it again after fixing errors, so the debt you paid off can't come back silently.

Without a `failurePattern`, the output can't be interpreted and every failure blocks: that's the
default, and the right one when the command is meant to be green.

With a pattern, the debt only counts as recorded when the pattern **recognized** failure lines and
all of them are in the baseline. A failure where no line matches the pattern (a broken tool, an
output format that changed, a folder not found) blocks, with the end of the output: that isn't
debt, it's a breakdown the pattern can't read.

The pattern also **shows** the failure: without it, only the last 25 lines of the output come back,
and a failure printed early disappears behind the rest of the suite.

### `fileSizeGuard`: size (PostToolUse)

After every write it measures the file and reports what goes over the limits. **Not blocking**:
the file is already written, the message is there to make Claude think about splitting.

It sees `Edit` / `Write` / `MultiEdit`, which name the file they wrote, **and** `Bash` /
`PowerShell`, which don't: after a command, it looks under the project root for watched files
written in the last minute (25 at most). Without that second path, any `sed -i` went through
unmeasured.

**File level**: every language.

**Function level**, by extension:

| Extensions | Analyzer | Accuracy | Needs |
|---|---|---|---|
| `.py` | `check_size.py` (`ast` module) | exact | `python` |
| `.lua` | `check_size.lua` (tokenizer) | exact | `lua` |
| `.cs` `.java` | `analyzers/braces.js` | heuristic | nothing |
| `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | `analyzers/braces.js` | heuristic | nothing |
| anything else | none | file level only | |

Interpreters are looked up in this order: the config key (`luaExe`, `pythonExe`), then
`$CLAUDE_LUA_EXE` / `$CLAUDE_PYTHON_EXE`, then the `PATH`. **When none is found, the hook falls back
to the file level**: it never breaks.

The brace heuristic recognizes C#/Java methods, `function`, `const x = () =>`, TS class methods and
inline callbacks (`router.get('/x', async (req, res) => {`). It blanks comments and literals with a
**state machine**, not with a chain of regexes: no order works. Blanking strings first breaks
`// don't do this`, the reverse breaks `"http://x"`. Known limit: a regex literal holding
unbalanced braces can throw the count off.

#### Per-file limits: `overrides`

A central registry that's legitimately big shouldn't shout forever. The first pattern that matches
wins:

```json
"overrides": { "*/models.py": 1500, "*/Contracts/*.cs": 1200 }
```

#### Known debt: `baseline`

```json
"baseline": ".claude/dev-workflow.baseline.json"
```

Records the existing violations; only **new** ones, or ones that get worse, are reported. That's
what makes the guard adoptable on an existing codebase: without it, wiring it on an old repository
produces dozens of warnings at the first edit. People ignore them, then they ignore the real ones.
A violation that improves without going away stays quiet: the point is to stop things getting
worse, not to demand perfection. `/setup-project` writes this file.

The format is `{ "relative/path": { "[FILE]": 812, "[FUNCTION] name": 95 } }`.

#### Extending to the documents

Nothing stops you, and `overrides` is made for it, with a high limit on the legitimately big ones:

```json
"include": ["*.cs", "*.md"],
"exclude": ["*/bin/*", "*/obj/*", "*/docs/API/*"],
"overrides": { "*/Long-Journal.md": 2000, "*.md": 700 }
```

Two precautions. **Leave out generated documentation**: an API reference produced by a script runs
to thousands of lines and would fail the guard for good. And on a document already over the limit,
set the override **just above its current size**: it's a ratchet that stops it from growing, not a
retroactive failure that blocks the next release over debt older than the rule.

### `readonlyPathGuard`: read-only areas (PreToolUse)

Before every write, **blocks** when the target path matches a `blocked` pattern. Useful for: raw
extractions, the installed game folder, vendored dependencies, the deployed copy of a source kept
elsewhere.

Only the **path** is inspected, never the content: a file that mentions a forbidden path in a
comment goes through.

#### It covers Bash and PowerShell too, partly, and you need to know which part

It inspects `tool_input.command` and **blocks** on unambiguous write constructs:

| Caught | Not caught |
|---|---|
| `>` / `>>`, `sed -i`, `tee` | `python - <<PY … open(p,'w') … PY` |
| `cp` / `mv` (destination), `rm`, `truncate`, `dd of=` | `node -e "fs.writeFileSync(…)"` |
| `Set-Content`, `Out-File`, `Add-Content`, `Remove-Item`, `New-Item`… | any other embedded interpreter |

**The right column isn't a to-do list, it's a limit of the method.** A write made inside an
interpreter can't be decided by a regex on the command line. The hook then prints a **warning**,
never a block, when a protected path shows up in a command that runs an interpreter.

In other words: it catches the slip, not the deliberate workaround. That's the realistic threat
model; don't credit it with another one.

### `coordinationGuard`: work done elsewhere (PreToolUse)

Before a write with `Edit` / `Write`, it checks whether the file **changed on origin** and wasn't
pulled, and says so before you write over a version you never saw.

```json
"coordinationGuard": {
  "enabled": true,
  "fetchMinutes": 10,
  "exclude": ["*/CHANGELOG.md", "*/.claude/*"]
}
```

**The defect it catches**: two people fixed the same file the same day, found out only at the
rebase, and one of the two versions was thrown away. The information existed (the other commit had
been on `origin` for twenty minutes) but nothing showed it **when the file was opened**, the only
moment it helps.

**Why it blocks when it would rather warn.** For a `PreToolUse` hook, exit 0 sends nothing to the
model (stdout goes to the debug log), `systemMessage` only speaks to the human, and
`additionalContext` doesn't exist for that event. **Only exit 2 gets a message through, and it
blocks the call.** So there's no non-blocking warning. The compromise: **block once per file and
per session**, then stay quiet. Making the same edit again goes through without a word.

Two limits, both on purpose:

- **It only sees what's pushed.** It runs `git fetch`, but at most once every `fetchMinutes`
  (fetching on every edit would be unbearable) and reads the local state in between. Two people
  writing the same thing without committing stay invisible to each other. The message always says
  how old its information is.
- **It doesn't see Bash or PowerShell writes**: it needs the file's path, which only `Edit` and
  `Write` announce.

Its cache (`.claude/.coordination-cache.json`) and session state (`.claude/.coordination-vus.json`)
are local: **put them in `.gitignore`**.

## Checking outside a hook, from the command line

The hooks only see **the files Claude Code just wrote**. To sweep a whole repository (a check
script run by hand, CI, a `Makefile` target), the three analyzers can be called directly, with the
same contract:

```bash
node   hooks/scripts/analyzers/braces.js [--porcelain] <maxFile> <maxFunction> <file...>
python hooks/scripts/check_size.py                     <maxFile> <maxFunction> <file...>
lua    hooks/scripts/check_size.lua                    <maxFile> <maxFunction> <file...>
```

Exit codes: **0** nothing over the limits, **1** at least one; `braces.js` and `check_size.py`
return **2** when the analysis didn't run (bad arguments). A caller must never read any other code
as "nothing to report": that's the failure this plugin exists to avoid. `check_size.lua` given no
file returns 0, so pass it at least one.

The default format is the hook's, meant for a person. It's also **read back by `baseline.js`**,
which makes it awkward for anyone else to parse: it shortens the path to the file name.
`braces.js --porcelain` prints tab-separated records instead, with fixed fields and the full path,
no prose and no summary line:

```
CONTRACT         braces    2
FILE             <path>    <lines>       <max>
FUNCTION         <path>    <startLine>   <name>   <lines>   <max>
UNREADABLE       <path>    <reason>
UNKNOWN-DIALECT  <path>
```

**`CONTRACT` comes first and always**, even when there's nothing to report, and a caller should
**require that line**. It makes "analyzed, nothing found" impossible to confuse with "never
analyzed" (an outdated copy that doesn't know the option, a wrong path). Its number only goes up
when the records change in a way an existing caller couldn't read; **adding a record type isn't a
break**, since callers filter on the first field.

The last two say **"this file wasn't analyzed"**. In human format they go to stderr; in porcelain
they're records like the others, because a caller that only reads stdout would miss them, conclude
"nothing over the limits" and show a green it didn't earn. They don't count as violations: the exit
code only speaks about violations. It also spares you from redirecting stderr, which in PowerShell
5.1 wraps each line of a native program in an `ErrorRecord` and fails `$?` on an exit code of 0.

## Adding a language

The per-function analysis plugs into `hooks/scripts/file-size-guard.js`, function
`analyzeByLanguage`. An analyzer follows the contract above and prints one line per violation on
stdout, in the format `baseline.js` reads back:

```
[FILE] name.lua: 812 lines (max 500, +312)
[FUNCTION] name.lua:42  myFunction(): 95 lines (max 60, +35)
```

`check_size.lua` is the model: it runs as a subprocess, so an analyzer can be written in any
language. A JS analyzer can also be `require()`d in process, as `braces.js` is by the hook: it then
exports `analyze(source, maxFunction, dialect)`.

## The agents

The guards watch the **code**. The two agents watch the **documentation**, and they aren't hooks:
Claude calls them when they fit, or you ask for them.

- **`spec-updater`** holds a diff against the documentation that describes it (specs, README,
  `CLAUDE.md`, skills) and returns what the diff made wrong, with replacements ready to paste. The
  judge is the code.
- **`docs-consistency-auditor`** looks for contradictions **inside** a documentation corpus: a ✅ in
  one file and a ⛔ on the same item in another, a dead link, an open item with no owner, a header
  that lies about its freshness.

**Why agents and not skills.** A handover corpus runs to hundreds of kilobytes. Loaded into the
main conversation, it's **sent again on every turn**: read once, paid for a hundred times. An agent
absorbs it in its own window and brings out only the lines that matter. Both are **read-only by
design**: fixing a contradiction needs knowing which of the two versions is true, and that's yours
to say.

## A trap worth knowing: the BOM

A UTF-8 byte order mark at the start of the JSON makes `JSON.parse` fail, and the hook then exits 0
**without a word**: the hardest failure there is to diagnose. Two sources add one without telling
you: a Windows editor saving `.claude/dev-workflow.json`, and PowerShell, which puts one in front of
what it pipes into a native program's stdin. Both are handled in `config.js` (`stripBom`), when the
file **and** stdin are read.
