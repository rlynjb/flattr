# Eval set types — golden, adversarial, regression

**Industry name(s):** eval sets / golden datasets / regression suites.
**Type:** Industry standard (study material).

## Zoom out — flattr already has two of the three eval sets, in `*.test.ts`

You've shipped evals for graph math without calling them that. flattr's
`*.test.ts` files are a **golden set** (known input → known correct
output) *and* a **regression set** (they re-run on every change to catch
drift). What flattr does **not** have is an LLM, so it has no **rubric
set** — the eval type you need when the output is prose, not a number.
The day a route-describe feature ships, you add that third set; the seam
is a list of `RouteSummary → expected-prose` pairs.

```
  Zoom out — where eval sets sit in flattr

  ┌─ Core engine (features/routing/) ───────────────────────┐
  │  routeSummary() → {distanceM, climbM, steepCount}       │
  │  penalty(), directedAstar() — deterministic graph math  │
  └────────────────────────────┬─────────────────────────────┘
                  exact, repeatable outputs
  ┌─ Eval layer (TODAY) ───────▼─────────────────────────────┐
  │  *.test.ts via Vitest  → GOLDEN + REGRESSION sets        │
  │  bench/run.ts          → algorithm-progression harness   │
  └────────────────────────────┬─────────────────────────────┘
                  ★ no LLM → no RUBRIC set exists
  ┌─ (future) route-describe ──▼─────────────────────────────┐
  │  RouteSummary → prose → needs a RUBRIC/golden-prose set  │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** engine (deterministic math) → eval layer (`*.test.ts`,
  `bench/`) → (future) prose layer.
- **Axis — output determinism:** flattr's outputs are *exact* (a float, a
  count, a path). Exact outputs let golden + regression sets use
  equality. Prose is *non-deterministic* — equality breaks, so you need a
  rubric set scored by a judge, not `===`.
- **Seam:** the eval set's natural home is wherever the output is
  produced. `summary.ts:11` (`routeSummary`) is the seam: today its
  output is asserted by exact-match tests; a route-describe feature would
  consume the *same* `RouteSummary` and need a *new* rubric set keyed by
  it.

## How it works

### Move 1 — the mental model

Three eval sets answer three different questions. A **golden set** asks
"is this output correct?" (curated input/output pairs you trust). A
**regression set** asks "did a change break something that used to
work?" (the golden set, re-run on every commit, plus past-bug fixtures).
An **adversarial set** asks "what makes this fall over?" (hostile,
boundary, and edge inputs). For deterministic math all three can use
exact-match; for prose only the regression *mechanism* survives — the
scoring switches to a rubric.

```
  Pattern — three eval sets, three questions

  golden       "is it correct?"      curated good pairs
  regression   "did we break it?"    golden + past bugs, on every commit
  adversarial  "where does it break?" hostile / boundary inputs
        │
        ▼ for prose, ADD:
  rubric       "is it good prose?"   criteria scored by a judge
```

### Move 2 — the walkthrough

**flattr's golden set — `bench/run.ts`'s fixed pairs.** The benchmark
runner pins exact start/goal pairs on a deterministic grid:

```ts
// bench/run.ts — INTERIOR pairs only, fixed start/goal
{ name: "grid40 18,18->21,21 (short interior)", start: "18,18", goal: "21,21", size: 40 },
```

Because `makeGridGraph(size)` is deterministic, every algorithm's output
cost is a *known* number — that's a golden pair. The unit tests in
`features/routing/*.test.ts` do the same at finer grain.

**flattr's regression set — `npm test` on every change.** Vitest
re-runs the whole golden suite. `penalty()` (`cost.ts:16`) has a
load-bearing invariant — monotone and `≥0` for A* admissibility — and a
test that asserts it *is* a regression guard: change `DEFAULT_K1` and the
test catches the drift before A* returns a wrong path.

**The set flattr is missing — a rubric set for prose.** `routeSummary`
at `summary.ts:11` returns three numbers. A route-describe feature turns
those into a sentence like *"Mostly flat, one steep block near the end."*
You can't assert that with `===`. The rubric set is a curated list:

```
  RouteSummary {distanceM:1200, climbM:8,  steepCount:0} → "flat, easy"
  RouteSummary {distanceM:900,  climbM:40, steepCount:3} → "hilly, 3 steep stretches"
```

scored against criteria (mentions steep count? names the climb? no
hallucinated streets?), not equality.

### Move 3 — the principle

Match the eval set's *scoring* to the output's *determinism*. flattr's
math is exact, so golden + regression sets use equality and live in
`*.test.ts` — that's correct, not a gap. Prose is non-deterministic, so
it needs a rubric set layered onto the *same* regression mechanism. The
eval-set type is chosen by the output, not by whether an LLM is involved.

## Primary diagram

```
  Three eval sets mapped onto flattr's seams

  ┌─ summary.ts:11  routeSummary() → {3 numbers} ───────────┐
  │                                                          │
  │  GOLDEN      *.test.ts exact-match on known pairs   ✔ today
  │  REGRESSION  npm test re-runs golden + bug fixtures ✔ today
  │  ADVERSARIAL boundary inputs (BLOCKED, no-route)    ~ partial
  │  RUBRIC      RouteSummary → expected-prose pairs    ✗ needs LLM
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The hard part of eval sets is not the mechanism — it's curation. A
golden set is only as good as the pairs you trust, and trust degrades:
an "expected" prose answer that was fine last quarter may read wrong
after a model upgrade. flattr's deterministic golden set never rots (the
grid math doesn't change), which is exactly why graph problems are
*easier* to eval than prose. When you add a rubric set, budget for
ongoing curation — the set is a living artifact, not a fixture.

## Project exercises

### B5-EVAL.1 — write the route-describe golden-prose set

- **Exercise ID:** B5-EVAL.1
- **What to build:** a JSON fixture of 15–20 `RouteSummary → expected
  prose` pairs covering flat, hilly, blocked, and zero-climb cases.
- **Why it earns its place:** it forces you to define what "good" prose
  means *before* writing the feature — the set is the spec.
- **Files to touch:** new `features/routing/describe.fixtures.ts`
  (the pairs), reuse the `RouteSummary` type from `summary.ts:5`.
- **Done when:** every band of `steepCount` (0, 1, many) and the
  no-route case has at least one pair with a hand-written gold answer.
- **Estimated effort:** 2–3 hrs.

### B5-EVAL.2 — promote the bench pairs into a regression assertion

- **Exercise ID:** B5-EVAL.2
- **What to build:** a `*.test.ts` that pins the exact cost each
  `bench/run.ts` pair returns, so a cost-model change fails CI loudly.
- **Why it earns its place:** the benchmark prints numbers but asserts
  nothing — this turns the golden set into a regression guard.
- **Files to touch:** new `bench/run.test.ts` importing the pairs and
  algorithms from `bench/run.ts`.
- **Done when:** changing `DEFAULT_K1` in `cost.ts:8` fails the new test.
- **Estimated effort:** 1–2 hrs.

## Interview defense

**Q: flattr has no LLM — does it have evals?** Answer: yes, the right
kind for its outputs. `*.test.ts` is a golden set (known input → known
correct output) and a regression set (re-run on every commit), and
`bench/run.ts` pins fixed pairs. Those are exact-match evals, which is
correct for deterministic graph math. The eval type flattr *lacks* is a
rubric set, because there's no prose to score — it'd be added the day a
route-describe feature consumes `RouteSummary` at `summary.ts:11`.
Load-bearing point: the eval-set type is dictated by output determinism,
not by whether a model is in the loop.

```
  deterministic output → golden + regression (===)
  prose output         → add rubric set (judge)
```

Anchor: *"flattr already ships golden and regression sets in `*.test.ts`;
the rubric set is the one piece that waits on an LLM."*

## See also

- [02-eval-methods.md](02-eval-methods.md) — how each set is *scored* (exact-match vs rubric).
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — scoring the rubric set with a model.
- [04-llm-observability.md](04-llm-observability.md) — `bench/report.ts` as the deterministic telemetry analog.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — adversarial inputs the rubric set must include.
