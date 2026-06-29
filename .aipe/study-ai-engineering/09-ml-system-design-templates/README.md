# 09 — ML System-Design Templates

Generic ML-system-design *interview reframes*, grounded honestly against flattr.

**Read this first.** flattr has **no ML model, no training, no inference
runtime.** It is a deterministic, grade-aware routing engine: a hand-rolled A*
(`features/routing/astar.ts`) over a grade-annotated street graph, minimizing a
hand-coded cost (`features/routing/cost.ts`), plus an Expo/RN map app. Nothing in
the repo learns from data.

So why an ML-system-design section? Because these prompts are the standard
interview genre, and the valuable skill is being able to (a) draw the canonical
architecture and (b) say *honestly* whether the codebase in front of you
resembles it — and if not, name the nearest real attach point instead of
hand-waving. Each file below keeps the generic architecture/data/scale material
brief and spends its weight on two honest bullets: **"Applies to this codebase"**
and **"How to make it apply,"** answered about flattr's real files only.

## The three templates

| # | Template | Does flattr resemble it? | Nearest real attach point |
|---|----------|--------------------------|---------------------------|
| [01](01-recommender-system.md) | Recommender system | **Partly (the honest one).** flattr computes *optimal* routes deterministically — it doesn't recommend by learned preference. | `features/routing/cost.ts:16` — a learned edge-cost would replace `penalty()`, constrained `>=0` / monotone / BLOCKED-finite, behind the `CostFn` seam (`types.ts:40`). |
| [02](02-anomaly-detection.md) | Anomaly detection | **No.** No detector, no baseline. flattr's only defense is a hard clamp, not outlier detection. | `pipeline/grade.ts` + `pipeline/elevation.ts` — compute grades arithmetically with no outlier check; a statistical check could catch corrupt OSM/Open-Meteo data. Out of scope. |
| [03](03-object-detection-cv.md) | Object detection / CV (on-device) | **None.** No camera, no pixels, no CV surface. | The only on-device shape is A* (algorithm, not inference). Transferable lesson is contrl's on-device-budget discipline, applicable only if flattr added on-device elevation infill. Out of scope. |

## The one real story

If you take one thing from this section: the **recommender reframe (01)** is the
only template with a genuine, clean attach point. flattr's optimizer consumes any
`CostFn = (edge, fromNodeId, userMax) => number` (`features/routing/types.ts:40`),
and the hand-tuned `penalty()` in `cost.ts` is exactly where a learned
route-preference model would live — turning a deterministic optimizer into a
personalized one without touching A* itself. The constraints (`>=0`, monotone in
grade, BLOCKED finite per spec §14.4) are dictated by A* correctness, which is
*why* it's a good interview answer: it shows you can add ML to a system without
breaking its guarantees. The blocker is a rider-choice dataset that doesn't exist
yet.

## What is NOT ML here (kill the false positive)

`features/grade/classify.ts` looks classifier-shaped but is **not** an ML
classifier — it's a threshold table (`classifyAbs` at lines 11-16,
`classifyDirected` at 33-38) mapping grade % to a color band against fixed or
userMax-derived cutoffs. No model, no training, no inference. Don't claim it.

## See also

- `../ml-features-in-this-codebase.md` — inventory of (non-)ML surfaces
- `../07-system-design-templates/` — the non-ML system-design genre
- `../08-machine-learning/` — ML fundamentals
