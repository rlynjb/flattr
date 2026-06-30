# Confusion matrices — no ML home, but the tool to EVALUATE classify.ts if labels existed

**Industry name(s):** confusion matrix / classification error analysis.
**Type:** Industry standard evaluation tool.

## Zoom out — flattr classifies via thresholds, but a confusion matrix could still grade those thresholds

A confusion matrix tabulates a classifier's predictions against true
labels: true positives, false positives, true negatives, false negatives.
flattr has no trained classifier — `classify.ts` is a **threshold table**
(if/else over `DEFAULT_BANDS`, classify.ts:8). But here's the useful
nuance: a confusion matrix doesn't require an ML model. If you had ground-
truth band labels, you could evaluate `classify.ts`'s thresholds with one
*without* `classify.ts` becoming ML.

```
  Zoom out — the matrix evaluates ANY label-producer, including a
  threshold table

  classify.ts  (if/else thresholds, NOT a model)
        │ produces a band: green/yellow/red
        ▼
  ┌─ confusion matrix (evaluation, not ML) ─┐
  │ predicted band  vs  true band            │
  │ counts agreements & the kinds of misses  │
  └──────────────────────────────────────────┘
  needs: ground-truth labels (flattr has NONE today)
```

The matrix is a *measuring* tool. It would tell you whether
`greenMax: 4, yellowMax: 8` (classify.ts:8) are the right thresholds —
but only if someone labeled edges with a "true" band first.

## Structure pass

- **Layers:** predictions (from `classify.ts`) → true labels (don't
  exist) → confusion counts → derived metrics (precision/recall).
- **Axis — model vs threshold producer.** The matrix doesn't care which
  it grades; both emit a predicted class. This is why it can evaluate
  `classify.ts` without making it ML.
- **Seam:** `classifyAbs()` (classify.ts:11) emits the predicted band;
  the missing piece is a true-label column to compare against.

## How it works

### Move 1 — the mental model

A confusion matrix is just a 2D tally: rows = what actually was, columns =
what you predicted. The diagonal is "got it right"; off-diagonal cells are
the *specific kinds* of mistakes. Accuracy is one number; the matrix
shows you *which* errors, which is what you actually fix.

```
  Pattern — the matrix (binary case)

                predicted +   predicted -
  actual +      TP            FN  ← missed positives
  actual -      FP            TN
                ↑ false alarms
  diagonal = correct; off-diagonal = the mistakes that matter
```

### Move 2 — the walkthrough

**Sub-step A — what flattr would predict.** `classify.ts:11` maps a grade
to a band by fixed cutoffs:

```ts
export function classifyAbs(absGradePct: number, bands = DEFAULT_BANDS): Band {
  const g = Math.abs(absGradePct);
  if (g <= bands.greenMax) return "green";   // DEFAULT_BANDS.greenMax = 4
  if (g <= bands.yellowMax) return "yellow"; // DEFAULT_BANDS.yellowMax = 8
  return "red";
}
```

This is a 3-class predictor — but a *rule*, not a model. It will assign a
band to every edge deterministically.

**Sub-step B — the matrix that would grade those cutoffs.**

```
  3-class confusion matrix for classify.ts (NEEDS true labels)

                pred green   pred yellow   pred red
  true green    [ ✓ ]        [ over-warn ]  [ ✗✗ ]
  true yellow   [ under ]    [ ✓ ]          [ over-warn ]
  true red      [ ✗✗ ]       [ under-warn ] [ ✓ ]
  └ "true" = a human/wheelchair-validated comfort label (DOESN'T EXIST)
```

The dangerous cell is **true-red predicted-green**: telling a user a steep
hill is easy. A confusion matrix surfaces exactly that asymmetry, which a
single accuracy number hides.

**Sub-step C — the line that keeps this honest.**

```
  Evaluating classify.ts ≠ making it ML

  confusion matrix = a measuring tape  (statistics)
  classify.ts      = still if/else      (not a model)
  you can measure a ruler with a ruler without the ruler becoming smart
```

### Move 3 — the principle

A confusion matrix evaluates *any* label-producing process, model or rule.
flattr's bands are a rule, and the right way to know if `greenMax: 4` is
correct is to collect true-comfort labels and build a confusion matrix
over `classifyAbs`'s output — measuring the thresholds without converting
them to ML. The matrix is where you'd discover the thresholds are too
lenient (true-red leaking into green) and tune them — still as a rule.

## Primary diagram

```
  Confusion matrix as the evaluator of flattr's threshold table

  ┌─ classify.ts (rule) ─────────────────┐
  │ classifyAbs(grade) → green/yellow/red │  classify.ts:11
  └───────────────┬───────────────────────┘
  ┌─ true labels (DO NOT EXIST) ─▼────────┐
  │ human-validated comfort band per edge  │
  └───────────────┬───────────────────────┘
  ┌─ confusion matrix ─▼──────────────────┐
  │ diagonal = right; watch true-red→green │
  │ → retune greenMax/yellowMax (still rule)│
  └────────────────────────────────────────┘
```

## Elaborate

The asymmetry matters more than overall accuracy for an accessibility
tool. A false "green" on a true-red edge sends a wheelchair user up a hill
they can't climb — a costly, trust-breaking error. A confusion matrix lets
you weight that cell specifically and pick thresholds that minimize it,
even at the cost of over-warning (more false yellows). That's a
*threshold-tuning* decision driven by the matrix, not a model-training one
— exactly the kind of evaluation flattr could adopt without ever shipping
ML. Without labels, though, it's all hypothetical; flattr today has no
ground truth to compare against.

## Project exercises

### CONF.1 — confusion matrix harness for classify.ts

- **Exercise ID:** CONF.1
- **What to build:** a `confusionMatrix(predictions, truths)` over the
  three bands, plus a test fixture of a handful of edges with hand-assigned
  "true" comfort bands, scored against `classifyAbs`.
- **Why it earns its place:** it shows you can *evaluate* a rule rigorously
  and surfaces the true-red→green asymmetry without pretending the rule is
  ML.
- **Files to touch:** new `features/grade/confusion.ts`,
  `features/grade/confusion.test.ts` (small labeled fixture; assert the
  diagonal and the dangerous off-diagonal cell are counted).
- **Done when:** the matrix runs over `classifyAbs` outputs and the test
  asserts a deliberately-too-lenient threshold produces a nonzero
  true-red→predicted-green count.
- **Estimated effort:** half a day.

## Interview defense

**Q: Could you use a confusion matrix in flattr?** Answer: not to
evaluate a model — there isn't one — but yes to *grade the threshold
table*. `classify.ts` is if/else over fixed cutoffs (greenMax 4, yellowMax
8). If I collected true comfort labels per edge, a 3-class confusion
matrix over `classifyAbs`'s output would tell me whether those cutoffs are
right, and specifically whether steep edges leak into "green" — the
costly cell for an accessibility tool. The subtlety: measuring a rule with
a confusion matrix doesn't make the rule ML.

```
  matrix evaluates ANY label-producer (model OR rule)
  classify.ts stays if/else; the matrix just measures it
```

Anchor: *"`classify.ts:8` is a threshold table — a confusion matrix could
grade those thresholds without `classify.ts` ever becoming a classifier."*

## See also

- [05-class-imbalance.md](05-class-imbalance.md) — the metric to pair with the matrix under skew.
- [09-calibration.md](09-calibration.md) — calibrating scores vs the hard-label matrix here.
- [01-supervised-pipeline.md](01-supervised-pipeline.md) — `classify.ts` is a rule, not the pipeline.
