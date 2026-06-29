# Drift Detection

*Industry name: drift detection — noticing input/output distribution shifts over time.*

## Zoom out

```
A MODEL DECAYS WITHOUT CHANGING
deploy day:    inputs ~ training distribution   → accurate
6 months on:   inputs have shifted              → quietly wrong
               (new construction, new riders, new sensors)
```

A trained model is a snapshot of the world *as it was*. The world moves; the model doesn't.
Drift detection is the monitoring that catches the gap *before* users do — by watching
whether today's inputs (or predictions) still look like training. flattr has no model to
drift, but it has a **real and concrete data-drift problem** in its source artifact:
`graph.json` goes stale. New ground as model monitoring; real as data staleness.

## How it works

### Move 1 — the mental model: compare today's distribution to baseline

```
BASELINE (training/build time)     LIVE (now)
grade histogram  ▁▃▆█▆▃▁           grade histogram  ▁▃▆█▆▃▁  → no drift
                                    grade histogram  ▁▁▃▆██▆  → DRIFT (alert)
   ▲ statistically compare the two distributions
```

You don't need labels to detect *input* drift — just compare distributions (PSI,
KS-test, population stability index) of features now vs at training. A big shift means the
model is operating outside what it learned (file 06), even if you can't yet measure accuracy.

### Move 2 — the kinds of drift, and flattr's real version

```
DATA DRIFT       inputs change      (new road grades, new sensor)
CONCEPT DRIFT    input→output rule  changes (riders now avoid different hills)
LABEL DRIFT      target frequency   changes (more steep edges over time)
```

flattr's **real, present drift** is in the *source data*, handled by rebuild not by a monitor:

```
graph.json GOES STALE  (genuine data drift)
OSM edits (new sidewalks, closures)   ─┐
elevation source changes / improves    ├─► data/graph.json drifts
DEM upgrade 90m → 1m LIDAR            ─┘    from physical reality
        ▲ no monitor watches this; the fix is run-build.ts (file 16)
```

The graph is a *frozen snapshot* of OSM + Open-Meteo at build time. Streets change, OSM
gets edited, the elevation source improves — and `graph.json` silently diverges from the
real city. That is data drift in the truest sense. flattr handles it by **re-deriving**
(rebuild, file 16), not by a statistical drift monitor — there's no live distribution check
today.

### Move 3 — the principle

**Anything trained or built on a snapshot drifts from a moving world.** The question is
whether you *detect* it (monitor distributions) or just *refresh on a cadence* (rebuild
blindly). flattr does the latter for its graph; a learned model would push you toward the
former, because silent model decay is harder to notice than a visibly old map.

## In this codebase

**NOT YET EXERCISED as model drift — there is no model.** But name the honest analog
clearly: `data/graph.json` is flattr's drift surface. It's built once by
`pipeline/run-build.ts` from OSM + elevation and then frozen; the real city keeps changing.
No code today measures that divergence — the implicit policy is "rebuild periodically"
(file 16), not "monitor and alert."

If a learned **`features/routing/cost.ts`** existed, you'd add real drift detection:
watch the live grade-feature distribution (`features/routing/types.ts` columns) against the
training baseline, and alert when it shifts — especially across cities (file 06).
`features/grade/classify.ts` is a fixed threshold table; its cutoffs don't drift, only the
underlying grades do (which is the graph-staleness problem above).

## See also

- `06-domain-gap.md` — drift is a gap that opens *over time* instead of *across place*
- `16-retraining-pipelines.md` — the rebuild/retrain that resolves detected drift
- `14-training-run-logging.md` — baselines you log so you can compare against later
</content>
