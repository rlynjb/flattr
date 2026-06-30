# Calibration — matters when a downstream consumer reads the cost's MAGNITUDE

**Industry name(s):** calibration / probability calibration / score
calibration. **Type:** Industry standard (critical when scores are
consumed, not just ranked).

## Zoom out — A* reads the cost's number, so the cost's SCALE has to mean something

Calibration is making a model's output number trustworthy as a quantity,
not just an ordering. A classifier is calibrated if "0.7" really means 70%
of such cases are positive. flattr has no probabilistic model — but it has
a sharp version of the same concern: A* *sums* edge costs
(`tentative = g + costFn(...)`, astar.ts:68), so the cost's *magnitude* is
load-bearing. A learned cost that's monotone but mis-scaled would route
badly even while ranking edges correctly.

```
  Zoom out — calibration of the cost SCALE, consumed by A*'s sum

  ★ cost.ts penalty() → a number (the cost magnitude)
        │
        ▼ A* relaxation: tentative = g + cost   (astar.ts:68)
          g is a SUM of magnitudes across the path
        │
        ▼ a mis-scaled cost = wrong path, even if ordering is right
  the length multiply (cost.ts:33) is what makes scale matter:
  cost = lengthM · (1 + penalty)  ← penalty trades off against distance
```

The penalty isn't a standalone score; it's *added to and multiplied
against distance*. Get its scale wrong and a short steep edge beats a long
flat one when it shouldn't (or vice versa). That's a calibration problem.

## Structure pass

- **Layers:** raw model output → calibration mapping → consumed quantity
  (here: summed into A*'s path cost).
- **Axis — ranking vs magnitude.** If a consumer only *ranks* (pick the
  cheapest of two), calibration barely matters. If it *sums or thresholds*
  the score, calibration is everything. A* sums — so magnitude matters.
- **Seam:** `penalty()`'s return value and the `1 + penalty` multiply
  (cost.ts:29, 33). That `+1` and the units of `penalty` set the scale at
  which grade trades off against meters.

## How it works

### Move 1 — the mental model

Two models can rank identically yet differ wildly in magnitude. A
ranking-only consumer can't tell them apart; a summing consumer gets very
different answers. A* is a summing consumer: the path it picks depends on
the *total* cost, so each edge cost's scale has to be in honest units
relative to distance.

```
  Pattern — ranking vs magnitude consumers

  model A: costs [1, 2, 3]      same ORDER
  model B: costs [1, 20, 300]   wildly different MAGNITUDE
  ranking consumer: identical choice
  SUMMING consumer (A*): totally different path
  → calibration = making the magnitude mean something
```

### Move 2 — the walkthrough

**Sub-step A — where flattr's scale lives today.**

```
  cost.ts:33 — the scale is the `1 + penalty` multiply

  gradeCostDirected = lengthM · (1 + penalty(grade, max))
                                 │   │
                                 │   └ penalty in "extra cost fraction"
                                 └ baseline: 1× distance
  penalty = 0    → cost = lengthM        (flat = pure distance)
  penalty = 1.0  → cost = 2·lengthM      (this edge "feels" twice as long)
```

The hand-tuned `k1 = 0.4`, `k2 = 1.0` (cost.ts:8) *are* the calibration:
they set how many "extra meters" a percent of grade is worth. A learned
cost must produce a penalty on the *same scale* — "fraction of extra
distance" — or A* will over- or under-weight hills against detours.

**Sub-step B — what mis-calibration looks like in routing.**

```
  Mis-scaled learned cost (monotone but wrong magnitude)

  too HIGH: every hill avoided → absurd 3km detour around a 5% bump
  too LOW:  hills ignored → routes straight up the steepest grade
  ordering is FINE in both → only the MAGNITUDE is wrong
  fix: calibrate penalty to "extra-distance fraction" units
```

**Sub-step C — calibrating, concretely.** You'd fit the learned cost so
its output, plugged into `lengthM · (1 + penalty)`, reproduces real user
willingness-to-detour: if users reliably accept a 200m detour to avoid an
8% grade, the penalty at 8% should make that edge cost ~200m more than the
flat alternative. That's calibrating the *units*, not just the shape.

### Move 3 — the principle

Calibration is about the output *meaning a quantity*. Whether it matters
depends entirely on the consumer: rank-only consumers don't care, summing
or thresholding consumers care a lot. A* sums edge costs, so flattr's
learned penalty must be calibrated to honest "extra-distance" units —
matching the `1 + penalty` scale the hand-tuned `k1`/`k2` already set.
Monotone gets you the right *order*; calibration gets you the right
*trade-off* against distance.

## Primary diagram

```
  Calibration of flattr's cost magnitude (consumed by A*'s sum)

  ┌─ learned penalty (would-be) ──────────────┐
  │ monotone in grade  ✓ (admissibility)       │
  │ but is the MAGNITUDE in distance units?     │
  └───────────────┬─────────────────────────────┘
  ┌─ cost.ts:33 — scale set here ──▼───────────┐
  │ cost = lengthM · (1 + penalty)              │
  │ penalty units = "extra distance fraction"   │
  └───────────────┬─────────────────────────────┘
  ┌─ A* sums it ─▼─────────────────────────────┐
  │ tentative = g + cost  (astar.ts:68)         │
  │ mis-scale → absurd detours or ignored hills │
  └─────────────────────────────────────────────┘
```

## Elaborate

There's a clean reason calibration and the admissibility constraint are
distinct: monotonicity is about *order* (steeper ≥ flatter), calibration
is about *spacing* (how much steeper costs how much more). A model can be
perfectly monotone and perfectly admissible while being badly calibrated —
it'll return *a* valid path, just not the one users would actually choose,
because the hill-vs-detour trade-off is off. The hand-tuned `k1`/`k2`
encode a guess at that spacing; the whole point of learning the cost is to
*calibrate* that spacing to real accept/reroute behavior. So for flattr,
calibration isn't an afterthought — it's the main thing a learned cost
buys you over the formula.

## Project exercises

### CAL.1 — detour-equivalence calibration check

- **Exercise ID:** CAL.1
- **What to build:** a test that, for a given grade, computes the
  "equivalent extra distance" the current `penalty` assigns
  (`lengthM · penalty`) and asserts it lands in a plausible human range
  (e.g., an 8% grade should cost on the order of tens of percent extra,
  not 100×).
- **Why it earns its place:** it operationalizes calibration as
  "magnitude in distance units," the exact thing a learned cost must
  preserve.
- **Files to touch:** `features/routing/cost.test.ts` (add the
  detour-equivalence assertions over `penalty` and `gradeCostDirected`).
- **Done when:** the test pins the extra-distance multiplier at a few grade
  points and would fail a learned cost that's off by an order of magnitude.
- **Estimated effort:** half a day.

## Interview defense

**Q: Does calibration matter for flattr's cost, given there's no
probability?** Answer: yes, because A* *sums* edge costs — the magnitude
is consumed, not just the ranking. A learned penalty could be perfectly
monotone and admissible yet badly calibrated: too high and it routes a 3km
detour around a small bump, too low and it sends users straight up the
steepest hill. The cost has to be in honest "extra-distance" units,
matching the `lengthM · (1 + penalty)` scale the hand-tuned k1/k2 already
set. Monotone fixes order; calibration fixes the hill-vs-detour trade-off.

```
  monotone → right ORDER (admissibility)
  calibrated → right SPACING (hill vs detour trade-off)
  A* sums costs → it needs both
```

Anchor: *"A* reads the cost magnitude via `tentative = g + cost`
(astar.ts:68), so the penalty's scale — not just its order — has to mean
something."*

## See also

- [04-model-selection.md](04-model-selection.md) — monotone gets order; calibration gets spacing.
- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the `1 + penalty` scale in context.
- [08-confusion-matrices.md](08-confusion-matrices.md) — hard-label eval vs score calibration.
