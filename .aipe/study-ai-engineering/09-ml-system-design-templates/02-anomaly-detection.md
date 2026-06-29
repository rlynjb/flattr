# Anomaly Detection

*Flag outliers against a learned or statistical baseline.*

The second staple ML-design prompt. "Detect fraud / bad sensor readings / weird
traffic." The shape is always the same: build a model of *normal*, then score new
points by how far they deviate. Sometimes the model is learned (autoencoder
reconstruction error, isolation forest); sometimes it's pure statistics (z-score,
IQR, robust median). The interview tests whether you can define "normal" without
labels, set a threshold, and handle the precision/recall tradeoff on rare events.

## Standard architecture

```text
                  ANOMALY DETECTION (generic reference shape)
  ┌──────────┐   ┌────────────────┐   ┌──────────────┐   ┌─────────────┐
  │ incoming │──▶│ FEATURIZE      │──▶│ SCORE vs     │──▶│ THRESHOLD   │
  │ records  │   │ (normalize)    │   │ BASELINE     │   │ + ALERT     │
  └──────────┘   └────────────────┘   └──────┬───────┘   └─────────────┘
                                             │                  │
                       baseline model ◀──────┘            quarantine /
                       (statistical or learned)           flag / drop
                       fit on "normal" history            ▲
                                                          │
                                            feedback: confirmed labels
                                            tighten threshold over time
```

Key decisions: unsupervised (no labels, model the density) vs. supervised (rare
labels, classify); point anomalies vs. contextual vs. collective; and where the
detector sits — inline (block bad data) vs. offline (audit after the fact).

## Data and features (generic)

- **Baseline corpus** — a sample of known-good data. Quality matters more than
  size; contaminated "normal" data poisons the baseline.
- **Features** — whatever makes the anomaly stand out. Often deltas, ratios, and
  rolling stats rather than raw values.
- **Scale concerns** — streaming detectors need bounded state (sketches, EWMA);
  thresholds drift, so you re-fit on a schedule; alert fatigue is the real-world
  failure mode, so calibrate for precision on the rare class.

## Applies to this codebase

**No — flattr has no anomaly detection, learned or statistical.** There is no
detector, no baseline model, no outlier score anywhere in the pipeline or
routing code.

But the *nearest honest tie* is real and worth naming, because flattr's build
pipeline ingests third-party data that absolutely can be corrupt:

```text
  flattr's data path (where bad values can enter)
  ┌──────────────┐    ┌──────────────────┐    ┌────────────────────┐
  │ OSM / Overpass│──▶│ elevation.ts     │──▶ │ grade.ts           │
  │ (street geom) │    │ Open-Meteo 90m   │    │ riseM / lengthM    │
  └──────────────┘    │ DEM, no key      │    │ -> gradePct        │
                      └──────────────────┘    └────────────────────┘
                       coarse DEM smooths        arithmetic only —
                       /jumps at cliffs          NO outlier check
```

The one defense flattr has is *not* anomaly detection — it's a hard physical
clamp. `pipeline/grade.ts:10` defines `MAX_GRADE_PCT = 40`, and line 30 clamps
every computed grade into `[-40, +40]`. The comment is explicit: values beyond
that are "coarse-DEM noise (a short edge straddling an elevation step)." That's a
domain rule, applied unconditionally to every edge — it does not *detect* an
outlier relative to a baseline, it just saturates. A genuinely anomalous edge
(say, a tunnel/bridge node with a garbage elevation sample from Open-Meteo) that
lands inside `[-40, 40]` sails through completely unflagged.

So: the surface exists (`pipeline/grade.ts` + `pipeline/elevation.ts`), the data
is genuinely outlier-prone, but flattr computes values arithmetically with no
statistical or learned outlier step.

## How to make it apply

Concrete, against flattr's real files — and this would be *statistical*, not
necessarily learned (the honest answer is you don't need a model here):

1. **Build-time outlier check in the pipeline.** After `computeGrades`
   (`pipeline/grade.ts:24`), compute a robust spread (median + MAD) of
   `gradePct` over each local neighborhood of edges, and flag edges whose grade
   is many MADs from their neighbors. A lone +35% edge between two +3% edges is
   the signature of a bad elevation sample, not real terrain.
2. **Cross-check elevation against neighbors.** In `pipeline/elevation.ts`,
   after `sampleElevations`, flag any node whose elevation differs from its
   graph neighbors by more than a plausible-slope budget given edge length. This
   catches the corrupt-sample case the `[-40,40]` clamp silently absorbs.
3. **Quarantine, don't drop.** Mark flagged edges/nodes in the build artifact so
   the route summary (`features/routing/summary.ts`) can warn "this route
   crosses low-confidence terrain" — consistent with the spec's preference for
   honest fallbacks over silent failure.

A learned detector (autoencoder over edge features) is possible but unjustified
at flattr's scale; the statistical version is the right-sized answer and is the
one to give in an interview. **Out of current scope** — flattr ships the clamp,
not a detector.

## See also

- `pipeline/grade.ts:10,30` — the physical clamp (a rule, not a detector)
- `pipeline/elevation.ts` — the coarse-DEM source where bad values originate
- `features/routing/summary.ts` — where a "low-confidence terrain" flag surfaces
- `01-recommender-system.md` — the other honest "where ML could attach" reframe
