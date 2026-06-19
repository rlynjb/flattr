# ML features in this codebase

**This codebase does not currently use any machine-learning features.**

No supervised pipeline, no training, no learned features, no train/val/test
split, no model artifacts, no on-device inference, no quantization, no drift
detection, no recommender. Nothing in the repo learns from data.

## How to verify

The same grep used for the AI file (`openai|...|mediapipe|tensorflow|pytorch|
onnx|inference|...`) returns zero source-file hits. Neither `package.json`
declares an ML runtime. The heaviest dependency in `mobile/` is
`@maplibre/maplibre-react-native` — a map renderer, not an ML framework.

## What looks like ML but isn't

- **The cost model** (`features/routing/cost.ts`) is a *hand-written* grade
  penalty — a deterministic function keyed off `userMax`, not a function
  *learned* from data.
- **The grade classifier** (`features/grade/classify.ts`) maps a signed grade
  to a band and color by fixed thresholds. It's classification by `if`, not by
  a trained classifier.
- **The benchmark harness** (`bench/run.ts`, `bench/report.ts`) runs and
  compares routing algorithms over fixed fixtures. It's an eval harness in
  spirit — and the deterministic analog an ML/LLM eval harness would be built
  in the image of — but it scores algorithms, not models.

## The one genuine future-ML idea

flattr's comfort cost curve (`features/routing/cost.ts`) is hand-tuned. A real
ML direction would be to *learn* that curve from user behavior — which routes
people actually accept vs reject at a given `userMax`. That's the only place ML
would earn its keep, and nothing in the repo touches it today. It would need a
data-collection layer that doesn't exist (the app has no backend, no accounts,
no telemetry — `mobile/assets/graph.json` is a static read-only artifact).

## The ML concepts are covered as study material

See `00-overview.md` §08 (classical ML) and §09 (ML system-design templates) —
both walked as `not yet exercised`, with the cost-curve-learning idea named as
the single honest future seam. The reader's prior ML hands-on (contrl's
MediaPipe pose pipeline, per `me.md`) is real ML experience; flattr simply
isn't an ML project.
