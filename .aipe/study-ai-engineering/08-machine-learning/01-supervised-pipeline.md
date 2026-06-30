# The supervised learning pipeline — and the `cost.ts` learned-cost attach point

**Industry name(s):** supervised learning pipeline (data → features →
split → train → deploy). **Type:** Industry standard.

## Zoom out — flattr trains nothing, but `cost.ts` is where a model would attach

flattr has no trained model, no dataset, no training run. The one place
a supervised model could legitimately attach is the edge-cost function:
`features/routing/cost.ts` `penalty()` is a hand-tuned analytic
function, and "how much does this grade actually cost *this user*" is a
learnable quantity. This file teaches the pipeline as new ground (per
`me.md`, ML beyond contrl is new for you) and anchors the deploy step to
`cost.ts` with its hard A\* constraints.

```
  Zoom out — the supervised pipeline, mapped onto flattr's one ML seam

  Data → Features → Train/Val/Test → Model → Deploy
   │        │            │            │        │
   │        │            │            │        ▼
   │        │            │            │   ★ cost.ts penalty()
   │        │            │            │   learned edge cost
   │        │            │            │   (must stay ≥0, monotone,
   │        │            │            │    over-max → finite BLOCKED)
   ▼        ▼            ▼            ▼
  user    grade,       per-user/    fit k1,k2
  reroute  length,      per-route    or replace
  events   surface      split        penalty()
  (NOT collected)       (NOT done)   (NOT trained)
```

Everything left of "Deploy" is **not built** — there's no data
collection, no features, no split, no training. Only the *deploy slot*
exists, as `penalty()`.

## Structure pass

- **Layers:** data collection → feature engineering → split → training →
  serving (inside A\*).
- **Axis — where does the program come from?** In flattr's deterministic
  code, the program is hand-written (`k1 = 0.4`, `k2 = 1.0` in
  `cost.ts:8`). In supervised ML, **the data is the program** — weights
  are fit, not typed. The axis flips at the train step: from
  author-written to data-fit.
- **Seam:** `cost.ts:16` (`penalty()`). It's the serving boundary — the
  only spot A\* reads a cost. A learned model substitutes here, behind
  the same `(grade, max) → number` signature, *if* it honors the
  invariants.

## How it works

### Move 1 — the mental model

You've trained exactly one model end-to-end (contrl, pose-landmark → rep
counter). The supervised pipeline is that experience generalized: raw
labeled data in, engineered features, a clean train/val/test split, a
fitted model, then deployment. For flattr the "label" would be user
behavior — *did the user accept this route or reroute away from a hill?*

```
  Pattern — five stages, the deploy stage lands in cost.ts

  ┌─ data ─┐  ┌─ features ─┐  ┌─ split ─┐  ┌─ train ─┐  ┌─ deploy ─┐
  │ accept/│→ │ grade,     │→ │ by user │→ │ fit cost│→ │ penalty()│
  │ reroute│  │ length,    │  │ (no leak│  │ model   │  │ in A*    │
  │ events │  │ surface,…  │  │ across) │  │         │  │ cost.ts  │
  └────────┘  └────────────┘  └─────────┘  └─────────┘  └──────────┘
```

### Move 2 — the walkthrough (with the constraint that makes this hard)

**Stage 5 first (it's the only one that exists): the serving slot.**
`cost.ts:16`:

```ts
export function penalty(g: number, max: number, k1 = 0.4, k2 = 1.0): number {
  if (g <= 0) return 0;                      // downhill/flat: free
  if (g > max) return BLOCKED;               // over max: 1e9 (FINITE)
  const half = 0.5 * max;
  if (g <= half) return k1 * g;              // moderate: linear
  return k2 * (g - half) ** 2 + k1 * half;   // steep: quadratic
}
```

A learned model replaces the body — but the signature and two invariants
are non-negotiable:

```
  Layers-and-hops — the learned cost serving inside A*

  ┌─ A* (astar.ts) ─┐ hop1: edge, fromNode, max
  │ g(n)=Σ costs     │ ──────────────────────────►┌─ cost.ts ──────┐
  │ h(n)=haversine   │                            │ gradeCostDirected│
  │       (LOWER bnd)│ ◄───── hop2: cost ─────────│ → penalty()      │
  └──────────────────┘                            │ ★ learned model  │
                                                  └──────────────────┘
  invariant 1: cost ≥ 0  → else h stops being a lower bound, A* wrong
  invariant 2: over-max → finite (not ∞) → else BLOCKED-vs-disconnected
               distinction collapses
```

**Invariant 1 — admissibility.** A\*'s heuristic is the haversine
straight-line distance, a guaranteed *lower bound* on real cost. That
guarantee holds only if every edge cost is ≥ 0. The current `penalty()`
returns 0 for downhill (`g <= 0`) and positive otherwise — always ≥ 0. A
learned model that outputs a negative cost for, say, a gentle downhill
"bonus" would break the lower-bound property and A\* could return a
non-optimal path. **Clamp the learned output to ≥ 0.** This is the
must-not-change constraint from the project's spec §14.

**Invariant 2 — finite BLOCKED.** `cost.ts:5`: `BLOCKED = 1e9`, large
but finite. This keeps "no flat route, here's the flattest steep one"
distinct from "no route at all." A learned cost must map over-max grades
to a huge-but-finite penalty, never `Infinity`, or the flattest-but-steep
fallback collapses into "disconnected."

**Stages 1–4 (all not built).** Data: log accept/reroute events per
route. Features: grade, length, surface (`Edge.kind`), maybe weather,
time of day. Split: **by user** (so the model is tested on a user it
never trained on — the leak-avoidance discipline). Train: fit `k1`/`k2`,
or a small monotone GBT, against the labels.

### Move 2.5 — current vs future

```
  Comparison — hand-tuned vs learned cost

  Phase A (now)                Phase B (learned)
  ─────────────                ─────────────────
  k1=0.4, k2=1.0 hand-picked   k1,k2 (or fn) fit to user data
  same for every user          per-user perceived effort
  zero data, fully offline     needs accept/reroute logs
  invariants hold trivially    invariants must be ENFORCED
                                 (clamp ≥0, finite over-max)
```

The takeaway: the A\* router, the graph, the heuristic — none change.
Only `penalty()`'s body changes, behind the same signature, *if* the
invariants are preserved.

### Move 3 — the principle

In supervised ML the data is the program — but a model deployed inside an
optimization algorithm inherits that algorithm's correctness contract.
flattr's learned cost isn't free to be any function; it must stay
non-negative and finite-over-threshold to keep A\* admissible and the
BLOCKED distinction intact. That constraint — model output bounded by a
downstream invariant — is the part most "just learn it" answers miss.

## Primary diagram

```
  Supervised pipeline → flattr's cost.ts deploy slot

  ┌─ data (NOT collected) ─┐  accept / reroute events
  └───────────┬────────────┘
  ┌─ features (NOT built) ─▼┐  grade, length, surface, context
  └───────────┬────────────┘
  ┌─ split (NOT done) ─────▼┐  BY USER — no cross-user leak
  └───────────┬────────────┘
  ┌─ train (NOT trained) ──▼┐  fit k1,k2 / monotone GBT
  └───────────┬────────────┘
  ┌─ DEPLOY (slot EXISTS) ─▼┐  cost.ts penalty() [cost.ts:16]
  │  inside A* (astar.ts)   │  MUST: ≥0, monotone, finite BLOCKED
  └─────────────────────────┘
```

## Elaborate

Most "AI bugs" in classical ML are data or feature bugs, not model bugs —
and in flattr's case the binding constraint isn't even the model, it's
the A\* invariant the model must respect. Your contrl project gives you
the end-to-end training muscle; the new ground here is (a) classical
tabular ML and (b) deploying a learned function under an admissibility
contract. Train both a linear fit and a monotone GBT, compare on a
held-out *user*, and keep the simpler one unless the gain is measured.

## Project exercises

### B2C-COST.1 — learned edge cost (constrained)

- **Exercise ID:** B2C-COST.1
- **What to build:** log accept/reroute events, engineer grade/length/
  surface features, split by user, fit a monotone cost model, and serve
  it behind `penalty()`'s signature with a `clamp(≥0)` and a finite
  over-max cap.
- **Why it earns its place:** it's the only real ML in flattr's reach,
  and it forces the admissibility/finite-BLOCKED discipline.
- **Files to touch:** new `pipeline/cost-train.ts`,
  `features/routing/cost.ts:16` (swap `penalty` body),
  `cost.test.ts` (assert ≥0 and finite over-max for all inputs).
- **Done when:** the learned cost passes a property test proving
  non-negativity and finiteness over the full grade range, and A\* still
  returns optimal paths on the bench fixtures.
- **Estimated effort:** 1–2 days (data + train + constrained serve).

## Interview defense

**Q: Could flattr use ML, and what would break if you did it naively?**
Answer: yes — a learned edge cost at `cost.ts:16`. The trap: a model is
free to output anything, but A\* needs costs ≥ 0 (so the haversine
heuristic stays a lower bound) and over-max costs finite (so
flattest-but-steep stays distinct from no-route). So you clamp the output
non-negative and cap over-max to a large finite number. Load-bearing
point people miss: the model inherits A\*'s admissibility contract.

```
  learned cost → clamp ≥0 → finite over-max → A* stays optimal
```

Anchor: *"the model deploys inside A\*, so it's not free — it must stay
non-negative and finite-over-threshold or it breaks optimality and the
BLOCKED distinction."*

## See also

- [../ml-features-in-this-codebase.md](../ml-features-in-this-codebase.md) — the attach point in one page.
- [02-feature-engineering.md](02-feature-engineering.md) — the features a learned cost would use.
- [03-train-val-test.md](03-train-val-test.md) — why split by user.
- [12-on-device-inference.md](12-on-device-inference.md) — serving the learned cost on-device (contrl-style).
