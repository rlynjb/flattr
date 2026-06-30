# ML features in this codebase

**Type label:** Honesty file (per-codebase). The ML companion to
[ai-features-in-this-codebase.md](ai-features-in-this-codebase.md).

## The one-line verdict

flattr contains **no trained model**. There is no training pipeline, no
labeled dataset, no feature engineering for a model, no `train/val/test`
split, no inference of learned weights. Nothing in `features/`,
`pipeline/`, or `mobile/` loads or runs an ML model. The closest thing
to "intelligence" is a hand-tuned analytic cost function and a
fixed-threshold color classifier — both are **deterministic math**, not
learned.

The spec asks for one honest call here, and it matters because it's a
tempting false positive: **`features/grade/classify.ts` is NOT a machine
learning classifier.** Read on.

## Kill the false positive: `classify.ts` is a threshold table

The name `classify` and the type `Band` make this look like a
classifier. It isn't. Look at the actual code (`classify.ts:11`):

```ts
export function classifyAbs(absGradePct: number, bands: Bands = DEFAULT_BANDS): Band {
  const g = Math.abs(absGradePct);
  if (g <= bands.greenMax) return "green";   // ← fixed threshold, 4%
  if (g <= bands.yellowMax) return "yellow"; // ← fixed threshold, 8%
  return "red";
}
```

That's an `if`-ladder over two constants (`DEFAULT_BANDS = { greenMax:
4, yellowMax: 8 }`, `classify.ts:8`). There are no learned weights, no
training data, no probability output, no model file. "Classify" here is
the everyday English verb (sort into buckets), not the ML noun (a fitted
model). An ML classifier would have been *trained* on labeled grade →
comfort examples and would output a calibrated probability. This outputs
a hard band from a hand-picked threshold. **It is a lookup table with
branches.** Do not call it ML in an interview — it's the kind of mistake
that signals you can't tell a heuristic from a model.

```
  Threshold table vs ML classifier — the distinction

  classify.ts (what's here)        ML classifier (what's NOT here)
  ┌──────────────────────┐         ┌──────────────────────────────┐
  │ grade %              │         │ features (grade, surface,    │
  │   │                  │         │   weather, user history...)  │
  │   ▼  if g <= 4       │         │   │                          │
  │ "green"  (constant)  │         │   ▼  learned weights θ       │
  │   if g <= 8          │         │ P(comfortable) = σ(θ·x)      │
  │ "yellow" (constant)  │         │   │  trained on labels       │
  │   else "red"         │         │   ▼  calibrated probability  │
  └──────────────────────┘         └──────────────────────────────┘
   hand-picked numbers              fitted to data
   no data, no training             data IS the program
```

## What is NOT here — be explicit

- **No supervised pipeline.** No data → features → split → train →
  deploy. Nothing trains.
- **No feature engineering.** `Edge.gradePct`, `riseM`, `lengthM` are
  geometric facts computed in the build pipeline (`pipeline/grade.ts`),
  not features fed to a model.
- **No on-device inference.** `mobile/` runs A\* over a static graph.
  No TFLite / ONNX / Core ML / MediaPipe model is loaded. (Contrast your
  own **contrl**, which genuinely does on-device MediaPipe inference.)
- **No recommender.** No ranking model, no collaborative filtering.
- **No drift detection, no retraining, no training-run logging** —
  because there's no model to monitor.

## The ONE legitimate ML attach point: `cost.ts` `penalty()`

If flattr ever grew an ML model, this is where it would go — a **learned
edge cost** replacing the hand-tuned `penalty()` (`cost.ts:16`):

```ts
export function penalty(g: number, max: number, k1 = 0.4, k2 = 1.0): number {
  if (g <= 0) return 0;            // downhill / flat: free
  if (g > max) return BLOCKED;     // over user's max: 1e9 (finite!)
  const half = 0.5 * max;
  if (g <= half) return k1 * g;            // moderate: linear
  return k2 * (g - half) ** 2 + k1 * half; // steep: quadratic
}
```

Today `k1` and `k2` are hand-tuned constants. A learned model would fit
them — or replace the whole function — from data like *"which routes did
users actually accept / reroute away from."* That's a legitimate ML
problem: learn the perceived-effort cost of a grade per user.

**But it carries a hard correctness constraint that pose-landmarking
never had.** The router is A\*, and A\* only returns optimal paths if the
edge cost obeys two invariants the project treats as must-not-change:

1. **Admissible / non-negative.** `penalty() ≥ 0` always (note `g <= 0
   → 0`). A\*'s heuristic is the haversine lower bound; if a learned cost
   went negative, the heuristic stops being a lower bound and A\* can
   return a non-optimal path. **A learned cost must be clamped ≥ 0.**
2. **`BLOCKED` is large-finite, not `Infinity`** (`cost.ts:5`, `BLOCKED
   = 1e9`). This is what lets "no flat route, here's the flattest steep
   one" stay distinct from "no route at all" (disconnected graph). A
   learned cost must preserve this: over-max edges stay finite-but-huge,
   never literally infinite, or the "flattest-but-steep" fallback
   collapses into "no route."

So the interview-grade framing is: *"the ML attach point is the edge
cost, but the learned function has to stay non-negative and monotone in
grade to preserve A\* admissibility, and over-threshold has to map to a
large finite penalty to preserve the BLOCKED-vs-disconnected
distinction."* That's a constraint a generic "just learn the cost"
answer misses.

```
  Where a learned cost attaches — and what it must NOT break

  ┌─ A* search (astar.ts) ─────────────────────────────────┐
  │  f(n) = g(n) + h(n)                                     │
  │           │       └── h = haversine LOWER BOUND         │
  │           └── g = Σ edge costs                          │
  │                      │                                  │
  │                      ▼  cost.ts gradeCostDirected       │
  │              edge.lengthM × (1 + penalty(grade, max))   │
  │                                    │                    │
  │                       ★ LEARNED penalty would go here   │
  │                       must stay: ≥ 0  AND  monotone     │
  │                       over-max → finite BLOCKED, not ∞  │
  └────────────────────────────────────────────────────────┘
   break ≥0  → A* may return non-optimal path
   break finite → "flattest-but-steep" becomes "no route"
```

## What you've shipped elsewhere — where it would attach here

- **contrl** (on-device MediaPipe, pose-landmark → rep counter) is your
  one real end-to-end ML project. The flattr analog is the learned
  `cost.ts` — both run a model on-device in a local-first app. The
  *difference* worth naming: contrl's model output feeds a rep counter
  with no global optimality constraint; flattr's learned cost feeds A\*,
  which imposes the admissibility/finite-BLOCKED invariants above. Same
  on-device deployment story, stricter correctness contract.

## Per-feature table (honest)

```
  ┌────────────────────┬──────────────────┬───────────────────────┐
  │ Candidate          │ What it is today │ ML status             │
  ├────────────────────┼──────────────────┼───────────────────────┤
  │ classify.ts bands  │ threshold table  │ NOT ML — if-ladder    │
  │                    │ (if/else)        │ over 2 constants      │
  ├────────────────────┼──────────────────┼───────────────────────┤
  │ cost.ts penalty()  │ hand-tuned       │ ML ATTACH POINT —     │
  │                    │ analytic fn      │ learned cost, must    │
  │                    │ (k1, k2 consts)  │ stay ≥0 + finite      │
  │                    │                  │ BLOCKED               │
  └────────────────────┴──────────────────┴───────────────────────┘
```

## See also

- [ai-features-in-this-codebase.md](ai-features-in-this-codebase.md) — the LLM side (no LLM either).
- [08-machine-learning/01-supervised-pipeline.md](08-machine-learning/01-supervised-pipeline.md) — the learned-cost exercise in full.
- [08-machine-learning/12-on-device-inference.md](08-machine-learning/12-on-device-inference.md) — contrl-style on-device serving.
