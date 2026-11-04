# Smoke test in OpenCode

The automated tests (`tests/opencode-*.test.js`) run the plugin in a simulated OpenCode. This test
runs it in the real one: a model makes the tool calls by following `AGENT.md`, and `verify.js`
judges the run from the plugin's own trace and from the files on disk. The model writes a report
too, but the verdict doesn't depend on what it says.

**About 10 minutes.** You need OpenCode 2.x with a model that can call tools, and Node.js 20 or
later on the `PATH`.

## Steps

1. Install the plugin **from the checkout you're testing** (a branch, a worktree, a clone):

   ```
   node <checkout>/opencode/install.js
   ```

2. Create the test project in a folder that doesn't exist yet:

   ```
   node <checkout>/opencode/smoke/setup.js <new-folder>
   ```

3. Start OpenCode in that folder (`cd <new-folder>`, then `opencode`). **Approve its permission
   prompts**: a denied prompt leaves the same files behind as a guard that refused the call.
4. Send: `Read SMOKE-TEST.md in this project and do Part 1, following its rules exactly.`
   Wait for `PART 1 DONE`.
5. Send: `Now do Part 2 of SMOKE-TEST.md.` The model answers `PART 2 DONE`. A message starting
   with `[dev-workflow-core]` should then arrive by itself, and the model answers `RECORDED`. Wait
   a few seconds more: nothing else should arrive.
6. Run:

   ```
   node <checkout>/opencode/smoke/verify.js <new-folder>
   ```

## What `verify.js` checks

| Check | Passes when the trace and the files show |
|---|---|
| plugin loaded | the plugin started in this folder, and from which checkout |
| control | `Open/a.txt` written through a call the plugin saw and let through |
| write into Deployed | the call on `Deployed/a.txt` refused with the project's message, and the file absent |
| shell into Deployed | `echo x > Deployed/b.txt` refused the same way through the shell tool |
| size | the `[size]` message appended to the result of the call that wrote `src/big.js` |
| end of part 1 | the project's check ran at the end of the turn, passed, and nothing was sent |
| end of part 2 | with `RED` present, the check failed and the failure was sent back exactly once |
| retried turn | the turn started by that message ended without another one |
| configuration | `.claude/dev-workflow.json` still as `setup.js` wrote it |

It also lists every tool name OpenCode sent, with the names of the arguments of the tools the
plugin doesn't cover: that's where a missed write shows up.

The trace is `.claude/dev-workflow-trace.jsonl` in the test project, one JSON line per event. Any
project can turn it on the same way, by creating that file empty.
