# 05 — Eval-driven prompt iteration

*Industry name(s): "evals," "eval-driven development," "golden set,"
"regression suite," "LLM-as-judge." Type label: Industry standard.*

> **Seam, not present.** flattr runs no LLM, so it has no eval set for one.
> But it has the *exact substrate*: `features/routing/fixtures.ts` is a set
> of hand-built graphs with known-correct answers (`diamondGraph()` comments
> "Known: shortest S->G = S,A,G (200)"). That is a golden set. This file
> teaches eval-driven iteration by showing how flattr's fixtures become a
> prompt eval set.

## Zoom out — where evals sit in the iteration loop

An eval set is the thing that turns "this prompt feels better" into "this
prompt scores 0.91, up from 0.87, no regressions." It sits between you and the
prompt, gating every change. flattr already has the gate — for the router.

```
  Zoom out — the eval gate, already present for the router

  ┌─ source ─────────────────────────────────────────────────────────┐
  │  astar.ts, summary.ts        prompts/describe-route.md (future)   │
  └───────────────┬───────────────────────────┬──────────────────────┘
                 │ gated by                   │ would be gated by
  ┌─ eval gate ──▼───────────────────────────▼──────────────────────┐
  │  fixtures.ts (EXISTS): diamond/grade/directional graphs           │
  │    + *.test.ts assert known-correct paths                        │
  │  ★ FUTURE: same fixtures → expected route descriptions ★         │
  └──────────────────────────────────────────────────────────────────┘
```

flattr's router is already eval-gated. A prompt would join the same gate.

## Zoom in

The pattern: **write the eval before you touch the prompt; iterate by running
the eval, diffing outputs, and keeping a change only if the score improves
with no regression on any tracked case.** The dividing line between junior and
senior prompt work is exactly here. A junior iterates by vibes. A senior
iterates against a set.

## The structure pass

**Layers:** golden set → regression suite → judge.
**Axis:** *measurability* — is "better" a number or a feeling?
**Seam:** the change-decision boundary — the moment you decide to keep or
revert a prompt edit. With evals it's a number; without, it's a vibe.

```
  axis = "is 'better' measurable here?"

  ┌─ no eval ─────┐ measurable: NO — "feels better" (junior)
  │  ── seam ──      ◄── this is the line that defines seniority
  └─ eval set ────┘ measurable: YES — score 0.87 → 0.91, 0 regressions
```

## How it works

### Move 1 — the mental model

You already do test-driven development. You write the failing test, then the
code, then you trust the green. An eval is a test for non-deterministic output:
you can't assert `output === expected` because the model phrases things
differently each run, so you assert `score(output) >= threshold` or
`judge(output, expected) == pass`. flattr's `fixtures.ts` + `*.test.ts` is
already TDD for the router — `diamondGraph()` has a *known* answer and the test
asserts it. The eval set is that, with a fuzzier assertion at the end.

```
  Pattern — the eval loop (write set FIRST, then iterate)

  ┌──────────────────────────────────────────────────────┐
  │ 1. write golden set  (BEFORE touching the prompt)    │
  │ 2. change prompt                                      │
  │ 3. run set ──► scores + per-case diff                │
  │ 4. improved AND no regression? ──► keep              │
  │    regressed any case?         ──► revert            │
  └────────────────────────┬─────────────────────────────┘
                           └──► add prod failures back as cases, forever
```

### Move 2 — building the eval set from flattr's fixtures

**Step 1 — the golden set: hand-curated cases with expected outputs.**
flattr's fixtures *are* this, structurally. Look at the real one:

```ts
// features/routing/fixtures.ts:42-65 — EXISTS
/** 6-node graph... Known: shortest S->G = S,A,G (200). */
export function diamondGraph(): Graph { ... }

// features/routing/fixtures.ts:67-83 — EXISTS
/** Flat-vs-steep choice. Short path via H is steep; long path via L is flat. */
export function gradeGraph(): Graph { ... }
```

Each fixture has a known-correct outcome in its doc comment. For a Seam 1
prompt eval, you pair each fixture's `RouteSummary` with its *expected
description*:

```
  // FUTURE — prompts/describe-route.eval.ts
  cases = [
    { summary: {distanceM:200, climbM:0,  steepCount:0}, expect: "flat, no climbs" },
    { summary: {distanceM:320, climbM:0,  steepCount:0}, expect: "flat" },         // gradeGraph flat route
    { summary: {distanceM:200, climbM:9,  steepCount:1}, expect: "1 steep block, mention it" },
  ]
```

20–50 of these, hand-curated. The flat-vs-steep fixture is gold: it forces the
prompt to be *honest about steepness*, which is flattr's whole product
promise — a description that says "flat all the way" when there's a steep
block is the worst possible failure.

**Step 2 — the regression suite: prod failures, added back forever.** When a
user reports "it said flat but my legs disagree," that exact `RouteSummary`
becomes case #51, and it stays in the set forever. flattr already has this
instinct — the `directionalGraph()` fixture exists because directional grade
is a subtle bug class someone had to pin down. Same move.

**Step 3 — the iteration loop, gated.** Change prompt → run all cases → diff.
The trap this catches:

```
  Execution trace — why "average improved" is not enough

  prompt v1:  honest=0.80  concise=0.70  steep-honesty=1.00  avg=0.83
  prompt v2:  honest=0.85  concise=0.95  steep-honesty=0.60  avg=0.80
                                          ▲
              avg LOOKS comparable, but steep-honesty CRATERED.
              v2 calls steep routes "flat" 40% of the time.
              SHIP v2 on average score → ship the worst bug.
```

This is the specific bug the spec names: a "better" prompt that improves the
average but regresses a critical edge case nobody tracked. The fix is
per-case tracking, not an average — exactly why flattr's fixtures are
*separate named graphs*, not one blended benchmark.

```
  Layers-and-hops — the eval gate in CI (reuses vitest)

  ┌─ prompt PR ──┐ change describe-route.md
  │              │ ──► CI runs describe-route.eval.ts ──┐
  └──────────────┘                                       ▼
  ┌─ eval runner (extends vitest) ──────────────────────────────┐
  │ for each fixture-derived case: model → score vs expected     │
  │ any case regressed? ──► fail the PR                          │
  └─────────────────────────────────────────────────────────────┘
```

**Step 4 — when LLM-as-judge is appropriate.** For "is this description
honest and concise?" you can't string-match — phrasing varies. Use a second
LLM call with a rubric to score it. Appropriate when the quality is
subjective; *not* appropriate for `steepCount` honesty, which you can check
mechanically (does the description mention steepness iff `steepCount > 0`?).
Mechanical check where you can, judge only where you must.

### Move 2 variant — load-bearing skeleton

Kernel: **golden set + per-case (not averaged) scoring**. What breaks:

- **No golden set** → you iterate by vibes, in circles, and "fix" regressions
  you can't see. *Load-bearing.*
- **Average instead of per-case** → you ship the steep-honesty regression
  above. *Load-bearing — this is THE prompt-eval trap.*
- **No regression suite** → you re-introduce fixed bugs. *Load-bearing over
  time.*
- **LLM-as-judge everywhere** → slow, expensive, and the judge has the same
  blind spots; use mechanical checks where possible. *Hardening discipline.*

### Move 3 — the principle

You write the eval before iterating the prompt, for the same reason you write
the test before the code: without it, "better" is a feeling, and feelings
regress critical edge cases silently. flattr's fixtures already prove the
team believes this — for the router. The prompt deserves the same gate.

## Primary diagram

```
  Eval-driven prompt iteration on flattr's fixtures (FUTURE)

  ┌─ golden set (from fixtures.ts) ─────────────────────────────────┐
  │ diamond → "flat" · grade-flat → "flat" · grade-steep → "1 steep"│
  │ + regression cases from prod, forever                           │
  └───────────────────────────┬─────────────────────────────────────┘
                              ▼ run on every prompt change
  ┌─ per-case scoring (NOT averaged) ───────────────────────────────┐
  │ honest · concise · steep-honesty  ← each tracked separately     │
  │ mechanical check: mentions steep ⟺ steepCount>0                  │
  │ LLM-judge: only the subjective "is it natural" axis             │
  └───────────────────────────┬─────────────────────────────────────┘
                              ▼
  improved AND zero regression → keep · any regression → revert
```

## Elaborate

Hamel Husain's writing is the canonical reference here — "Your AI Product
Needs Evals" is the piece to read, and his point is exactly the per-case-vs-
average trap above. The discipline maps one-to-one onto flattr's existing
`bench/` harness (`bench/run.ts`, `bench/report.ts`), which already measures
the algorithm progression with metrics — an eval set is a `bench/` for prompt
quality. The reader has shipped intent-classifier eval sets in loopd; same
muscle. Read `02-structured-outputs.md` for the mechanical-checkable axis
(schema-fail rate is the easiest eval metric of all) and `03-prompts-as-code.md`
for how the eval gates the prompt PR.

## Interview defense

**Q: "How do you know a prompt change is actually better?"** It scores higher
on a golden set with zero regressions on any tracked case. Not "it feels
better" — that's how you ship a change that lifts the average while cratering
a critical edge case. I track each axis separately for exactly that reason.

```
  avg up, one axis down → DO NOT SHIP
  steep-honesty 1.0 → 0.6 hides under a flat average
```

**Q: "When is LLM-as-judge right?"** Only for subjective axes you can't check
mechanically. flattr's steep-honesty check is mechanical (mention steepness
iff `steepCount>0`) — use code. "Is the sentence natural?" — use a judge with
a rubric. Never judge what you can assert.

Anchor: *"flattr's `fixtures.ts` is already a golden set — `diamondGraph` ships
with its known answer in the doc comment. A prompt eval pairs each fixture's
`RouteSummary` with an expected description. The flat-vs-steep fixture is the
honesty regression guard."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — schema-fail rate, the
  easiest eval metric
- [03-prompts-as-code.md](03-prompts-as-code.md) — the eval gates the PR
- [10-self-critique.md](10-self-critique.md) — self-critique vs a real eval
- `.aipe/study-testing/` — the fixtures + bench harness in depth
</content>
