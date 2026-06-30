# SECTION 04 — Machine learning (classical ML), mapped to flattr

flattr has **no trained model, no dataset, no training pipeline**. It's a
hand-rolled A\* router over a grade-annotated street graph (TypeScript,
Expo/React Native). So this section teaches classical ML as **new ground**
(per the reader profile, ML beyond contrl is new) and, for each concept,
honestly marks whether it has a flattr home — anchoring to the **one** real
ML attach point.

## The one ML story (thread through every file)

The only legitimate ML in flattr is a **learned edge cost** at
`features/routing/cost.ts:16` (`penalty()`). Today it's a hand-tuned
formula. A learned version would:

- **Data:** user accept/reroute events (not collected).
- **Features:** grade, length, surface (`Edge.kind`), context.
- **Split:** **by user** — no cross-user leak.
- **Deploy constraint (what makes it special):** the learned cost must stay
  **≥ 0 and monotone** (so A\*'s haversine heuristic stays a lower bound →
  admissibility) and map over-max grades to a **large but FINITE** number
  (`BLOCKED = 1e9`, cost.ts:5 — so "flattest-but-steep" stays distinct from
  "no route"). It serves **on-device**, inside A\*'s hot loop
  (astar.ts:68). Generic "just learn the cost" answers miss these.

`classify.ts` is a **threshold table** (if/else over `DEFAULT_BANDS`,
classify.ts:8), **not** an ML classifier — several files below kill that
false positive.

## Files

| # | Concept | flattr home? |
|---|---------|--------------|
| [01](01-supervised-pipeline.md) | Supervised pipeline + the cost.ts attach point | **Yes** — the anchor file |
| [02](02-feature-engineering.md) | Feature engineering (grade/length/surface) | **Yes** — the load-bearing work |
| [03](03-train-val-test.md) | Train/val/test — split BY USER | **Yes** — leak avoidance |
| [04](04-model-selection.md) | LR vs monotonic GBT for the cost | **Yes** — monotone matters |
| [05](05-class-imbalance.md) | Class imbalance | No home — faint analog: rare steep edges (feature skew) |
| [06](06-domain-gap.md) | Domain gap (one-city graph) | Faint but real — config.ts:10 bbox |
| [07](07-transfer-learning.md) | Transfer learning | No home — new ground |
| [08](08-confusion-matrices.md) | Confusion matrices | No home — but could EVALUATE classify.ts bands |
| [09](09-calibration.md) | Calibration (cost magnitude) | **Yes-ish** — A\* sums the cost |
| [10](10-recommender-systems.md) | Recommender systems | No strong home — faint: userMax preset suggestion |
| [11](11-cold-start.md) | Cold start | **Strong** — formula now, learned later |
| [12](12-on-device-inference.md) | On-device inference | **Strong** — like contrl, in A\*'s hot loop |
| [13](13-quantization.md) | Quantization | Weak — tiny model; A\*-invariant risk |
| [14](14-training-run-logging.md) | Training-run logging | **Yes** — log fits + legality verdict |
| [15](15-drift-detection.md) | Drift detection (PSI) | **Yes** — grade/behavior drift trigger |
| [16](16-retraining-pipelines.md) | Retraining pipelines | **Yes** — triggers + safe-promotion gate |

## How to read this

Start with [01-supervised-pipeline.md](01-supervised-pipeline.md) — it's
the anchor every other file cross-links to. The **strong-home** files
(02, 03, 04, 11, 12, 14, 15, 16) are where flattr's learned cost genuinely
lives; the **no-home** files (05, 07, 10, and partly 08, 13) teach the
concept honestly and name the faint analog without overclaiming.

## See also

- [../ml-features-in-this-codebase.md](../ml-features-in-this-codebase.md) — the attach point in one page.
- [../09-ml-system-design-templates/README.md](../09-ml-system-design-templates/README.md) — interview reframe templates.
