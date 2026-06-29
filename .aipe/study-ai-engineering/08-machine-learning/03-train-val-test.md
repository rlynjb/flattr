# Train / Validation / Test Splits

*Industry name: dataset splitting — guarding against information leakage.*

## Zoom out

```
ONE DATASET, THREE JOBS
┌──────────────┬───────────┬──────────┐
│    TRAIN     │   VAL     │   TEST   │
│ fit params   │ tune knobs│ final    │
│ (~70%)       │ (~15%)    │ score    │
│              │           │ (~15%)   │
└──────────────┴───────────┴──────────┘
   model sees   model peeks  model NEVER
   answers      indirectly   sees until end
```

The single most important defense in supervised ML: **never measure success on data the
model trained on.** Split your labeled data three ways — fit on train, pick
hyperparameters on validation, and report the honest number on a test set you touch exactly
once. This is new ground for you; contrl never trained, so it never split.

## How it works

### Move 1 — the mental model: an exam with leaked answers

```
LEAKAGE = studying the exact exam questions
train on rows ──► memorize them ──► ace the same rows ──► fail reality
                                    (overfitting)
```

A model that has seen a row can memorize it. Scoring on that row tells you nothing about
new inputs. The split exists so your reported accuracy is a *forecast of production*, not a
report on memorization.

### Move 2 — walk it, then hit the flattr gotcha

1. **Random split** is the default: shuffle rows, slice 70/15/15.
2. **Tune on val.** Try `k1`, tree depth, learning rate; keep what scores best on val.
   Validation gets "soft-contaminated" by this peeking — hence a separate test set.
3. **Touch test once.** The moment you tune against test, it stops being honest.

Now the gotcha that matters for flattr — **spatial autocorrelation**:

```
RANDOM SPLIT ON GEOGRAPHIC DATA  (BROKEN)
   ●train ●test ●train ●test   ← adjacent edges on the SAME hill
   └─────── same Capitol Hill block ───────┘
   test edge is ~identical to a train edge → fake-high score

SPATIAL SPLIT  (HONEST)
   ┌── train cities/blocks ──┐   ┌── held-out region ──┐
   │  Capitol Hill, Ballard  │   │   Queen Anne (test) │
   └─────────────────────────┘   └─────────────────────┘
```

A learned **edge-cost model** for flattr would have rows = edges, and edges on the same
hill are nearly duplicates (same DEM cell, same slope). A random split puts near-twins in
both train and test → you'd report a great score that collapses on a new neighborhood.
**Split by geography** (hold out whole blocks/cities), not by random row.

### Move 3 — the principle

**Your split must mimic the gap between training and deployment.** Deployment means *new
streets the model never saw*. So the test set must contain *spatially disjoint* streets —
otherwise the test is easier than reality and your number lies.

## In this codebase

**NOT YET EXERCISED — no dataset exists, so nothing is split.** This file is here so that
*when* you build a learned cost for **`features/routing/cost.ts`**, you don't fall into the
random-split trap. flattr's data is intrinsically spatial: every `Edge` in
`features/routing/types.ts` carries `geometry` (a lat/lng polyline) and lives in a DEM
cell. A geographic split is mandatory, not optional.

The hand-coded `penalty()` needs no split — it's not fit to data. And
`features/grade/classify.ts` is a threshold table; there's nothing to validate it against
because nothing was learned. (Its thresholds were *chosen*, not *measured*.)

## See also

- `06-domain-gap.md` — the deployment-distribution mismatch a spatial split tries to expose
- `05-class-imbalance.md` — splitting when rare steep edges must appear in every split
- `01-supervised-pipeline.md` — eval stage that consumes the test set
</content>
