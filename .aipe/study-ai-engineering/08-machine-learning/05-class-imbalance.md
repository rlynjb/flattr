# Class imbalance — new ground, no flattr home (faint analog: steep edges are rare)

**Industry name(s):** class imbalance / skewed class distribution.
**Type:** Industry standard problem (mostly in classification).

## Zoom out — flattr has no classifier to imbalance, so this is study material

Class imbalance is a *classification* problem: one label vastly
outnumbers another, so a model that always guesses the majority looks
accurate while being useless. flattr has no trained classifier — the
closest thing, `classify.ts`, is a **threshold table**, not a model — so
there's no class distribution to be imbalanced. This file teaches the
concept as new ground and names the one faint analog honestly.

```
  Zoom out — where imbalance would live (it doesn't)

  ┌─ a CLASSIFIER (does not exist in flattr) ─┐
  │ labels: {accept, reroute} or {green,…,red} │
  │ if one label is 95% of the data → imbalance│
  └────────────────────────────────────────────┘
        │
        ▼  flattr's reality:
  classify.ts = if/else over thresholds, NOT a model → no labels to skew
  cost.ts     = a regression-shaped cost, NOT classification → N/A
```

There is no box in flattr where imbalance bites. The honest answer in an
interview is "flattr doesn't classify, so imbalance doesn't apply — but
here's where it *would*."

## Structure pass

- **Layers:** label distribution → naive accuracy trap → fix
  (resample / reweight / threshold-move) → imbalance-aware metric.
- **Axis — balanced vs skewed.** Imbalance is a property of the label
  column, and flattr has no label column.
- **Seam:** there is none. The faint analog is *feature* skew, not class
  skew (see Elaborate) — a different problem with a similar smell.

## How it works

### Move 1 — the mental model

Imagine a spam classifier where 99% of email is ham. A model that prints
"ham" forever is 99% accurate and catches zero spam. Accuracy lies under
imbalance; the rare class is the one you care about, and it's the one a
naive model ignores.

```
  Pattern — the imbalance trap

  labels: ████████████████████ 95% class A
          █                     5% class B  ← the one you care about
  naive model: "always A" → 95% accuracy, 0% useful
  fix: rebalance OR change the metric so B counts
```

### Move 2 — the walkthrough (as new ground)

**Sub-step A — the three standard fixes.**

```
  Fixing imbalance

  oversample minority   duplicate / SMOTE the rare class
  undersample majority  drop some common-class rows
  reweight loss         penalize minority errors more
  move the threshold    don't classify at 0.5; pick by recall need
```

**Sub-step B — the right metric.** Accuracy is out. Use precision/recall,
F1, or PR-AUC — metrics that don't let the majority class hide the
failure on the minority. (This is where confusion matrices come in —
see `08-confusion-matrices.md`.)

**Sub-step C — the faint flattr analog, named honestly.**

```
  Faint analog — steep edges are RARE, but it's feature skew not class skew

  graph.json edge grades:  most edges flat/moderate (green band)
                           few edges steep (red, >8%)  ← rare
  this is a skewed FEATURE distribution, NOT imbalanced LABELS
  it would matter only IF a model trained on these edges,
  and even then it's a data-coverage issue, not class imbalance
```

If a learned cost ever trained on per-edge data, steep edges being rare
means the model sees few steep examples and may fit them poorly — but
that's *data sparsity in a feature region*, which you'd fix by sampling
or weighting steep edges, not by SMOTE on a label. Name the resemblance,
don't claim it's the same thing.

### Move 3 — the principle

Class imbalance is an artifact of *classification with skewed labels*.
flattr neither classifies (its band logic is thresholds) nor has labels.
The honest move is to recognize the smell — a rare-but-important region
(steep edges) — and call it what it is: feature-distribution sparsity,
addressed at the data-sampling layer, not a class-imbalance fix.

## Primary diagram

```
  Class imbalance vs flattr's actual situation

  CLASS IMBALANCE (not in flattr)
  labels skewed 95/5 → naive model ignores the 5% → wrong metric
        │ requires: a classifier + labels
        ▼ flattr has neither

  flattr's faint analog (feature skew, honest)
  ┌─ graph.json grades ─────────────┐
  │ flat ████████████  steep █       │  ← rare steep edges
  └─────────────────────────────────┘
  matters only IF a model trains on edges → fix at SAMPLING,
  not a class-imbalance technique
```

## Elaborate

The reason it's worth keeping these distinct: the fixes don't transfer.
SMOTE-ing a rare class label is meaningless for a rare *feature region* —
you'd be synthesizing fake steep edges that may not exist in the real
street graph, polluting the cost with imagined geometry. The correct
analog response is to *weight* the loss higher on real steep edges so the
cost fits them well, or simply accept that steep edges are rare and the
hand-tuned quadratic (cost.ts:21) already covers that region without
data. flattr's steep band being rare is an argument *for* keeping the
hand-tuned penalty in that region, not for a rebalancing trick.

## Project exercises

### IMB.1 — write the honest "no home" note

- **Exercise ID:** IMB.1
- **What to build:** a short note in the study docs (or a code comment on
  `classify.ts`) stating that the band logic is a threshold table, not a
  classifier, so class imbalance does not apply — and naming steep-edge
  rarity as feature skew instead.
- **Why it earns its place:** killing the false positive (someone reads
  `classify.ts` and thinks "imbalanced classes") is the actual value here.
- **Files to touch:** `features/grade/classify.ts` (a one-line comment
  above `classifyAbs`), this study file.
- **Done when:** the comment states classify.ts is thresholds, not a
  trained classifier, so imbalance is N/A.
- **Estimated effort:** 30 minutes.

## Interview defense

**Q: How would you handle class imbalance in flattr?** Answer: flattr
doesn't classify — the band logic in `classify.ts` is a threshold table,
and the cost is regression-shaped — so there are no labels to be
imbalanced. The honest answer is the concept doesn't apply. The faint
analog is that steep edges are rare in the graph, but that's *feature*
skew, not class imbalance; if a model trained on edges I'd weight the
steep examples, not SMOTE a label. I'd resist forcing a classification
frame where the system is thresholds and regression.

```
  imbalance needs labels → flattr has none → N/A
  rare steep edges = feature skew (weight it), not class skew (SMOTE)
```

Anchor: *"`classify.ts` is `if/else` over thresholds, not a classifier —
there's no class distribution to be imbalanced."*

## See also

- [08-confusion-matrices.md](08-confusion-matrices.md) — the metric you'd reach for if labels existed.
- [02-feature-engineering.md](02-feature-engineering.md) — steep-edge rarity as a feature, not a label.
- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the cost is regression-shaped, not classification.
