# Eval methods — exact-match, rubric, LLM-as-judge

**Industry name(s):** scoring methods / eval metrics.
**Type:** Industry standard (study material).

## Zoom out — flattr scores by exact-match, the strongest method it can use

You've shipped the *best* eval method for the outputs flattr produces:
exact-match. When the correct answer is a number or a path, `===` is
unambiguous, fast, and free — there's no judge to bias and no rubric to
argue about. flattr earns this because its engine is deterministic. The
catch is that exact-match only works when there's *one* right answer.
Prose has many, so a route-describe feature would force a softer method:
rubric scoring, and at scale, an LLM-as-judge. This file is about
choosing the method, not the set.

```
  Zoom out — eval methods by output type in flattr

  ┌─ Engine output ─────────────────────────────────────────┐
  │  routeSummary() {distanceM, climbM, steepCount}         │
  │  directedAstar() path.cost                              │
  └────────────────────────────┬─────────────────────────────┘
              one correct answer → EXACT-MATCH (===)
  ┌─ Eval method TODAY ────────▼─────────────────────────────┐
  │  Vitest expect(x).toBe(y)  — exact, deterministic        │
  └────────────────────────────┬─────────────────────────────┘
              ★ prose has MANY correct answers
  ┌─ (future) describe output ─▼─────────────────────────────┐
  │  RUBRIC (criteria) → at scale, LLM-AS-JUDGE              │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** engine → eval method → (future) prose method.
- **Axis — answer cardinality:** exact-match works at *one* correct
  answer; rubric and judge methods are for *many* acceptable answers. As
  you move from a float to a sentence, cardinality explodes and the
  method softens.
- **Seam:** `cost.ts:16` (`penalty`) is where the method's strictness is
  earned. Because `penalty` is a pure function with a known closed form,
  its test asserts exact equality at boundary points — the strongest
  method. No softer method is needed *because the seam is deterministic*.

## How it works

### Move 1 — the mental model

Three methods sit on a strictness gradient. **Exact-match**: `output ===
expected` — binary, no judgment. **Rubric**: score against a checklist
(did it mention the climb? is it under 20 words? no invented streets?) —
partial credit, human or model applies it. **LLM-as-judge**: a model
reads output + criteria and scores — scales rubric scoring to thousands
of cases, at the cost of the judge's own biases. Use the strictest
method the output allows.

```
  Pattern — strictness gradient

  strict ◄─────────────────────────────────────────► loose
  exact-match        rubric (human)        LLM-as-judge
  one answer         few criteria          many cases, scaled
  free, no bias      slow, subjective      fast, biased
```

### Move 2 — the walkthrough

**flattr's method today — exact-match on a closed form.** `penalty` has
a continuous, piecewise definition (`cost.ts:16`), so its test can pin
exact values at the band boundaries:

```ts
// cost.ts:16 — penalty is a pure closed form, so === is valid
export function penalty(g, max, k1 = DEFAULT_K1, k2 = DEFAULT_K2) {
  if (g <= 0) return 0;          // ← test: penalty(-1, 10) === 0
  if (g > max) return BLOCKED;   // ← test: penalty(11, 10) === 1e9
  ...
}
```

The continuity-at-`0.5*max` invariant (commented "Continuous at the
0.5*max boundary by construction") is *exactly* the kind of property
exact-match nails: assert the two branches agree at the boundary.

**Why exact-match is right here, not lazy.** A route cost is a single
number; A* admissibility *requires* `penalty ≥ 0` and monotone
(`cost.ts:16` enforces both). Those are hard equalities — softening them
to a rubric would hide bugs. The method is strict because the property
is strict.

**Where the method has to soften — describe prose.** Turn
`{distanceM:900, climbM:40, steepCount:3}` into a sentence and there's no
single gold string. You score with a rubric:

```
  RUBRIC for route-describe output
  [ ] mentions steepCount accurately (3 → "three steep")   2 pts
  [ ] states the climb direction (uphill)                  1 pt
  [ ] under 25 words                                       1 pt
  [ ] no street name not in the input (no hallucination)   2 pts
```

A human applies this for 20 cases; an LLM-as-judge applies it for 2000.

### Move 3 — the principle

Pick the strictest method the output supports. flattr's deterministic
engine supports the strictest possible — exact-match — so use it, and
don't reach for a judge you don't need. Softer methods (rubric, judge)
are a *tax* you pay only when the output's cardinality forces it. The
mistake is using an LLM-as-judge on something `===` could have decided.

## Primary diagram

```
  Methods mapped onto flattr's two outputs

  ┌─ NUMBER output (today) ─────────────────────────────────┐
  │  penalty(), path.cost, RouteSummary                     │
  │  method: EXACT-MATCH  expect(x).toBe(y)   ✔ strongest    │
  └──────────────────────────────────────────────────────────┘
  ┌─ PROSE output (future describe) ────────────────────────┐
  │  "Mostly flat, one steep block"                         │
  │  method: RUBRIC → LLM-AS-JUDGE at scale   (next file)   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

There's a middle method worth knowing for prose that flattr would reach
for before a full judge: **structural assertions** — cheap exact-ish
checks on prose (regex that the climb number appears, a word-count cap, a
"no street name outside the input" check). These are deterministic,
free, and catch the worst failures (hallucinated numbers, runaway
length) without a model. The right order is: structural assertions first,
rubric for quality, LLM-as-judge only when the case count makes human
rubric scoring impractical.

## Project exercises

### B5-EVAL.3 — structural assertions for describe output

- **Exercise ID:** B5-EVAL.3
- **What to build:** deterministic checks on route-describe prose — the
  `climbM` and `steepCount` numbers appear verbatim, output ≤ 25 words,
  no digit not derivable from the `RouteSummary`.
- **Why it earns its place:** it catches hallucinated numbers with `===`
  speed before any judge is involved — the cheapest, strictest layer.
- **Files to touch:** new `features/routing/describe.test.ts`, reuse
  `RouteSummary` from `summary.ts:5`.
- **Done when:** a describe output that invents a climb number fails
  the test without an LLM in the loop.
- **Estimated effort:** 1–2 hrs.

### B5-EVAL.4 — pin penalty continuity as an exact-match invariant

- **Exercise ID:** B5-EVAL.4
- **What to build:** a test asserting `penalty` is continuous at
  `0.5*max` (both branches agree to floating tolerance) and monotone
  non-decreasing across a sweep of `g`.
- **Why it earns its place:** it converts the "continuous by
  construction" comment in `cost.ts:13` into a guarded property — the
  A*-admissibility precondition.
- **Files to touch:** `features/routing/cost.test.ts` (extend).
- **Done when:** lowering `DEFAULT_K2` to break monotonicity fails.
- **Estimated effort:** 1 hr.

## Interview defense

**Q: how do you eval flattr's routing — and why no LLM-as-judge?**
Answer: exact-match, because the outputs are single correct numbers. A
route cost and `RouteSummary`'s three fields have one right value, so
`expect(x).toBe(y)` is unambiguous and free — and `penalty`'s
admissibility invariants (`≥0`, monotone, continuous at `0.5*max`,
`cost.ts:16`) are hard equalities that a softer method would hide. An
LLM-as-judge only earns its place when the output has *many* acceptable
forms — prose from a future route-describe feature. Load-bearing point:
use the strictest method the output's cardinality allows; the judge is a
tax, not a default.

```
  one correct answer → exact-match
  many correct answers → rubric → judge (only then)
```

Anchor: *"flattr can use the strongest eval method there is, because its
engine is deterministic — the judge waits for prose."*

## See also

- [01-eval-set-types.md](01-eval-set-types.md) — the sets these methods score.
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — what breaks when the judge is a model.
- [04-llm-observability.md](04-llm-observability.md) — measuring the eval run itself.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — adversarial cases the rubric must score.
