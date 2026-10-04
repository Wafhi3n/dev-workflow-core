---
name: feature-spec
description: "Write the specification of ONE feature BEFORE coding it, and keep it up to date afterwards: one docs/specs/<feature>.md file per feature, never one document that keeps growing. Use when starting work that will touch several files or span several sessions, when about to say \"I'll code it and we'll see\", when a conversation produced decisions no file holds, or when resuming work left halfway and nobody remembers what was wanted. Gives the template, the line between the spec (stable, the WHAT) and the plan (short-lived, the HOW), how to write OBSERVABLE acceptance criteria that name who observes them, and the four known ways to get a spec wrong. Doesn't replace a conversation for a small task, and saying so plainly is part of the job."
user-invocable: true
---

You write or maintain the **specification of a feature**. The spec describes what we want; the code
follows from it, not the other way round. It serves three readers: the person who decides, the
agent who implements, and **the next session**, the one that will have forgotten everything.

## 1. First: is it worth a spec?

**No** for a small task: a local fix, a rename, a display tweak, anything that fits in a
conversation and gets checked right away. Writing a spec for that costs more than it brings, and
saying so plainly is part of the job.

**Yes** as soon as one of these signals shows up:

- the work touches **several files** or will last **more than one session**;
- it changes a **contract** others already rely on (wire format, saved data layout, API);
- there are **several reasonable ways** to do it and the choice deserves a trace;
- checking it **can't be automated** (it will take a person, a screen, a device);
- a conversation just produced **decisions** that no file holds.

The last case is the most frequent and the most expensive: a decision that only lives in a chat
history is a lost decision.

## 2. Where it lives

`docs/specs/<feature>.md` **in the feature's repository**, one file per feature.

**Never a single document that keeps growing**: it becomes impossible to maintain, nobody rereads
it whole, and agents load 90% of irrelevant text on every turn. A spec per feature gets reread,
revised and closed.

What's **cross-cutting** (conventions, API traps, quality checks, caching discipline) doesn't go in
a feature spec: it lives in the project's skills or docs, and the spec **links** to it.

## 3. The template

```markdown
# <Feature name>

> Status: draft | approved | implemented | closed · Decided on <YYYY-MM-DD> by <who>

## The problem
Who runs into what, today, without this feature. In a real situation, not in the abstract.

## What we want
The expected behavior, from the point of view of whoever uses it. No file names here.

## What we DON'T do
The explicit list of nearby things left aside, and why. The cheapest section to write and the
one that makes the most difference.

## Edge cases
What happens when it's empty, when it's too big, when two things happen at once, when the network
lies, when the user does something odd.

## Decisions
Each trade-off settled, dated, with its reason. A decision made by the decision-maker is written
as such: it doesn't need justifying again at the next session.

## Acceptance criteria
Observable facts, numbered (see section 4).

## Contract (if any)
Wire format, saved data layout, public signature. What others will rely on: the part that gets
frozen and versioned.

## Links
The skills, docs and nearby specs involved.
```

The execution plan **doesn't go in there** (see section 5).

## 4. Observable acceptance criteria, and who observes them

A criterion is **checkable or it doesn't exist**. Each one says what is observed **and who observes
it**:

```markdown
1. [test] An order encoded then decoded gives back exactly the same fields.  → tests/test_codec.lua
2. [check] Every UI string is translated in the three overlays.             → /wow-addon-dev:check
3. [human] When the window opens, the column is VISIBLE and readable over the background.
   Known-good control: the column of the previous version. Observer: the developer, in game.
4. [agent] No write into the UI panel system.                                → api-gotcha-reviewer
```

Three traps in this section:

- **"It works" isn't a criterion.** What can be observed is a display, a value, a message, the
  absence of a named error.
- **A `[human]` criterion comes with a known-good control**, or the observer can't tell "it's
  broken" from "it's normal". See the **human-verification** skill.
- **Correctly written data proves nothing.** It proves something is *declared*, never that it
  *works*. A criterion that only looks at an output file is a weak one.

## 5. Spec ≠ plan

| | Spec | Plan |
|---|---|---|
| Answers | **what** and **why** | **how** and **in what order** |
| Lifetime | lives as long as the feature | dies when it's done |
| Content | behaviors, contracts, decisions | tasks, files, sequence, milestones |
| Where | `docs/specs/<feature>.md` | the session's to-do list, or a **dated** "Plan" section |

Mixing them makes a document nobody dares revise: you no longer know whether a line describes a
lasting intent or a step already done. If the plan must be written down, it goes **at the end**,
under a heading that says what it is and its date.

Split the plan into **tasks that each fit in one session**, each with its criterion. Implementing a
whole spec at once produces a big diff nobody really reviews.

## 6. Reread, and have it reread

Three readings, in this order, and none replaces the others:

1. **You**, once it's written: does a reader who wasn't there understand what we want?
2. **An agent**, in a fresh session: it only knows what's written, so what it gets wrong is what's
   badly written. For contradictions inside a corpus: the **docs-consistency-auditor** agent.
3. **The person who decides.** A spec written by a single head keeps that head's blind spots, and
   on product trade-offs **the decision-maker settles, not the agent**.

## 7. After implementation, the spec gets updated

That's the step people skip, and skipping it is paid for in documentation that lies. When the code
departs from the spec, **only two outcomes**: the code was right (the spec gets corrected, with the
date), or the spec was right (it's a defect, and it gets written down). "We'll see later" isn't an
outcome.

At the end of the work: run the **spec-updater** agent on the diff. It says what the diff made
wrong in the specs, docs and skills, which is exactly what drifts silently.

## 8. The four ways to get a spec wrong

1. **Over-specifying**: describing the implementation. You get code written in prose, twice as
   costly to maintain, and it rules out a better solution.
2. **Under-specifying**: "add a notification system". Each reader understands something else, and
   what comes out is nobody's.
3. **Random level of detail**: the detail is set by **risk**. What breaks clients already deployed
   or loses data gets specified finely; the rest, in broad strokes.
4. **Letting it rot**: a spec that didn't follow the code is worse than no spec, because people
   believe it. A dated status header, kept current, costs one line.
