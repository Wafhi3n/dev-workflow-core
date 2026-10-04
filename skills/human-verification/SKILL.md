---
name: human-verification
description: "Get a person to check what an agent can't observe itself, without wasting their time. Use as soon as a check depends on something invisible from the terminal: what shows on screen in a game or a UI, how a 3D model renders, a sound, how a physical device behaves, an action behind an interactive login, or any command the agent isn't allowed to run. Use it too when about to write \"not verified\" in a report, when someone asks \"can you test this?\", or when tempted to conclude a change works because the files and logs are right. Gives the fact that changes the conclusion: correctly written data proves something is *declared*, never that it *works*. Covers the line between what can be automated and what can't, the rules before asking anyone, the format of a test sheet (expected observation, known-good control, interpreted outcomes), how to collect usable feedback, and keeping a log that turns \"not verified\" into a dated fact. Also covers calibrating against ground truth when several fields are candidates (start from a situation where known states coexist on identical objects, keep the field that reproduces the split), and what to do when the person describes what they see and the data says the opposite."
---

# Getting a person to check what you can't observe

## The problem it solves

An agent sees files, databases, processes, logs. It does **not** see what shows on screen, doesn't
hear, doesn't click, and isn't always allowed to run what would be needed.

Without a protocol, one of two things happens, both bad:

1. **The conclusion slides.** "The record is present in the three files" becomes "the item works".
   Those are two different claims: the first says something is *declared*, the second that it
   *works*. Only the second matters to anyone.
2. **"Not verified" settles in.** The note is honest, but with no way to lift it, it stays there
   forever, and nobody knows anymore what is really established.

The protocol makes going to the person **rare, short and conclusive**.

## 1. The dividing line

Set it explicitly, once, for the project at hand.

| Checkable alone | Needs a person |
|---|---|
| Content and shape of files, consistency between sources | Rendering: image, layout, color, 3D model, sound |
| Service state, logs, database | Behavior in use, client-side crashes |
| Automated tests, invariants, types | Ergonomics, "is it playable / readable" |
| What the agent is allowed to run | What takes an account, a right, a piece of hardware |

**The last row is the one most often forgotten.** Check the *privilege level* really required
before promising an operation can be automated: an admin command exposed through an API isn't
necessarily the same as the one available in an interactive session.

## 2. The rules before asking anyone

The person's time is the scarce resource. Seven rules, most important first.

1. **Exhaust what can be automated first.** Never have someone check by hand what a query or a
   search could settle. Every question asked must be one you *couldn't* answer alone.
2. **Hand over a sheet, never "go see if it works".**
3. **Give an *exact* expected observation**: a name, a number, a message. "Does it look right?"
   can't be tested: the answer depends on what the person thinks they should see.
4. **Provide a control**: a known-good item, tested next to the new one. Without a control, a
   failure can't tell "the change is bad" from "the test procedure is bad". This rule makes the
   most difference, and it's the most often left out.
5. **Order by dependency** and say so: if step 2 fails, step 3 can't be interpreted, so stop there
   rather than pile up noise.
6. **Make every failure informative.** Each step lists its possible outcomes and what each one
   proves. A test that only yields "works / doesn't work" is badly written: it takes the same human
   time for far less.
7. **Group the questions and give the duration.** All pending questions go in one session, with an
   estimate at the top of the sheet.

## 3. The format of a sheet

```markdown
# T-00X: <what is tested>

**Estimated time: X minutes.**

## Already checked (the automatable side): don't check again
<table: what, and its state>

## The control
<known-good item, why it's comparable, what its failure would mean>

## Steps
### 1: <precise action>
<exact command or gesture>
| What shows | What it proves |
|---|---|
| <value A> | <conclusion A> |
| <value B> | <conclusion B, often the most instructive> |

→ *If <condition>:* stop here, and why.

## To report
<the strict useful minimum>
```

The "what shows / what it proves" table is the heart of the format. It turns an observation into
information, and it forces you to think *beforehand* about what each outcome means, which often
reveals that the test as imagined told nothing apart.

### Designing a step that decides

The best step is one whose result you **don't know** and where every possible outcome changes what
comes next. Look for the places where two competing hypotheses predict different observations, and
build the step there.

> A real example: two files, one on the server side and one on the client side, held two different
> names for the same identifier. Instead of fixing the gap right away, it was left in place for a
> test: the name actually displayed showed which of the two files is authoritative, a question no
> reading of the code had settled. The fix came after.

A known inconsistency is sometimes a measuring instrument. Don't clean it up by reflex before
asking what it could reveal.

### Calibrating against ground truth: start from the answer

The usual way: measure a state, then reason about what it means. It fails as soon as several fields
are candidates, because a field that *seems* to say the right thing on a single object can't be told
from one that really does.

**Reverse the order.** Have the person build a situation where **several known states coexist on
identical objects**, then look for the field that reproduces the split.

> A real case, 2026-08-30. Six strictly identical levers (same type, same list), three charges
> selected, so on screen **three simultaneous states**: 1-2-3 green, 4 blinking yellow, 5-6 black.
> The question "which field gives a lever's state?" becomes: **which field splits them 3 / 1 / 2?**

What it changes:

- **The answer is on screen before the measurement.** The person reads it out; you no longer try
  to infer it.
- **Elimination is mechanical, not argued.** Any field that doesn't make the split is dropped
  **without discussion**: no "yes, but maybe...".
- **Identical objects neutralize everything else.** What tells them apart can only be the state,
  since nothing else differs.

The conditions: at least two distinct *simultaneous* states, on objects of the **same type**, and a
reading that dumps **all** the fields, not just the suspected ones. Narrowing the reading to the
expected candidates brings back the very hypothesis you wanted to rule out.

Prefer it whenever an "I don't know which of these fields" comes up, before writing any patch on
it.

### When the person and the data disagree, it isn't the person

A person describes what they see; the reading says the opposite. The reflex is to assume an
observation error. **That's almost always wrong.**

In the vast majority of cases, both look at the same thing and both are right, but **not at the
same place**: another object with the same name, another instance, a state older than the reading,
a neighboring field. The useful question is never "who's wrong?" but **"what is each one looking
at?"**.

> Checked three times on 2026-08-29 and 30. All three times, the gap came from the measurement: it
> read a neighboring object, or a field that didn't mean what we thought.

Treat the disagreement as a **fact to explain**, not a dispute to settle. And never ask "are you
sure?": it brings no information and discourages exactly the feedback you depend on.

## 4. Collecting usable feedback

- **Have values copied, not judged.** "The right name" says nothing; the exact string does, and
  often the precise difference is what informs.
- **Error messages in full.** A truncated message costs a round trip.
- **Make "I couldn't do it" explicitly acceptable.** Otherwise you get steps reported as done
  without being done, which is worse than no test at all: it produces false certainty.
- **A screenshot beats a description** for anything visual, and it often holds things you didn't
  think of asking.

## 5. Writing it down

**Nothing is recorded as verified without explicit feedback.** A step with no answer stays "not
tested", never "probably fine".

What goes in, once the feedback is in:

- the **dated result**, in the sheet and in a central log;
- the **exact scope** of what is proven, and, just as important, what isn't. A test validates a
  precise observation, not a whole category;
- the **revision of any earlier claim** the test contradicts, saying it was wrong rather than
  rewriting it silently.

```markdown
| # | What | Date | Result |
|---|---|---|---|
| T-001 | <what> | YYYY-MM-DD | ✅ conclusive (steps 3 to 6) |
```

### The generalization trap

A successful test is tempted to prove more than it does. Write the narrow scope, even when the
broad one is likely:

> ✅ "The tooltip shows the name from the client file."
> ⛔ "The server file is useless." Not tested anywhere else.

That's what separates a log you can trust from a log that piles up slightly-too-broad conclusions
until one of them breaks.

## 6. What the protocol corrected the first time it was used

Building a sheet forces you to state the exact expected values. That's a stricter exam than it
looks: two claims already written down didn't survive it, **before the test was even run**.

- A process-counting command counted one process too many, unnoticed: the count had never needed
  to be *exact* until then.
- A note claimed an inconsistency was "without effect on the display". Nothing established it: it
  was an assumption that had taken the shape of a fact by being written down.

**Writing the sheet is useful even if the test is never run.** Demanding an exact expected
observation means asking yourself how you know what you think you know.
