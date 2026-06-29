# Transfer Learning

*Industry name: transfer learning — reusing pretrained weights for a new task.*

## Zoom out

```
DON'T START FROM ZERO
┌────────────────────────┐        ┌──────────────────────┐
│ PRETRAINED model        │  ───►  │ YOUR task             │
│ (millions of examples,  │ reuse  │ (a few hundred labels)│
│  generic features)      │ layers │ fine-tune the top     │
└────────────────────────┘        └──────────────────────┘
```

Transfer learning is the single biggest reason small teams can ship ML: take a model
someone else trained on a giant dataset, keep its learned general features, and adapt only
the last bit to your task with *far* less data. **You've already done this** — contrl ran a
**pretrained MediaPipe pose model** you never trained. That's transfer learning at its
purest: reuse the pretrained landmark detector, build your rep-counter on top.

## How it works

### Move 1 — the mental model: borrow the eyes, retrain the verdict

```
PRETRAINED NET (frozen)              YOUR HEAD (trained)
[ early layers: edges, shapes ] ──► [ task layer: "is this a rep?" ]
       generic, reusable                 specific, cheap to fit
```

Early layers learn generic structure (edges, textures, body landmarks) that transfer
across tasks. Only the final layer(s) are task-specific. So you freeze the bottom and train
a small head — minutes and hundreds of examples, not weeks and millions.

### Move 2 — the spectrum, and the contrl anchor

```
FEATURE EXTRACTION  ◄──────────────────────────►  FULL FINE-TUNE
freeze everything,    unfreeze top layers,         retrain all weights
train a new head      train head + a few layers     (needs most data)
↑ contrl is HERE      ↑ more data, more drift risk   ↑ rarely worth it small
(MediaPipe frozen,
 rep logic on top)
```

- **contrl (your shipped case):** MediaPipe outputs pose landmarks; you wrote the
  rep-counting logic on top. The heavy model was frozen and pretrained — you transferred
  its "understanding of a human body" for free.
- **A flattr version (hypothetical):** suppose someone pretrained a general
  grade→cost / terrain-comfort model on dozens of cities. flattr could **fine-tune** it on
  a few hundred Seattle labels instead of training from scratch — directly addressing the
  domain gap (file 06). The catch carries over from file 04: after fine-tuning, the
  resulting `f` for `cost.ts` still must be **≥0 and monotone in grade**, so you'd constrain
  the fine-tune (or wrap the output), not let it drift free.

### Move 3 — the principle

**Reuse generic representations; learn only what's specific to you.** The less you train,
the less data and compute you need — and the less you can break the pretrained model's
hard-won general structure. The trade: transferred features assume the new domain *resembles*
the source domain; too big a gap (file 06) and transfer stops helping.

## In this codebase

**NOT YET EXERCISED — flattr has no model, pretrained or otherwise.** There is nothing to
transfer *from* and nothing to transfer *into*. The honest anchor is **contrl, not flattr**:
your MediaPipe pipeline is the transfer-learning experience to draw on. flattr's equivalent
would only exist if a learned **`features/routing/cost.ts`** started from a pretrained
multi-city terrain model rather than from random weights.

`features/grade/classify.ts` has no weights at all — there is nothing pretrained to reuse;
its thresholds are constants, not transferred parameters.

## See also

- `06-domain-gap.md` — why you'd fine-tune (close the city gap) instead of training fresh
- `12-on-device-inference.md` — contrl's on-device serving of the transferred model
- `13-quantization.md` — shrinking a transferred model to fit on the phone
</content>
