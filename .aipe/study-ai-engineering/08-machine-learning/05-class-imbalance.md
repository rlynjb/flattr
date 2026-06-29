# Class Imbalance

*Industry name: class imbalance — rare positives that skew training and metrics.*

## Zoom out

```
THE DATASET IS LOPSIDED
edges:  ████████████████████████  flat/gentle  (95%)
        █  steep/uncomfortable    (5%)
        ▲ the class you actually care about is the rare one
```

Most real classification problems have a majority class that drowns the minority. A model
can score 95% accuracy by *always saying "not steep"* — and be useless, because the 5% it
ignores is the whole point. Class imbalance is about making the rare-but-important class
actually count. New ground; contrl's rep-counter was a regression-ish counting task, not an
imbalanced classifier.

## How it works

### Move 1 — the mental model: accuracy is a liar under imbalance

```
"ALWAYS PREDICT FLAT" classifier
  accuracy = 95%   ✓ looks great
  steep edges caught = 0   ✗ catches none of what matters
```

The fix starts with *not trusting accuracy*. Under imbalance you watch **precision /
recall / F1** on the minority class (file 08), not overall accuracy.

### Move 2 — the standard remedies, on a flattr steep-edge classifier

Imagine labeling each edge "uncomfortable for this rider" (the minority). To train it well:

1. **Resample.**
   ```
   OVERSAMPLE minority        UNDERSAMPLE majority
   duplicate/synthesize       drop flat edges until
   steep edges (SMOTE)        ratio is ~balanced
   ```
   SMOTE interpolates new synthetic steep examples between real ones — careful with
   spatial data (file 03), synthetic edges can leak across the geographic split.
2. **Reweight the loss.** Tell training "a missed steep edge hurts 19× more than a missed
   flat one." Cheaper than resampling, no synthetic rows. Most libraries take
   `class_weight="balanced"`.
3. **Move the threshold.** A probabilistic model defaults to 0.5; for a rare class you
   often classify "steep" at p > 0.2 to lift recall. (This interacts with calibration,
   file 09.)
4. **Stratify the split.** Ensure every train/val/test slice contains steep edges, or
   your test set might have *zero* and report a meaningless score.

### Move 3 — the principle

**Decide which error is expensive before you train, then bias the model toward avoiding
it.** For an accessibility app, a *missed* steep edge (false negative) strands a rider on a
hill — far worse than a false alarm. The whole imbalance toolkit exists to encode that
asymmetry.

## In this codebase

**NOT YET EXERCISED — flattr has no labels, no classifier, no imbalance to fix.** The
honest connection: flattr's *existing* steep handling is **deterministic, so imbalance is
irrelevant**. `features/grade/classify.ts` flags steep via a fixed threshold
(`absGradePct > yellowMax`), and `cost.ts` blocks via `g > max → BLOCKED`. A rare steep
edge is handled correctly *by construction* — no minority class can be "ignored," because
nothing was fit to a majority.

If you ever built a *learned* steep-comfort classifier (or a learned cost in
`features/routing/cost.ts` trained on rider avoidance), the steep edges would be the
minority and every remedy above would suddenly matter. Until then: no dataset, nothing
imbalanced.

`classify.ts` is **not** an imbalanced classifier to fix — it has no training set to be
imbalanced *over*.

## See also

- `08-confusion-matrices.md` — precision/recall, the metrics imbalance forces you to use
- `09-calibration.md` — threshold moves change calibration
- `03-train-val-test.md` — stratified spatial splits so steep edges land in every slice
</content>
