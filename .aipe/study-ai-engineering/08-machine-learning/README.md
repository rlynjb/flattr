# 08 — Machine Learning (study ground)

**flattr has zero ML.** No trained model, no inference runtime (no ONNX / TFLite /
MediaPipe / CoreML), no training pipeline, no dataset, no labels. Everything in this
section is **study material taught as new ground** — concepts you (Rein) would need if
flattr ever grew a learned component. Nothing here describes code that exists today.

```
WHAT FLATTR ACTUALLY IS
┌──────────────────────────────────────────────────────────────┐
│ pipeline/  → deterministic graph build (OSM + elevation)       │
│ features/routing/  → hand-rolled A* over a grade-annotated     │
│                      street graph (cost.ts is HAND-CODED)       │
│ features/grade/  → THRESHOLD TABLES (classify.ts), not models  │
└──────────────────────────────────────────────────────────────┘
                  ▲ no learning anywhere in this picture
```

## The one real ML attach point

**`features/routing/cost.ts`** — today a hand-coded signed directed-grade penalty
(`penalty(g, max)`: free downhill, linear moderate, quadratic steep, BLOCKED over max).
A *learned* edge-cost model could replace this function. But flattr's invariants
constrain the model **hard**:

- penalty must stay **≥ 0** — A* heuristic admissibility breaks if any edge cost is negative.
- BLOCKED is **large-finite (`1e9`), not `Infinity`** (spec §14.4) — so an only-steep
  path is still returned and flagged, never crashes the search.

→ Any learned cost must be **monotone + non-negative** (steeper never costs less). That
rules out a free neural net and points at **isotonic regression** or a **monotone-constrained
GBM**. This constraint recurs across these files as the concrete anchor.

## Second attach point (contrl-shaped)

**On-device elevation / grade infill** at `pipeline/elevation.ts` + `pipeline/grade.ts`.
Today elevation comes from the network (Open-Meteo, which 429s on the free tier). A small
on-device model that infills grade from local features is the shape that matches your
shipped **contrl** pipeline (on-device MediaPipe pose-landmarks → rep-counter). See
`12-on-device-inference.md`.

## Kill the false positive

`features/grade/classify.ts` has **"classify" in the name but is a THRESHOLD TABLE** —
signed grade → band → color, pure if/range logic (`if (g <= bands.greenMax) return "green"`).
**No training, no learned parameters.** A confusion matrix is meaningless against it
(see `08-confusion-matrices.md`). Do not treat it as an ML classifier.

## Files

| # | File | Concept |
|---|------|---------|
| 01 | `01-supervised-pipeline.md` | data→features→train→eval→serve (flattr has none) |
| 02 | `02-feature-engineering.md` | raw→features (edge features ALREADY exist on `types.ts`) |
| 03 | `03-train-val-test.md` | splits + spatial-leakage gotcha for route data |
| 04 | `04-model-selection.md` | ≥0/monotone invariant DICTATES the model class |
| 05 | `05-class-imbalance.md` | rare "steep/uncomfortable" edges skew training |
| 06 | `06-domain-gap.md` | one city's hills don't transfer to another's |
| 07 | `07-transfer-learning.md` | reuse pretrained weights (contrl's MediaPipe) |
| 08 | `08-confusion-matrices.md` | TP/FP/FN/TN — and why classify.ts isn't one |
| 09 | `09-calibration.md` | predicted probs match real frequencies |
| 10 | `10-recommender-systems.md` | learned preference vs flattr's objective optimum |
| 11 | `11-cold-start.md` | no history for a new rider; flattr sidesteps it |
| 12 | `12-on-device-inference.md` | run on device, no net in hot path (contrl anchor) |
| 13 | `13-quantization.md` | shrink precision for size/speed |
| 14 | `14-training-run-logging.md` | log every run (flattr's bench/ is the analog) |
| 15 | `15-drift-detection.md` | graph.json goes stale as OSM/elevation changes |
| 16 | `16-retraining-pipelines.md` | run-build.ts is a REBUILD, not a retrain |
</content>
</invoke>
