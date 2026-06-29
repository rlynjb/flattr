# Confusion Matrices

*Industry name: confusion matrix — the TP/FP/FN/TN breakdown of a classifier.*

## Zoom out

```
              PREDICTED steep   PREDICTED flat
ACTUAL steep   TP (caught)       FN (missed!)   ← strands a rider
ACTUAL flat    FP (false alarm)  TN (correct)
```

A confusion matrix is the four-cell ground truth of *how* a classifier is right and wrong —
not just how often. Accuracy collapses four numbers into one and hides the error that
matters; the matrix keeps them separate so you can see whether you're missing the dangerous
class. **This concept only applies to a *learnable classifier with labels*** — which flattr
does not have. New ground.

## How it works

### Move 1 — the mental model: not all errors are equal

```
FN (missed steep)   ──► rider sent up a hill   ← EXPENSIVE
FP (false alarm)    ──► slightly longer route  ← cheap
```

The whole reason to look at the matrix instead of accuracy: for an accessibility app, a
false negative is a stranded rider and a false positive is a minor detour. One number can't
express that asymmetry; four cells can.

### Move 2 — build it, on a HYPOTHETICAL steep-edge classifier

Suppose you trained a model to predict "is this edge too steep for this rider?" with real
labels. You'd run it on the held-out test set (file 03) and tally:

```
            metric          formula              reads as
            ─────────────────────────────────────────────────────
precision   TP/(TP+FP)      of "steep" calls,    "when it says steep,
                            how many were real    is it right?"
recall      TP/(TP+FN)      of real steep edges,  "does it catch the
                            how many caught       steep ones?"  ← key here
F1          harmonic mean   balances both
```

Under imbalance (file 05), you'd push **recall** up — missing a steep edge is the costly
error. The matrix is also where you *see* a class-imbalance failure: a 95%-accuracy model
with FN filling the whole "actual steep" row is exposed instantly.

### Move 3 — the principle

**Score the errors you'll pay for, separately.** The confusion matrix is the tool that
forces you to look at the dangerous quadrant (FN) instead of letting accuracy average it
away.

## In this codebase — KILL THE FALSE POSITIVE

**`features/grade/classify.ts` is NOT a classifier you can build a confusion matrix for.**
It has "classify" in the name and returns bands ("green"/"yellow"/"red"), which *looks*
like classification — but:

```
classify.ts  =  THRESHOLD TABLE, not a learned classifier
   if (g <= bands.greenMax)  return "green";
   if (g <= bands.yellowMax) return "yellow";
   return "red";
        ▲ pure if/range logic. No training. No labels. No learned params.
```

A confusion matrix measures *prediction error against ground truth*. `classify.ts` has **no
error** — its output is the *definition* of a band, not a guess at one. "Is 5% yellow?" has
no true answer to be wrong about; the threshold *is* the truth. There is nothing to put in
the TP/FP/FN/TN cells. **A confusion matrix against `classify.ts` is meaningless.**

A confusion matrix would only apply if you trained a *learnable* steep-edge classifier (or
evaluated a learned `cost.ts` re-cast as a steep/not-steep decision). **NOT YET EXERCISED —
no such model and no labels exist.**

## See also

- `05-class-imbalance.md` — why recall, not accuracy, is the number to watch here
- `09-calibration.md` — when the classifier emits probabilities, not hard labels
- `04-model-selection.md` — why `cost.ts` is a regression, scored differently than this
</content>
