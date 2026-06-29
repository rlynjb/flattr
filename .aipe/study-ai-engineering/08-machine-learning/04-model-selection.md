# Model Selection

*Industry name: model selection — choosing a model class from problem + constraints.*

## Zoom out

```
PROBLEM SHAPE + CONSTRAINTS  ──►  MODEL CLASS
                                  ┌─────────────────────┐
"predict a non-negative,          │ isotonic regression │
 monotone-in-grade cost"          │ monotone GBM        │
                                  │ NOT a free NN       │
                                  └─────────────────────┘
```

Model selection is *not* "try every model, pick the most accurate." It's: read your
constraints first, and let them **delete** the model classes that can't satisfy them.
flattr is the textbook case where the constraints are so sharp they nearly pick the model
for you. New ground — contrl handed you a fixed architecture (MediaPipe), so you never
chose a class.

## How it works

### Move 1 — the mental model: constraints prune the menu

```
ALL MODELS                      AFTER flattr's INVARIANTS
┌──────────────────────┐        ┌──────────────────────┐
│ linear  trees  GBM   │        │  isotonic regression │
│ kNN  NN  transformer │  ───►  │  monotone-constr. GBM │
│ random forest ...    │        └──────────────────────┘
└──────────────────────┘         (everything else violates ≥0 / monotone)
```

You don't pick by accuracy first. You pick by *which models can even be legal*, then by
accuracy among the survivors.

### Move 2 — apply flattr's two hard invariants

Read `features/routing/cost.ts`. A learned cost would replace `penalty(g, max)`. A* (in
`astar.ts`, with `haversineHeuristic`) requires:

1. **Non-negativity.** Every edge cost ≥ 0, or the heuristic stops being admissible and
   A* can return a wrong path. → The model's output must be **clamped/guaranteed ≥ 0**. A
   free regressor can emit negatives; you'd need an output transform (`softplus`, `relu`)
   *or* a class that can't go negative.
2. **Monotonicity in steepness.** A steeper uphill must never cost *less* than a gentler
   one — otherwise the optimizer routes you up a wall. A free neural net learns whatever
   wiggles fit the noise; it can be non-monotone. You need a class that **bakes in
   monotonicity**:

```
ISOTONIC REGRESSION              MONOTONE-CONSTRAINED GBM
cost                              cost
 │        ___/                     │      ___/‾
 │    ___/                         │   __/
 │__/   step-monotone fit         │_/    smooth, monotone by constraint
 └──────── grade →                └──────── grade →
   (free, 1-D, provably ↑)          (multi-feature, ↑ enforced per split)
```

- **Isotonic regression**: fits a free, piecewise-constant *monotone* curve to 1 feature
  (grade → cost). Dead simple, provably monotone, ≥0 if you clamp. Great first model.
- **Monotone-constrained GBM** (XGBoost/LightGBM `monotone_constraints`): multi-feature
  (`grade`, `length`, `kind`), still enforces "↑ in grade" per tree split. The realistic
  choice if you want more than grade.

3. **BLOCKED stays large-finite.** Over `max`, `cost.ts` returns `BLOCKED = 1e9`, *not*
   `Infinity` (spec §14.4) — so an only-steep path is still returned and flagged. A learned
   model must reproduce this: saturate to a big finite cap, never emit `Infinity`/`NaN`.

### Move 3 — the principle

**The right model is the simplest one that can't break your invariants.** A free NN is
more expressive *and disqualified* — it can violate monotonicity and non-negativity. Start
with isotonic; escalate to monotone GBM only if features beyond grade earn their keep.

## In this codebase

**NOT YET EXERCISED — `cost.ts` is hand-coded, no model is selected.** But this is THE
real attach point, and the invariants above are not hypothetical: they're enforced today by
the shape of `penalty()` (returns 0 for downhill, never negative; returns finite BLOCKED,
never `Infinity`). Any learned replacement inherits both.

`features/grade/classify.ts` is sometimes mistaken for a model to "select" — it isn't.
It's a threshold table; there's no model class behind it, learned or otherwise.

## See also

- `02-feature-engineering.md` — the features a monotone GBM would consume
- `09-calibration.md` — if the model emits probabilities instead of raw cost
- `08-confusion-matrices.md` — why a regression cost isn't scored like a classifier
</content>
