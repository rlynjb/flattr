# Transfer learning — new ground, no real flattr home

**Industry name(s):** transfer learning / fine-tuning / pretraining.
**Type:** Industry standard (dominant in deep learning, rare in tabular).

## Zoom out — nothing to transfer FROM or TO in flattr

Transfer learning reuses a model trained on one task as the starting
point for another — load pretrained weights, fine-tune on your data.
flattr has no model and no weights, so there's nothing to transfer. The
faint analog is reusing a *cost fit on city A* as the warm start for
*city B* — but that's a stretch for a tiny tabular cost, and the honest
answer is usually "you'd just retrain." This file teaches the concept as
new ground.

```
  Zoom out — transfer learning needs a source model (flattr has none)

  ┌─ SOURCE model (does not exist) ─┐
  │ pretrained weights on big data   │
  └────────────┬─────────────────────┘
               │ transfer / fine-tune
  ┌─ TARGET task ─▼─────────────────┐
  │ flattr's learned cost (also none)│
  └──────────────────────────────────┘
  reality: no source, no target → nothing transfers
```

## Structure pass

- **Layers:** pretrained source → frozen/fine-tuned layers → target-task
  head → target data.
- **Axis — train-from-scratch vs transfer.** Transfer wins when target
  data is scarce and a related source model exists. flattr's would-be cost
  has *neither* a source model nor enough data to need one.
- **Seam:** there is none in flattr. The nearest hook is initializing a
  city-B cost from a city-A fit (see Move 2.C), which is warm-starting,
  not true transfer learning.

## How it works

### Move 1 — the mental model

You already used transfer learning without training it: contrl's
MediaPipe pose model is a *pretrained* network Google trained on millions
of images; you consumed its landmark outputs. That's transfer at the
consumption layer — reuse someone's learned representation instead of
training one. Transfer *learning* proper goes one step further: you
fine-tune those pretrained weights on your own data.

```
  Pattern — transfer learning

  big pretrained model ──► freeze early layers
                           fine-tune late layers on YOUR small data
                           = strong model from little data
```

### Move 2 — the walkthrough (as new ground)

**Sub-step A — when it's the right tool.**

```
  Transfer wins when…

  target data is SMALL        (can't train from scratch)
  a related SOURCE exists     (vision, language, audio backbones)
  the representation reuses    (edges/textures, grammar, phonemes)
```

This is deep-learning territory — vision, NLP, audio. Tabular models like
flattr's would-be cost rarely transfer; there's no rich learned
representation to reuse in a 5-feature regression.

**Sub-step B — why flattr's cost doesn't qualify.**

```
  Why no transfer for the flattr cost

  it's tabular & tiny (grade, length, surface) → no representation
  no pretrained "routing cost" backbone exists  → no source
  retraining from scratch is cheap              → no need to transfer
```

**Sub-step C — the only faint analog: warm-starting city B from city A.**

```
  Faint analog — NOT transfer learning, just initialization

  city A cost (k1=0.5, k2=1.1, fit)  ──► city B starts from those
  then refit on city B's data        ──► drifts to B's distribution
  this is "warm start", a footnote, not transfer learning
```

Even this is shaky: a 2-parameter cost refits so fast that the warm start
saves nothing. Call it warm-starting and move on; don't dress it up as
transfer learning.

### Move 3 — the principle

Transfer learning earns its place when you have little target data and a
rich pretrained representation worth reusing. flattr's prospective cost is
small, tabular, and cheap to refit — none of the preconditions hold. The
mature answer is to recognize that and not reach for transfer learning
where retraining-from-scratch is simpler. The discipline is matching the
technique to the situation, and here the situation says "no."

## Primary diagram

```
  Transfer learning vs flattr (no home)

  TRANSFER LEARNING (deep, data-scarce)
  pretrained backbone ──► fine-tune head ──► strong small-data model
        │ requires: a source model + a reusable representation
        ▼ flattr has neither

  flattr's reality
  ┌─ tiny tabular cost ─┐  refit from scratch is cheap
  │ grade,len,surface    │  warm-start city→city = footnote, not TL
  └──────────────────────┘
```

## Elaborate

The contrl connection is worth holding onto because it's the *correct*
shape of "transfer" in your portfolio: you consumed a pretrained model
rather than training a representation from scratch. If flattr ever grew a
component that needed a learned representation — say, predicting surface
type from a street-level image — *that* would be a transfer-learning home
(fine-tune a vision backbone). But flattr has no camera and no image input
(unlike contrl), so even that door is closed. The honest map: transfer
learning is for rich representations and scarce data; flattr's cost has
neither.

## Project exercises

### TL.1 — warm-start vs scratch refit comparison (honest negative result)

- **Exercise ID:** TL.1
- **What to build:** if a learned cost ever exists, an experiment that
  fits city B's cost two ways — from scratch and warm-started from city
  A's parameters — and reports that the difference is negligible for a
  tiny tabular model (the expected honest result).
- **Why it earns its place:** documenting *why a technique doesn't help*
  is as valuable as using one; it stops you reaching for transfer learning
  reflexively.
- **Files to touch:** (hypothetical) `pipeline/cost-train.ts` — add a
  warm-start init path and log convergence steps both ways.
- **Done when:** the experiment shows warm-start saves <1 iteration on the
  2-parameter cost, confirming transfer learning is unjustified here.
- **Estimated effort:** half a day (only if a learned cost exists).

## Interview defense

**Q: Would transfer learning help flattr?** Answer: no, and being able to
say why is the point. Transfer learning reuses a rich pretrained
representation when target data is scarce — vision and language
backbones. flattr's would-be cost is a tiny tabular regression over
grade, length, and surface; there's no representation to reuse and
retraining from scratch is cheap. I consumed a pretrained model in contrl
(MediaPipe pose), which is the consumption flavor of transfer, but flattr
has no image input and no source model. Forcing transfer learning here
would be cargo-culting a deep-learning technique into a place it doesn't
fit.

```
  transfer learning needs: scarce data + rich pretrained backbone
  flattr cost: cheap to refit + no backbone → retrain from scratch
```

Anchor: *"contrl consumed a pretrained pose model — that's the only
transfer-shaped thing in my portfolio, and flattr has no image input to
repeat it."*

## See also

- [06-domain-gap.md](06-domain-gap.md) — the across-city problem transfer would *try* to solve.
- [04-model-selection.md](04-model-selection.md) — why the cost is tiny and tabular.
- [11-cold-start.md](11-cold-start.md) — the real flattr answer to "no data yet": rules, not transfer.
