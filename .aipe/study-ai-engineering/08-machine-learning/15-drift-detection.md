# Drift detection — PSI on grade distribution and user behavior, as a retrain trigger

**Industry name(s):** drift detection / distribution monitoring
(data drift, concept drift; PSI, KL divergence). **Type:** Industry
standard production-ML practice.

## Zoom out — a learned cost can rot when grades or user behavior shift; drift is the alarm

Drift is when the live data distribution moves away from what a model
trained on, silently degrading it. flattr has no learned cost to drift
yet — but if one shipped, two things could drift: the *grade distribution*
(new neighborhoods, a wider bbox) and *user behavior* (users get fitter,
or a new user cohort with different tolerance). Drift detection is the
statistical alarm that says "the world moved, consider retraining." It's
the temporal twin of domain gap (`06`).

```
  Zoom out — drift watches the inputs to the learned cost over time

  TRAIN-TIME grade/behavior distribution  (baseline)
        │
        ▼  compare over time (PSI)
  LIVE grade/behavior distribution
        │
        ▼  PSI high? → DRIFT alarm → trigger retrain (16)
  ★ cost.ts penalty(): learned model trained on the OLD distribution
     now serving a SHIFTED one → degraded routing
```

The formula `penalty()` can't drift (it's not fit to data). Only the
learned cost can — which is itself an argument for keeping the formula as
a drift-proof fallback (`11`).

## Structure pass

- **Layers:** baseline distribution (at train time) → live distribution
  (monitored) → drift statistic (PSI) → threshold → retrain trigger.
- **Axis — data drift vs concept drift.** Data drift: the *inputs* move
  (grades change). Concept drift: the *relationship* moves (same grade,
  users now tolerate it more). Both matter for the cost.
- **Seam:** the feature distributions feeding `penalty()` — grade,
  surface, and the accept/reroute label behavior.

## How it works

### Move 1 — the mental model

A model is a snapshot of a distribution. The world keeps moving; the
snapshot doesn't. Drift detection measures *how far* the live world has
drifted from the snapshot, so you retrain before the model quietly becomes
wrong. You don't watch accuracy directly (labels lag); you watch the
*input distribution* as an early warning.

```
  Pattern — drift as distance between two distributions

  baseline:  grade histogram at train time   ▁▃▅▇▅▃▁
  live:      grade histogram this month       ▁▃▇▇▇▅▃  ← shifted right
  PSI = Σ (live% - base%) · ln(live% / base%)
  PSI < 0.1  stable │ 0.1-0.25 watch │ >0.25 RETRAIN
```

### Move 2 — the walkthrough

**Sub-step A — what drifts in flattr, concretely.**

```
  Two drift sources for the learned cost

  DATA drift (inputs)    bbox widened (config.ts:10) → flatter/steeper
                         edges enter → grade histogram shifts
  CONCEPT drift (label)  same 8% grade, but users now accept it more
                         (seasonal fitness, e-bike adoption) → the
                         grade→effort RELATIONSHIP changed
```

Data drift is detectable from edges alone (no labels needed) — compute the
`absGradePct` histogram now vs at train time. Concept drift needs the
accept/reroute stream — the label relationship moving.

**Sub-step B — PSI on the grade distribution (label-free, cheap).**

```
  PSI on absGradePct — the cheap, always-available signal

  bin grades into bands (reuse classify.ts bands: ≤4, 4-8, >8)
  base%  per band at train time   [0.6, 0.3, 0.1]
  live%  per band now             [0.4, 0.35, 0.25]  ← more steep
  PSI sums the per-band divergence → > 0.25 → grade world moved
  → the cost trained on mostly-flat edges now serves steeper ones
```

The classify.ts bands are a ready-made binning scheme — you can reuse
the threshold table to bucket grades for the PSI computation, without it
being ML.

**Sub-step C — wiring drift to action.**

```
  Drift → trigger (feeds 16-retraining)

  PSI(grade) > 0.25      → data drift → retrain on fresh edges
  accept-rate shift > X  → concept drift → retrain on fresh labels
  BOTH below threshold   → model is fine, do nothing
  also: fall back to formula penalty() if drift is severe (11)
```

### Move 3 — the principle

Drift detection watches the input distribution so you catch a decaying
model before its outputs visibly fail. For flattr, the cheap, always-on
signal is PSI on the grade distribution (label-free, bucketable with the
existing classify.ts bands); the deeper signal is concept drift in
accept/reroute behavior. Either crossing threshold triggers a retrain —
and severe drift falls back to the drift-proof formula. Drift is domain
gap over time, and the same PSI statistic measures both.

## Primary diagram

```
  Drift detection for flattr's learned cost (none exists yet)

  ┌─ baseline (at train time) ──────────────────────┐
  │ grade histogram · accept-rate per band           │
  └──────────────────────┬───────────────────────────┘
  ┌─ live (monitored) ───▼──────────────────────────┐
  │ grade histogram NOW · accept-rate NOW            │
  └──────────────────────┬───────────────────────────┘
  ┌─ PSI (bin via classify.ts bands) ─▼─────────────┐
  │ <0.1 stable · 0.1-0.25 watch · >0.25 RETRAIN     │
  └──────────────────────┬───────────────────────────┘
  ┌─ action ─────────────▼──────────────────────────┐
  │ trigger retrain (16) · severe → formula fallback │
  └────────────────────────────────────────────────────┘
```

## Elaborate

The label-free part is what makes drift detection practical for flattr:
you can compute grade-distribution PSI from edges alone, with no
accept/reroute data and no model, *today* — it's the one piece of this
whole production-ML stack that's buildable before any ML exists. That's
also why it doubles as a domain-gap detector (`06`): point it at a new
city's graph and the same PSI tells you the learned cost is off-domain.
Concept drift is harder (needs the label stream and lags reality), but the
cheap grade-PSI catches the most common failure — the cost trained on one
grade mix serving a different one. And because the formula penalty is
drift-proof, severe drift has a safe landing.

## Project exercises

### DRIFT.1 — grade-distribution PSI monitor

- **Exercise ID:** DRIFT.1
- **What to build:** a `psi(baselineHist, liveHist)` over grade bands
  (reusing `classify.ts` bands to bin), plus a check that flags PSI > 0.25
  between two graphs as drift.
- **Why it earns its place:** it's the one production-ML signal buildable
  *now* (label-free, model-free) and doubles as the domain-gap detector.
- **Files to touch:** new `pipeline/drift.ts` (PSI over grade bands),
  `pipeline/drift.test.ts` (a shifted histogram crosses threshold; an
  identical one scores ~0).
- **Done when:** PSI reads ~0 for identical grade distributions and >0.25
  for a clearly steeper one, using the bundled graph as the baseline.
- **Estimated effort:** half a day.

## Interview defense

**Q: How would you detect that flattr's learned cost is going stale?**
Answer: drift detection on the inputs. The cheap, always-on signal is PSI
on the grade distribution — bin `absGradePct` (I can reuse the classify.ts
bands), compare the live histogram to the train-time baseline, and flag
PSI > 0.25. That's label-free and even buildable before any model exists,
and it doubles as a domain-gap detector for new cities. The deeper signal
is concept drift in accept/reroute behavior — same grade, users now
tolerate it more. Either crossing threshold triggers a retrain, and severe
drift falls back to the drift-proof formula penalty.

```
  PSI(grade) — label-free, cheap, also catches domain gap
  concept drift (accept-rate) — deeper, needs labels, lags
  threshold → retrain; severe → formula fallback
```

Anchor: *"drift is domain gap over time — the same PSI on `absGradePct`
catches both, and the formula `penalty()` is the drift-proof fallback."*

## See also

- [06-domain-gap.md](06-domain-gap.md) — the spatial twin; same PSI statistic.
- [16-retraining-pipelines.md](16-retraining-pipelines.md) — the action drift triggers.
- [11-cold-start.md](11-cold-start.md) — formula fallback when drift is severe.
- [08-confusion-matrices.md](08-confusion-matrices.md) — classify.ts bands as the PSI binning scheme.
