# 09 — ML System-Design Templates

Interview-reframe templates for the classic "design an ML system" prompts,
answered honestly about flattr's *current* state.

## What these are

flattr has **no trained model and no ML**. It is a hand-rolled A* router over a
grade-annotated street graph (TypeScript, Expo/React Native, local-first). These
templates exist anyway because the prompts show up in interviews regardless of
what you built — and the skill being tested is reframing a canonical system-design
question against your real artifact without overclaiming.

This follows **Approach-2: every template appears even when the honest answer is
"no."** A confident, specific "no — here's why, and here's the nearest real
analog" is a stronger interview answer than a forced "yes." Each template carries
nine labelled bullets and an `Applies to this codebase` verdict that does not
inflate flattr's capabilities.

## The templates

- [01 — Recommender System](01-recommender-system.md) — Applies: **NO.** flattr has no catalog, users, interaction log, or ranker. The nearest analog is the learned edge cost (`features/routing/cost.ts`), which ranks edges *inside* A* — optimization, not recommendation. How-to-make-apply frames suggesting a `userMax` preset as a tiny single-user rules recommender, and is honest that it's a stretch.

- [02 — Anomaly Detection](02-anomaly-detection.md) — Applies: **PARTIALLY.** Not built, but the problem genuinely fits flattr's input space: drift on the graph's grade distribution, or flagging corrupt edges (bad OSM/elevation) before publishing. How-to-make-apply adds PSI on the grade distribution plus outlier-edge gating to `pipeline/run-build.ts`.

- [03 — Object Detection (On-Device CV)](03-object-detection-cv.md) — Applies: **NO.** flattr has no camera, video, or pixels — nothing to detect. Contrasts **contrl**, which does real on-device pose detection via MediaPipe. The honest move is to name the mismatch and redirect to contrl rather than torture flattr into a fit.

## The one real ML anchor

flattr's single ML attach point is the learned edge cost in
`features/routing/cost.ts` — `penalty(g, max, k1, k2)` (cost.ts:16), the per-edge
multiplier that `gradeCostDirected` (cost.ts:32) feeds to A*. It must stay ≥0 and
monotone to preserve A* admissibility against the haversine heuristic, and an
over-max grade maps to a finite `BLOCKED = 1e9` (cost.ts:5) so "flattest-but-steep
route exists" stays distinct from "no route / disconnected."

For the supervised-learning framing of that anchor — turning those hand-tuned
`k1`/`k2` constants into learned weights — see
[../08-machine-learning/01-supervised-pipeline.md](../08-machine-learning/01-supervised-pipeline.md).

Note: `features/grade/classify.ts` is a **threshold table** (if/else over
`DEFAULT_BANDS`), not a classifier — don't call it ML.
