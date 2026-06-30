# Model selection — LR vs GBT, and why MONOTONIC matters for A*

**Industry name(s):** model selection / model class choice. **Type:**
Industry standard decision (usually under-thought, over-fancy).

## Zoom out — the model that replaces `penalty()` inherits an A* contract

If a learned cost lands behind `penalty()`, you pick a model class. The
usual answer — "throw a gradient-boosted tree at it" — is half right.
flattr adds a constraint most picks ignore: the cost must be **monotone
in grade** (steeper never costs less) and **≥ 0**, or A*'s haversine
heuristic stops being a lower bound and the search returns wrong paths.
That constraint shapes the model choice, not just the deploy.

```
  Zoom out — model class sits at the train step, but the constraint
  comes from A* downstream

  features ──► [ MODEL CLASS ] ──► penalty() ──► A* relaxation
                  │  LR?  GBT?                    (astar.ts:68)
                  ▼                               needs cost ≥0
            must be monotone↑ in grade            & monotone for
            & output ≥0                           admissibility
```

The arrow back from A* is the point: the model can't be chosen on
accuracy alone. It has to be a class that can be *constrained*.

## Structure pass

- **Layers:** candidate classes (linear, monotone GBT, plain GBT, NN) →
  constraint filter (monotone + ≥0) → simplicity tiebreak → measured pick.
- **Axis — expressiveness vs constraint-ability.** A plain neural net is
  expressive but hard to guarantee monotone. A linear model is trivially
  monotone (just constrain the grade coefficient ≥ 0) but can't bend. A
  monotonic GBT sits in the middle and is the interesting answer here.
- **Seam:** `penalty()` (cost.ts:16). Whatever model you pick serves
  behind this signature and must satisfy its two invariants.

## How it works

### Move 1 — the mental model

Model selection is a constraint-satisfaction problem before it's an
accuracy contest. Start from the must-haves, filter, *then* compare what
survives — and prefer the simplest survivor unless a fancier one earns
its complexity with a measured win on the held-out user.

```
  Pattern — filter by constraint, then prefer simple

  candidates ──► keep only {monotone↑ grade, output ≥0}
                   │
                   ▼
            linear (constrain coef ≥0)   ← simplest survivor
            monotone GBT                 ← if linear underfits
                   │
                   ▼
            pick simplest unless val gain is real
```

### Move 2 — the walkthrough

**Sub-step A — linear regression (LR): the baseline that's already monotone.**

```
  LR — cost = w0 + w_grade·grade + w_len·len + …
  monotone in grade  ⇔  w_grade ≥ 0  (constrain it)
  output ≥0          ⇔  clamp max(0, ·) at the end
  pros: tiny, fast, interpretable, fits in A*'s hot loop
  cons: straight line — can't do "flat free, steep punished hard"
```

Notice: `penalty()` *today* is a piecewise function — linear in the
moderate band, quadratic when steep (cost.ts:20-21). A pure LR can't
reproduce that curve. So LR is the baseline, not necessarily the winner.

**Sub-step B — monotonic gradient-boosted trees (GBT): the right kind of fancy.**

```
  Monotonic GBT — boosted trees with a per-feature constraint

  constraint: ∂cost/∂grade ≥ 0  enforced at every split
  → tree can bend the curve (flat→linear→quadratic shape)
  → but can NEVER make steeper cheaper (admissibility safe)
  libs: XGBoost/LightGBM both support monotone_constraints
```

This is the key insight for flattr: a *monotonic* GBT can learn the
flat/moderate/steep shape `penalty()` hand-codes, while a *plain* GBT
can't be trusted — a single bad split could make a 9% grade cost less
than 8%, breaking the heuristic's lower-bound guarantee. The monotone
constraint is not optional polish; it's what makes the model legal in A*.

**Sub-step C — what NOT to pick, and why.**

```
  Rejected for flattr's cost

  plain GBT / random forest  non-monotone → can break admissibility
  neural net                 hard to constrain monotone + overkill
                             for a few features + heavier on-device
  deep model of any kind     no data volume to justify, see cold-start
```

### Move 3 — the principle

Pick the simplest model that satisfies the hard constraints and clears
the held-out bar. For flattr the constraint (monotone, non-negative) is
load-bearing, so the real choice is between a constrained linear model
and a *monotonic* GBT — and you only graduate to the GBT if the linear
fit demonstrably underfits the flat/steep curve on a held-out user. The
constraint does more work than the accuracy here.

## Primary diagram

```
  Model selection for flattr's learned cost (no model exists)

  ┌─ candidates ──────────────────────────────────┐
  │ LR · monotone GBT · plain GBT · NN             │
  └──────────────┬─────────────────────────────────┘
  ┌─ HARD filter: monotone↑ grade & output ≥0 ────▼┐
  │ keep: LR(constrained), monotone GBT            │
  │ drop: plain GBT, NN                            │
  └──────────────┬─────────────────────────────────┘
  ┌─ simplicity tiebreak ─▼───────────────────────┐
  │ LR unless it can't bend the flat/steep curve   │
  └──────────────┬─────────────────────────────────┘
  ┌─ serve ─▼─────────────────────────────────────┐
  │ penalty() body  [cost.ts:16], clamp ≥0, cap    │
  └────────────────────────────────────────────────┘
```

## Elaborate

There's a deep reason the current `penalty()` is a good baseline to beat:
it's already a *constrained, monotone, finite* function — it satisfies
the invariants by construction (downhill→0, over-max→finite BLOCKED). A
learned model has to re-earn those properties that the hand-tuned version
gets for free. That's the trade: the model might fit individual users
better, but it gives up the guarantees you'd then have to bolt back on
with monotone constraints and output clamps. If the data ever justifies
it, the monotonic GBT is the move — it's the smallest model that bends
the curve while staying legal.

## Project exercises

### MODEL.1 — monotone constraint property test

- **Exercise ID:** MODEL.1
- **What to build:** a property test that, for any candidate cost function
  (hand-tuned or learned), asserts cost is non-decreasing in grade across
  the full `[0, userMax]` range and never negative — the A* legality
  check any model must pass.
- **Why it earns its place:** it turns "monotone & ≥0" from a slogan into
  an executable gate that fails a non-monotone model before it ships.
- **Files to touch:** `features/routing/cost.test.ts` (add the property
  test against `penalty`), new `features/routing/cost-legal.ts` (a
  `assertMonotoneNonNeg(fn)` helper a learned model would also run).
- **Done when:** the test passes for `penalty` and fails for a
  deliberately non-monotone stub.
- **Estimated effort:** half a day.

## Interview defense

**Q: You'd learn the routing cost — which model class, and why not just a
neural net?** Answer: a constrained linear model first, a *monotonic*
gradient-boosted tree if it underfits. The binding constraint isn't
accuracy, it's that the cost must be monotone increasing in grade and
non-negative, or A*'s haversine heuristic stops being a lower bound and
the search returns wrong paths. A plain GBT or a neural net can fit
better but can't be trusted monotone; a monotonic GBT learns the
flat/steep curve while staying admissible. Prefer the simplest survivor.

```
  monotone GBT: can bend the curve, can NEVER make steeper cheaper
  plain GBT:    one bad split → 9% cheaper than 8% → A* breaks
```

Anchor: *"the model serves inside A*, so monotone-in-grade isn't a
nice-to-have — it's the difference between optimal and wrong paths."*

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the deploy contract in full.
- [02-feature-engineering.md](02-feature-engineering.md) — which features need scaling per model.
- [12-on-device-inference.md](12-on-device-inference.md) — the model must fit in A*'s hot loop.
- [09-calibration.md](09-calibration.md) — getting the cost *scale* right after the class is chosen.
