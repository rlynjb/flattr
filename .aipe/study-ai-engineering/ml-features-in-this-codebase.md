# ML features in this codebase

**Verdict first: flattr does not currently use any machine-learning
features.** No trained model, no inference runtime (no ONNX, no TFLite, no
MediaPipe, no Core ML), no training pipeline, no feature engineering, no
dataset. SECTION 04's ML concepts are covered in `08-machine-learning/` as
study material — taught as new ground, not as a refresher.

## What's "intelligent" in flattr — and why it isn't ML

flattr's decision-making is **classical search over a hand-built graph**,
decided by deterministic rules. It is the opposite of a learned model:
every output is reproducible and every cost is hand-coded.

```
flattr's "intelligence" — algorithmic, not learned

  Node {lat, lng, elevationM}
  Edge {lengthM, riseM, gradePct (signed), absGradePct}
        │
        ▼  hand-written cost function (features/routing/cost.ts)
  ┌──────────────────────────────────────────────────┐
  │ A* search, admissible haversine heuristic         │
  │ (features/routing/astar.ts + pqueue.ts binary heap)│
  └──────────────────────────────────────────────────┘
        │
        ▼
  shortest "flat-enough" path — DETERMINISTIC, no weights learned

  contrast: an ML pipeline would LEARN the edge costs from data.
            flattr SETS them with a formula. That's the whole difference.
```

There's a tempting false positive worth killing explicitly: the **grade
classifier** in `features/grade/classify.ts` has "classifier" in the name.
It is **not** an ML classifier. It's a threshold table — signed grade →
band → color — pure `if`/range logic. No training, no parameters fit to
data. A confusion matrix would be meaningless against it because there's
nothing learned to be confused.

## You've shipped ML elsewhere — here's where it'd attach here

Your one shipped ML pipeline is **contrl**: on-device MediaPipe
pose-landmark detection feeding a rep counter, inside a real-time
frame-rate budget, no network in the hot path. That's the closest analog
to anything flattr could grow.

Where ML would plausibly attach in flattr (all currently absent):

```
hypothetical ML attachment points (none exist today)

  ┌─ build pipeline ──────────────────────────────────────┐
  │ pipeline/elevation.ts  → learned elevation infill      │
  │   (today: Open-Meteo API lookup, not a model)          │
  │ pipeline/grade.ts      → learned surface/grade smoothing│
  │   (today: arithmetic from rise/length)                 │
  └────────────────────────────────────────────────────────┘
  ┌─ routing cost ────────────────────────────────────────┐
  │ features/routing/cost.ts → LEARN edge cost from rider   │
  │   behavior instead of the hand-coded grade penalty.     │
  │   This is the real ML opportunity: a learned-to-rank or │
  │   regression model over edge features.                  │
  └────────────────────────────────────────────────────────┘
```

The honest read: flattr's project constraint is **hand-rolled graph +
router only** (`docs/flattr-spec.md` §14) — no Valhalla/OSRM, and by
extension the routing logic is deliberately *not* a black box. Replacing
the hand-coded `cost.ts` with a learned model would be a real architectural
shift, not a drop-in. That's why it's a future exercise, not a seam you'd
add casually.

## The one place a learned cost would attach

**Where:** `features/routing/cost.ts` — the signed directed-grade penalty.

Today this is a formula: grade in, penalty out, with two hard invariants
from the spec — the penalty must stay **≥ 0** (so A*'s heuristic remains
admissible) and `BLOCKED` is a large-finite value, not `Infinity` (so
"no flat route" stays distinct from "disconnected"). Any learned model
that replaced it would have to preserve both invariants, which constrains
the model class hard: you'd need a **monotone, non-negative** cost — closer
to isotonic regression or a constrained GBM than a free-form neural net.

That constraint is itself the lesson. flattr's invariants tell you which ML
you're allowed to use here, before you pick a model.

## Project exercises

### MLX.1 — Learned edge cost (replace the hand-coded penalty)

- **What to build:** a regression/learned-to-rank model over edge features
  (`gradePct`, `lengthM`, `kind`, maybe surface) that predicts a
  rider-perceived cost, swapped in behind the existing `cost.ts` interface.
- **Why it earns its place:** it's the only ML feature that touches the
  *core* of flattr, and it forces you to respect the admissibility (`≥ 0`)
  and `BLOCKED`-finite invariants — real ML-under-constraints, not a toy.
- **Files to touch:** `features/routing/cost.ts` (interface stays, body
  becomes model inference), a new training script under `pipeline/` or a
  sibling `ml/`, plus `bench/` to prove route quality didn't regress.
- **Done when:** the learned cost produces routes a held-out set of riders
  prefer over the hand-coded penalty, *and* `npm run bench` confirms A*
  still terminates with the heuristic admissible (no negative costs leaked).
- **Estimated effort:** multi-day; needs a labeled dataset that doesn't
  exist yet — call that out before starting.

### MLX.2 — On-device elevation/grade infill (contrl-shaped)

- **What to build:** a small on-device model to infill or smooth elevation
  where Open-Meteo returns gaps, removing a network dependency from the
  build pipeline.
- **Why it earns its place:** closest to your shipped contrl pattern
  (on-device inference, no network in the path) and directly addresses the
  documented Open-Meteo 429 caveat in the project context.
- **Files to touch:** `pipeline/elevation.ts`, `pipeline/grade.ts`, plus a
  model artifact + inference shim.
- **Done when:** the build produces a complete `graph.json` with Open-Meteo
  unavailable, and grade values stay within a measured error band of the
  API ground truth.
- **Estimated effort:** multi-day; the contrl experience transfers.

## See also

- [`ai-features-in-this-codebase.md`](ai-features-in-this-codebase.md) — the LLM half (also: none) + the three seams
- [`08-machine-learning/01-supervised-pipeline.md`](08-machine-learning/01-supervised-pipeline.md)
- [`08-machine-learning/12-on-device-inference.md`](08-machine-learning/12-on-device-inference.md)
