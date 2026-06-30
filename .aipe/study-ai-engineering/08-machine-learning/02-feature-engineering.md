# Feature engineering — the 60-80% work, for a learned edge cost

**Industry name(s):** feature engineering / feature extraction. **Type:**
Industry standard practice (the load-bearing part of classical ML).

## Zoom out — features are everything `penalty()` reads about an edge

A learned edge cost only knows what you hand it. Today `penalty()` reads
exactly two numbers — directed grade and the user's max — and turns them
into a cost. Feature engineering is the discipline of deciding *which*
numbers about an edge get fed to a model, and how they're shaped. In
flattr the raw material already sits on `Edge` and `Node`; nobody has
turned it into a feature vector yet because there's no model.

```
  Zoom out — where features come from and where they'd go

  Edge {gradePct, absGradePct, lengthM, riseM, kind?}
  Node {lat, lng, elevationM}
        │
        │  feature engineering (NOT built)
        ▼
  feature vector x = [grade, len, surface_onehot, time, …]
        │
        ▼
  ★ cost.ts penalty()  ── learned f(x) → cost ≥ 0, finite
        │
        ▼
  A* relaxation (astar.ts:68)  tentative = g + costFn(edge,…)
```

The features feed the one ML attach point. Everything upstream of the
arrow into `penalty()` is the work nobody's done.

## Structure pass

- **Layers:** raw fields (`Edge`/`Node`) → derived features → encoded
  features (scaling, one-hot) → the model input behind `penalty()`.
- **Axis — raw vs derived.** `gradePct` is raw (computed once in
  `pipeline/grade.ts`). `absGradePct` is *already a derived feature*
  (`|gradePct|`, types.ts:18) — flattr did one feature-engineering step
  by hand. A learned cost would add more.
- **Seam:** `penalty(g, max)` (cost.ts:16). Its argument list *is* the
  feature contract. Widen the signature, you widen the feature set.

## How it works

### Move 1 — the mental model

You shipped contrl: pose landmarks → a rep counter. The landmarks were
your features — MediaPipe handed you x/y/z per joint, and the rep logic
read them. Feature engineering for a *tabular* model is the same instinct
without the camera: take the structured fields you already have and turn
them into the few numbers that actually predict the label.

```
  Pattern — raw fields → features → model

  raw fields ──► derive ──► encode ──► x (feature vector)
  gradePct      absGrade   scale       [0.6, 120, 1,0,0, 0.3]
  lengthM       grade²?    one-hot      └ model reads this
  kind?         surface    normalize
```

### Move 2 — the walkthrough

**Sub-step A — start from what `Edge` already carries.**

```
  Edge fields that are feature-ready today (types.ts:10-19)

  gradePct      signed grade   → effort direction (uphill costs)
  absGradePct   |grade|        → steepness magnitude (DERIVED already)
  lengthM       segment length → exposure: longer steep = worse
  riseM         signed rise    → redundant with grade×length (drop it)
  kind?         surface enum   → sidewalk vs path vs crossing
```

The grade penalty `penalty()` already uses `gradePct` (via
`directedGrade`) and an implicit length multiply in `gradeCostDirected`
(cost.ts:33: `edge.lengthM * (1 + penalty(...))`). So flattr's hand-tuned
cost is a two-feature model. Feature engineering means asking: what else
would change a *real user's* willingness to take this edge?

**Sub-step B — derive features the model can't see raw.**

```
  Derived features a learned cost might add

  grade × length      "how much climbing" (interaction term)
  surface one-hot     kind? → [sidewalk, footway, path, crossing]
  time-of-day bucket  fatigue / lighting (NOT on Edge — needs context)
  cumulative climb    rise so far on the route (stateful — careful)
```

`kind?` is categorical — a model can't multiply by `"sidewalk"`, so you
**one-hot encode** it: one binary column per surface type. This is the
single most common tabular-ML step and flattr has the raw enum ready
(`EdgeKind`, types.ts:8).

**Sub-step C — scale, because grade and length live on different ranges.**

```
  Scaling — grade ∈ [0,15], length ∈ [10,200]

  unscaled: length dominates any distance-based model
  scaled:   (x - mean) / std  →  both ~[-2, 2]
  monotone GBT: scale-invariant, skip it
  linear/NN:    scale or the fit is junk
```

Whether you scale depends on the model (Move from `04-model-selection`):
a linear cost needs it, a gradient-boosted tree doesn't care.

### Move 3 — the principle

Feature engineering is where domain knowledge enters the model. flattr's
domain fact — *uphill costs effort, downhill is free, surface matters* —
is exactly the kind of thing you encode as features, not hope the model
discovers. The hand-tuned `penalty()` already bakes in the best feature
(directed grade); a learned version earns its keep only by adding
features `penalty()` can't express, like surface and context. And every
new feature still has to feed a function that stays ≥ 0 and finite — the
feature set can grow, the output contract can't.

## Primary diagram

```
  Feature pipeline for flattr's learned cost (none built yet)

  ┌─ raw (EXISTS on Edge/Node) ─────────────┐
  │ gradePct, absGradePct, lengthM, kind?    │
  └───────────────┬─────────────────────────┘
  ┌─ derive (NOT built) ─▼──────────────────┐
  │ grade×length, |grade|², cumulative climb │
  └───────────────┬─────────────────────────┘
  ┌─ encode (NOT built) ─▼──────────────────┐
  │ one-hot kind?, scale grade/length        │
  └───────────────┬─────────────────────────┘
  ┌─ serve (SLOT EXISTS) ─▼─────────────────┐
  │ penalty(x) → cost  [cost.ts:16]          │
  │ MUST: ≥0, monotone in grade, finite      │
  └─────────────────────────────────────────┘
```

## Elaborate

The trap in feature engineering is leakage *through* a feature: a feature
that secretly encodes the label. For flattr, `steepEdges` (Path field,
types.ts:36) is computed from grade-vs-userMax — if you fed "is this edge
flagged steep" as a feature to predict "will the user reroute," you'd
leak, because rerouting and the flag share the same grade input. Keep
features to things known *before* the user reacts. Most of your model
quality lives here, not in model choice — a good feature set with a
linear model beats a bad feature set with a fancy one.

## Project exercises

### FEAT.1 — surface-aware feature vector

- **Exercise ID:** FEAT.1
- **What to build:** a `edgeFeatures(edge, fromNodeId, userMax)` function
  that returns the feature vector a learned cost would consume: directed
  grade, length, grade×length, and a one-hot of `kind?`.
- **Why it earns its place:** it makes the implicit two-feature model
  explicit and forces the encoding decisions (one-hot, scaling) before
  any training exists — the 60-80% that's actually the work.
- **Files to touch:** new `features/routing/features.ts` (the extractor),
  `features/routing/types.ts` (a `FeatureVector` type),
  `features/routing/features.test.ts` (assert one-hot is exclusive,
  vector length is stable across edges).
- **Done when:** every `Edge` in `mobile/assets/graph.json` maps to a
  fixed-length numeric vector with no `NaN`, and `kind === undefined`
  encodes to a defined default surface bucket.
- **Estimated effort:** half a day.

### FEAT.2 — leakage audit of the feature set

- **Exercise ID:** FEAT.2
- **What to build:** a short written audit listing each candidate feature
  and whether it's knowable *before* the user reacts; mark `steepEdges`
  and anything derived from the accept/reroute label as forbidden.
- **Why it earns its place:** leakage is the #1 silent ML bug and flattr
  has a concrete trap (`steepEdges` shares grade with the label).
- **Files to touch:** `features/routing/features.ts` (comment each
  feature with its leak status).
- **Done when:** no feature in the extractor is computed from the label
  signal, and the audit names why.
- **Estimated effort:** 1-2 hours.

## Interview defense

**Q: For a learned routing cost, what features would you use and which
would you reject?** Answer: directed grade (the dominant signal, already
in `penalty()`), segment length, a grade×length interaction, and a
one-hot surface from `Edge.kind`. I'd reject `riseM` (redundant with
grade×length) and anything derived from the label — `steepEdges` is
computed from grade-vs-max, so feeding it to predict rerouting leaks. The
load-bearing point: features carry the domain knowledge, and the best one
(directed grade) is already hand-engineered into the cost.

```
  good feature: known before user reacts (grade, surface)
  leak feature: shares input with the label (steepEdges ↔ reroute)
```

Anchor: *"`absGradePct` is already a hand-built derived feature — flattr
did feature engineering before it ever considered ML."*

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the pipeline these features feed.
- [03-train-val-test.md](03-train-val-test.md) — splitting after features exist.
- [04-model-selection.md](04-model-selection.md) — which models need scaling.
