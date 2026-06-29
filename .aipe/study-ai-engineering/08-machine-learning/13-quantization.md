# Quantization

*Industry name: quantization — reducing numeric precision to shrink and speed up a model.*

## Zoom out

```
SAME WEIGHTS, FEWER BITS
float32 weight  3.14159265  ──► int8  ≈ 3.1
   4 bytes                        1 byte
   ┌──────────────────────────────────────┐
   │ 4× smaller · faster math · less power │
   │ small accuracy loss                    │
   └──────────────────────────────────────┘
```

Quantization stores and computes model weights at lower precision (float32 → int8, even
int4). The model gets ~4× smaller and faster with a small accuracy hit — the standard move
to make a model *fit and run* on a phone. Directly relevant to your contrl world, where the
device budget is everything. New ground as a *technique* (contrl used a pre-optimized
model; you didn't quantize one yourself).

## How it works

### Move 1 — the mental model: round the weights to a coarser grid

```
float32: ●····●····●····●  (fine grid, 4 bytes each)
int8:    ●    ●    ●    ●   (256 levels, 1 byte each)
            ▲ map each real weight to the nearest coarse level
```

A trained model's weights are floats. Most of that precision is wasted — the model still
works if you snap each weight to one of 256 int8 levels, given a per-tensor scale factor.

### Move 2 — the two flavors + the on-device payoff

```
POST-TRAINING QUANT (PTQ)        QUANT-AWARE TRAINING (QAT)
train float → quantize after     simulate int8 DURING training
fast, no retrain, slight drop    best accuracy, needs the train loop
↑ try this first                 ↑ if PTQ drops too much
```

Why it matters for the contrl-shaped on-device model (file 12):

- **Size:** a quantized model downloads faster and ships in the app bundle — matters for an
  on-device elevation-infill model you'd want to embed, not fetch.
- **Speed/battery:** int8 math is faster and cheaper on mobile NPUs — the exact budget
  contrl lives in (frame-rate deadline per pose frame).
- **The trade:** quantization adds rounding noise. For a flattr cost/grade model bound by
  the **≥0/monotone** invariant (file 04), you'd verify *after* quantizing that rounding
  didn't break monotonicity or push an output negative — int8 noise could nudge a near-zero
  penalty below zero, which A* forbids. Clamp the dequantized output ≥ 0 to be safe.

### Move 3 — the principle

**Precision is a budget, not a given.** Most models keep nearly all their accuracy at int8.
On-device, where bytes and milliwatts are scarce, quantization is usually free money — but
*verify the invariants survive the rounding*, because lower precision can violate
constraints that held in float.

## In this codebase

**NOT YET EXERCISED — flattr has no model, so there is nothing to quantize.** Everything is
exact arithmetic: `features/routing/cost.ts` does float math on real grades;
`pipeline/grade.ts` computes grades from elevation deltas. No weights, no precision to trim.

Quantization would enter only if the contrl-shaped on-device infill model (file 12, at
`pipeline/elevation.ts`) or a learned `cost.ts` were shipped — then you'd quantize to fit
the phone budget, exactly as you'd do for contrl, while re-checking the ≥0/monotone
guarantees post-quant. `features/grade/classify.ts` is a threshold table; there are no
weights to compress.

## See also

- `12-on-device-inference.md` — the device budget quantization serves (contrl anchor)
- `07-transfer-learning.md` — shrinking a transferred model after fine-tuning
- `04-model-selection.md` — the ≥0/monotone invariant quantization must not break
</content>
