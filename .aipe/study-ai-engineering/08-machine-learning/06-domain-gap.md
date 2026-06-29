# Domain Gap

*Industry name: domain gap / distribution shift — train-vs-deploy mismatch.*

## Zoom out

```
TRAIN DISTRIBUTION  ≠  DEPLOY DISTRIBUTION
┌──────────────────┐     ┌──────────────────┐
│ Seattle hills     │     │ Amsterdam (flat)  │
│ grades 0..40%     │ ──► │ grades 0..3%      │
│ DEM = 90m         │     │ DEM = 1m LIDAR    │
└──────────────────┘     └──────────────────┘
   model learned here       runs here → wrong
```

A model only knows the distribution it was trained on. Deploy it where the inputs look
different — different city, different sensor, different population — and accuracy quietly
collapses *even though the model and code are unchanged*. The domain gap is the silent
killer of "it worked in the notebook." New ground for you.

## How it works

### Move 1 — the mental model: the model interpolates, it doesn't extrapolate

```
trained on grades 0..40%        asked about grade 55% (steeper than any seen)
 cost                            ┌── model guesses wildly here ──┐
  │   ___/  (learned shape)      │                                ▼
  │__/                           └──── no data → no idea ─────────
  └──────────────────────────────────────────────────── grade →
        seen ◄────────►            unseen (extrapolation = garbage)
```

Inside the training range, a model interpolates well. Outside it, predictions are
unfounded. A domain gap is just "deployment lives partly outside the training range."

### Move 2 — where flattr's gap would bite

A learned cost model trained on **Seattle** edges (`features/routing/cost.ts`):

1. **Geographic shift.** Seattle's Capitol Hill hits ~30%; Amsterdam barely clears 3%. A
   model that learned "penalty ramps hard above 8%" never sees that band in Amsterdam — it
   over-penalizes nothing, useless. Train on the flats, deploy on the hills → the reverse,
   dangerous.
2. **Sensor shift.** `pipeline/elevation.ts` defaults to Open-Meteo's **90m DEM** —
   coarse, it *smooths short steep pitches* (noted in the code's own comment). A model that
   learned cost-vs-grade on 90m-smoothed grades, then deployed on **1m LIDAR** grades
   (Google provider), sees sharper spikes it never trained on. Same city, different sensor,
   real gap.
3. **Population shift.** Labels from kick-scooter riders won't fit wheelchair users — the
   `userMax` presets in `classify.ts` (5 / 8 / 15%) hint at how different the populations
   are.

Defenses: detect the gap (file 15 drift), retrain on target-domain data (file 16), or
**transfer-learn** (file 07) from the source model. The spatial split (file 03) is how you
*measure* the gap before shipping.

### Move 3 — the principle

**A model's competence is bounded by its training distribution. Ship outside that box and
you're guessing.** flattr's hand-coded `penalty()` has no domain gap *because it encodes
physics, not a distribution* — `k1*g` and `k2*(g-half)²` hold at any grade, any city. That
robustness is exactly what you'd risk losing by learning the curve from one city's data.

## In this codebase

**NOT YET EXERCISED — nothing is trained, so nothing can transfer poorly.** But the gap is
concrete and waiting: `pipeline/config.ts` pins a single `BBOX` (Seattle MVP). Any learned
`cost.ts` would be a Seattle model. The day flattr expands cities, the domain gap becomes
the first thing that breaks — and the hand-coded penalty would *still* work, which is the
honest argument for keeping it until you have multi-city labels.

`classify.ts` thresholds are city-agnostic constants (4/8%), not a fitted distribution —
no domain gap applies.

## See also

- `07-transfer-learning.md` — adapting a source-domain model to a new city cheaply
- `15-drift-detection.md` — noticing the gap opened in production
- `03-train-val-test.md` — the spatial split that exposes the gap pre-ship
</content>
