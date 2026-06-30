# 02 — Anomaly Detection

A reusable interview template, reframed against flattr. flattr does not ship anomaly
detection, but its build pipeline ingests noisy external data (OSM geometry +
elevation) — so this is the one "no" template that is honestly a *partially*: the
input space exists, the detector does not.

- **The prompt:** "Design an anomaly detection system that flags unusual events in a data stream."

- **Standard architecture:** Anomaly detection is a scoring-plus-threshold pipeline over a stream — featurize events, score each against a model of "normal," and route high scores to an alert sink. The diagram below shows the stream path with the baseline model fit offline.

```
                  Anomaly detection — score-and-threshold over a stream
  ┌──────────────┐  events   ┌──────────────────┐  features  ┌──────────────────┐
  │  Source      │──────────►│  Feature extract │───────────►│  Scorer          │
  │ (data stream)│           │  (window/aggr)   │            │  score vs normal │
  └──────────────┘           └──────────────────┘            └────────┬─────────┘
                                                                       │ score
                                                  ┌────────────────────┼───────────┐
                                                  │                    │           │
                                            score ≤ τ            score > τ         │
                                                  ▼                    ▼           │
                                          ┌──────────────┐    ┌──────────────┐     │
                                          │  Pass / store│    │  Alert sink  │     │
                                          └──────────────┘    └──────────────┘     │
                                                                                   │
                          ┌────────────────────────────────────────────┐          │
                          │ Offline: fit baseline "normal" distribution │◄─────────┘
                          │ + choose threshold τ                        │  recent normals
                          └────────────────────────────────────────────┘
```

  The baseline defines normal; the threshold τ trades false positives against missed anomalies. flattr builds none of this today.

- **Data model:** A rolling baseline of "normal" — either summary statistics (mean/variance, histogram bins) or a reference distribution snapshot — plus the threshold τ and a labeled alert log for tuning. Streaming systems keep a windowed feature buffer. flattr's analog is its static input: every `Edge {gradePct, absGradePct, lengthM, riseM, kind?}` and `Node {lat, lng, elevationM}` in `mobile/assets/graph.json`, produced once by the build pipeline. There is no stream and no baseline stored; the graph is a single batch artifact.

- **Key components:** Feature extractor — windows/aggregates raw events into comparable features; the choice is fixed windows over per-event scoring when anomalies are distributional (a shift across many events) rather than point outliers. Scorer — distance from baseline (z-score, isolation forest, or a distribution-distance metric like PSI/KL); the choice is an unsupervised density/distance method over a supervised classifier because labeled anomalies are rare by definition. Threshold + alerter — converts score to action; the choice is a calibrated τ with hysteresis so a single noisy event doesn't page.

- **Scale concerns (ordered by what hits first):** (1) False-positive rate — at any real event volume a naive τ floods the alert sink first; you tune τ before anything else. (2) Baseline drift — "normal" itself moves over time, so a fixed baseline grows stale and every event looks anomalous; needs a rolling/decaying reference. (3) Throughput and state — windowed features hold per-key state; past high cardinality the feature buffer is the memory bottleneck. (4) Concept of "anomaly" changing — what was rare becomes common, requiring threshold re-fit.

- **Eval framing:** Offline — precision/recall against a labeled anomaly set, and PR-AUC rather than ROC-AUC because anomalies are heavily imbalanced. Online — alert precision (what fraction of fired alerts were real) and time-to-detect, traded against analyst alert fatigue. The operational metric that matters most is alerts-per-day at acceptable recall.

- **Common failure modes:** Alert flood — τ too tight, drowns operators; mitigate with hysteresis and rate limiting. Silent drift — baseline never updates, detector slowly goes blind or noisy; mitigate with a decaying reference window. Seasonality blindness — periodic normal swings read as anomalies; mitigate with time-bucketed baselines. Label scarcity — can't measure recall without known anomalies; mitigate with synthetic injection of known-bad events.

- **Applies to this codebase: PARTIALLY.** flattr has no anomaly detector and does not monitor anything at runtime — but the *input space* for one is real and currently unguarded. Two honest framings exist. First, distribution drift: the graph's grade distribution (the `gradePct`/`absGradePct` values across all edges) is exactly the kind of quantity you would track for drift — if a rebuild from fresh OSM + elevation data shifts that distribution, routes silently change character, and nobody would notice. Second, point anomalies: individual edges can be corrupt — bad OSM geometry or noisy elevation sampling can produce an `Edge` with an implausible `gradePct` (a 60% grade on a city street) or a `riseM`/`lengthM` ratio that's physically impossible. Those are anomalous edges in flattr's input, and flagging them before they reach `graph.json` is genuinely anomaly detection on flattr's data. None of this is built — the build pipeline (`pipeline/run-build.ts`, `pipeline/grade.ts`, `pipeline/elevation.ts`) computes grades and writes the graph without any sanity gate. So: the problem fits, the system is absent.

- **How to make it apply:** Add a pre-publish validation stage to `pipeline/run-build.ts`, between graph construction and writing `graph.json`. Two concrete detectors. (a) Distributional: compute the grade histogram over all edges and a Population Stability Index (PSI) against the previously published graph's histogram; if PSI crosses a threshold (e.g. > 0.25), fail the build or warn loudly — that catches a systematic elevation-source regression. (b) Point outliers: flag any edge whose `absGradePct` exceeds a hard physical ceiling, or whose `riseM` is inconsistent with `lengthM * gradePct/100`, and emit them to a report before publishing. Both run on the data already flowing through `pipeline/grade.ts`, so the marginal cost is one pass over the edge list. This protects the one place flattr trusts external data. I've built drift-aware pipelines before; the lift here is small precisely because the data is batch and static — you get the safety without needing the streaming machinery in the standard diagram above.
