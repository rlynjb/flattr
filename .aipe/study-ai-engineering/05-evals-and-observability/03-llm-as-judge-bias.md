# LLM-as-judge bias — when the scorer is itself a model

**Industry name(s):** LLM-as-judge / model-graded evals / judge bias.
**Type:** Industry standard (study material). **Not present in flattr.**

## Zoom out — flattr's judge is `===`, which has no bias

flattr scores its outputs with exact equality, so there's no judge to be
biased — `1200 === 1200` doesn't have a favorite. This file is study
material for a method flattr **does not use today** and would only adopt
if a route-describe feature shipped and the prose-eval case count grew
past what a human can rubric-score by hand. At that point you'd hand
scoring to a model, and inherit a new failure mode: the *judge itself*
has biases that corrupt the eval. Knowing them is the price of using one.

```
  Zoom out — where a judge would attach (it doesn't today)

  ┌─ Engine (deterministic) ────────────────────────────────┐
  │  RouteSummary numbers — scored by === (no judge, no bias)│
  └────────────────────────────┬─────────────────────────────┘
                  ★ no LLM output → no judge needed
  ┌─ (future) describe prose ──▼─────────────────────────────┐
  │  "Mostly flat, one steep block"                         │
  │      │ scored by a MODEL judge → inherits judge bias     │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** engine (exact-match, no judge) → (future) prose (model
  judge).
- **Axis — judge objectivity:** `===` is perfectly objective. A model
  judge is a *probabilistic, biased* scorer. Moving from numbers to prose
  trades objectivity for the ability to score open-ended text at all.
- **Seam:** the judge would sit on the *output* of a future
  `describe.ts`, reading the prose plus the `RouteSummary` it was built
  from. The `RouteSummary` (from `summary.ts:5`) is the *ground truth*
  the judge checks against — which is the one thing that keeps the judge
  honest: it can verify the numbers even if it's biased about style.

## How it works

### Move 1 — the mental model

An LLM-as-judge is a model you prompt with "here's an output and some
criteria, score it." It scales rubric scoring but carries known biases:
**position bias** (favors whichever candidate is shown first),
**verbosity bias** (longer answers read as better), **self-preference**
(a model rates its own family's outputs higher), and **leniency drift**
(scores creep up over a run). None of these exist in `===`; all of them
appear the moment the scorer is a model.

```
  Pattern — biases a model judge adds that === never had

  position     A-then-B scores ≠ B-then-A → randomize order
  verbosity    longer ⇒ "better" → cap length, score per-criterion
  self-pref    judge favors own family → use a different model
  leniency     scores drift up → re-anchor with known-bad samples
```

### Move 2 — the walkthrough

**What flattr would judge.** A route-describe output for
`{distanceM:900, climbM:40, steepCount:3}` — a sentence. The judge's job
is to score it against the rubric from
[02-eval-methods.md](02-eval-methods.md).

**Why flattr's case is unusually judge-resistant.** The `RouteSummary`
the prose is built from is *deterministic ground truth*:

```ts
// summary.ts:5 — three numbers the judge can check arithmetically
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

So the highest-stakes check — "did the prose state the climb and steep
count correctly?" — is a *number match*, not a style judgment. You hand
that to a structural assertion (no judge), and reserve the model judge
for genuinely subjective criteria (tone, clarity). That shrinks the
judge's surface, and with it the blast radius of judge bias.

**How you'd defend against the biases.** Randomize candidate order
(kills position bias), score each rubric criterion separately rather than
asking for one overall number (blunts verbosity bias), use a different
model family than the one that wrote the prose (kills self-preference),
and seed the judge run with a few known-bad outputs to detect leniency
drift. None of this is needed today because flattr has no judge.

### Move 3 — the principle

A model judge is a measurement instrument with a systematic error.
Minimize what you ask it to judge: anything that reduces to a number
(flattr's `climbM`, `steepCount`) should be checked by `===`, not the
judge, so the judge only rules on the irreducibly subjective. The less
the judge decides, the less its bias can corrupt the eval.

## Primary diagram

```
  Shrinking the judge's surface with flattr's ground truth

  ┌─ describe prose ────────────────────────────────────────┐
  │  "Mostly flat, three steep blocks, 40m climb"           │
  └───────────┬───────────────────────────┬─────────────────┘
   numeric claims │                        │ subjective claims
   (climb=40,steep=3)│                     │ (tone, clarity)
  ┌─ check by === ▼──────────┐   ┌─ judge by MODEL ▼────────┐
  │ vs RouteSummary (truth)  │   │ biased; randomize order, │
  │ NO judge, NO bias        │   │ per-criterion, diff model│
  └──────────────────────────┘   └──────────────────────────┘
```

## Elaborate

The deepest defense against judge bias is to need the judge less, and
flattr's architecture hands you that for free: its AI feature's facts are
all engine-computed numbers. Contrast a pure-summarization task where
*everything* is subjective — there, the judge decides everything and its
bias dominates. flattr's route-describe would be the *easy* case for
model-graded eval precisely because the ground truth (`RouteSummary`)
sits right next to the prose. Lean on that.

## Project exercises

### B5-EVAL.5 — split numeric checks from the judge

- **Exercise ID:** B5-EVAL.5
- **What to build:** a two-stage describe-eval: stage 1 asserts (with
  `===`) that the prose's numbers match the source `RouteSummary`; stage
  2 hands only tone/clarity to a model judge.
- **Why it earns its place:** it keeps the high-stakes facts out of the
  biased judge's reach, shrinking bias blast radius.
- **Files to touch:** new `features/routing/describe.eval.ts`, reuse
  `RouteSummary` from `summary.ts:5`.
- **Done when:** a prose output with a wrong `climbM` fails in stage 1,
  never reaching the judge.
- **Estimated effort:** 2–3 hrs (depends on a describe feature existing).

### B5-EVAL.6 — position-bias smoke test

- **Exercise ID:** B5-EVAL.6
- **What to build:** an offline harness that scores the same two describe
  candidates in both orders and flags when the winner flips.
- **Why it earns its place:** it makes position bias *visible* before you
  trust the judge's rankings.
- **Files to touch:** new `features/routing/describe.judge.test.ts`.
- **Done when:** a flip between orderings fails the test.
- **Estimated effort:** 2 hrs.

## Interview defense

**Q: would you trust an LLM to grade flattr's route descriptions?**
Answer: only for the subjective part, and never for the numbers. The
prose is built from `RouteSummary` (`summary.ts:5`), which is
deterministic ground truth — so "did it state the climb and steep count
correctly?" is an `===` check, no judge. I'd reserve the model judge for
tone and clarity, then defend against its biases: randomize candidate
order (position bias), score per-criterion (verbosity bias), use a
different model family (self-preference). Load-bearing point: a model
judge is a biased instrument, so minimize what it's allowed to decide —
flattr's architecture makes that easy because the facts are numbers.

```
  numbers → === (no bias)   |   tone → model judge (defend biases)
```

Anchor: *"flattr has no judge today because `===` needs none; if one
ever ships, the `RouteSummary` ground truth keeps it honest about the
facts."*

## See also

- [02-eval-methods.md](02-eval-methods.md) — where the judge sits on the strictness gradient.
- [01-eval-set-types.md](01-eval-set-types.md) — the rubric set the judge would score.
- [04-llm-observability.md](04-llm-observability.md) — logging the judge's calls.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — a hostile label can attack the judge's prompt too.
