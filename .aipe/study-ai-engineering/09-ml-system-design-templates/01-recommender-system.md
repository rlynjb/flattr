# Recommender System

*Candidate generation -> ranking -> serving, with a learned model of user preference.*

The classic ML-system-design interview prompt. "Design a system that recommends
N items to a user." The whole genre lives or dies on one idea: you can't score
every item for every user in real time, so you split the problem into a cheap
recall stage and an expensive precision stage, and you learn the user's
preference from their past behavior rather than hand-coding it.

## Standard architecture

```text
                     RECOMMENDER (generic reference shape)
  ┌─────────────┐   ┌──────────────────┐   ┌───────────────┐   ┌─────────┐
  │   user +    │──▶│ CANDIDATE GEN    │──▶│   RANKING     │──▶│ SERVING │
  │   context   │   │ (recall, cheap)  │   │ (precision)   │   │ + rerank│
  └─────────────┘   │ ~millions → ~500 │   │ ~500 → top N  │   │ filters │
                    └──────────────────┘   └───────────────┘   └─────────┘
                            │                      │                 │
                            ▼                      ▼                 ▼
                    embeddings / ANN       learned scorer      business rules
                    (two-tower, co-occur)  (GBDT / DLRM)       (dedupe, dust)
                            ▲                      ▲
                            └──────── trained on ──┴──── interaction logs
                                      (clicks, dwell, purchases)
```

The learned core is a function `score(user, item, context) -> R`. You fit it to
historical interactions, then rank by predicted score. The interview tests
whether you can stage recall vs. ranking, pick features, and reason about the
training/serving loop.

## Data and features (generic)

- **Interaction log** — the training signal. (user, item, action, timestamp).
  Implicit feedback (clicks/dwell) is noisy but plentiful; explicit (ratings) is
  clean but sparse.
- **Features** — user features, item features, cross features (user x item),
  context (time, device, location).
- **Scale concerns** — candidate gen must be sub-linear (ANN index, not a scan);
  ranking is batched per request; the index is rebuilt offline and the model
  retrained on a cadence. Cold start (new user/item) is the perennial gotcha.

## Applies to this codebase

**Mostly no — and the difference is the interesting part.** flattr does not
recommend by learned preference. It computes the *provably optimal* route
deterministically: a hand-rolled A* (`features/routing/astar.ts`) over a
grade-annotated street graph, minimizing a hand-coded cost
(`features/routing/cost.ts`). There is no candidate-gen/ranking split, no
interaction log, no trained scorer. A* *is* the search; its admissible heuristic
*is* the recall+precision collapsed into one exact algorithm.

The honest tie is precise and lives in one function. flattr's cost is:

```text
  features/routing/cost.ts:16   penalty(g, max, k1, k2)
    g <= 0     -> 0                 (downhill/flat: free)
    g <= half  -> k1 * g            (moderate uphill: linear)
    g <= max   -> k2*(g-half)^2 ... (steep uphill: quadratic)
    g >  max   -> BLOCKED (1e9)     (cost.ts:5, finite on purpose)
```

That `penalty()` is exactly the slot a *learned route-preference model* would
occupy. Today `k1=0.4, k2=1.0` are hand-tuned constants (`cost.ts:8-9`). A model
that learned "this rider tolerates short steep kicks but hates sustained climbs"
would replace those constants — turning the optimizer into a *personalized*
recommender over routes. The seam already exists: every cost variant is a
`CostFn = (edge, fromNodeId, userMax) => number` (`features/routing/types.ts:40`),
so A* never knows whether the number came from arithmetic or a model.

## How to make it apply

Concrete, against flattr's real files:

1. **Collect choices.** Log which route a rider actually took vs. the
   alternatives flattr offered (the rejected-but-presented routes are the
   negative examples). flattr has no such log today — this is the missing
   dataset, and it's the real blocker.
2. **Train a constrained edge-cost model.** Target: a per-edge penalty. The
   model *must* respect the invariants A* relies on, or correctness breaks:
   - **`>= 0`** — A* admissibility needs non-negative edge weights.
   - **monotone in grade** — steeper must never cost less, or the heuristic lies.
   - **BLOCKED stays finite** — the spec's §14.4 "honest fallback" depends on an
     over-max edge being expensive-but-traversable, not `Infinity`, so a
     steep-only path is still returned and *flagged* rather than reported as
     disconnected.
   Enforce these structurally (monotone GBDT / isotonic calibration / a clamped
   output head) rather than hoping the data teaches them.
3. **Swap behind the interface.** Implement
   `learnedCost: CostFn = (edge, fromNodeId, userMax) => ...` and drop it in
   where `gradeCostDirected` is wired today. A* (`astar.ts`), the priority queue
   (`pqueue.ts`), and the summary (`summary.ts`) need zero changes — the
   `CostFn` boundary is the whole point.

This is the cleanest "add ML to an existing deterministic system" story flattr
has: the optimizer stays exact, only the cost oracle becomes learned. It's out
of current scope only because the interaction dataset doesn't exist yet.

## See also

- `features/routing/cost.ts` — the hand-coded penalty (the model's future home)
- `features/routing/types.ts:40` — the `CostFn` seam a model must satisfy
- `features/routing/astar.ts` — the optimizer that consumes any `CostFn`
- `docs/flattr-spec.md` §14.4 — why BLOCKED is finite (a constraint on the model)
- `02-anomaly-detection.md` — the other "where could a model attach" reframe
