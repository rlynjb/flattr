# Quantization — on-device precision tradeoff, with an A* twist

**Industry name(s):** quantization / model compression (int8, fp16).
**Type:** Industry standard (the standard on-device shrink technique).

## Zoom out — quantization would shrink a learned cost, but flattr's model is already tiny

Quantization stores model weights in lower precision — fp32 → int8 — to
shrink the artifact and speed inference, trading a little accuracy for a
lot of size and speed. It's the workhorse of on-device ML. flattr has no
model to quantize, and the *would-be* learned cost is so small (a linear
model or tiny monotone GBT) that quantization buys almost nothing. But
there's a flattr-specific wrinkle worth teaching: quantizing the cost's
output precision risks breaking the *monotonicity* A* depends on.

```
  Zoom out — quantization sits between train and on-device deploy

  trained cost (fp32 weights)
        │  quantize (NOT needed for a tiny model)
        ▼
  int8 weights → smaller artifact, faster, slightly less precise
        │
        ▼  ★ cost.ts penalty() on-device
           A* twist: low precision could make 8% and 9% cost EQUAL
           → ties break monotonicity → admissibility risk
```

For a giant neural net, quantization is essential. For flattr's tiny cost,
it's mostly unnecessary — and where it'd apply, the precision loss
threatens the A* invariants more than it helps.

## Structure pass

- **Layers:** fp32 trained weights → quantization (post-training or
  quant-aware) → low-precision artifact → on-device inference.
- **Axis — precision vs size/speed.** More bits = accurate but big; fewer
  bits = small/fast but lossy. flattr's model is small enough that the
  trade barely registers.
- **Seam:** the cost's numeric output. Quantizing it coarsens the cost
  scale, which interacts with both calibration (`09`) and admissibility
  (`04`).

## How it works

### Move 1 — the mental model

Quantization is lossy compression for weights. Like dropping a photo from
24-bit to 8-bit color: way smaller, mostly fine, but you can see banding
in smooth gradients. For a model, the "banding" is coarser numeric output
— values that were distinct round to the same bucket.

```
  Pattern — precision vs size

  fp32 weights ──► int8 weights
  4 bytes/weight    1 byte/weight   → 4× smaller, faster int math
  cost: small accuracy loss (rounding to coarse buckets)
```

### Move 2 — the walkthrough

**Sub-step A — why flattr barely needs it.**

```
  flattr's would-be cost is already tiny

  linear cost:        a handful of fp32 coefficients → bytes, not MB
  small monotone GBT: a few small trees → KB
  quantization shrinks MB→KB models; flattr's is KB already
  → negligible size win, real precision RISK → usually skip
```

This is the honest headline: quantization matters when the model is big.
flattr's model is small by design (model-selection + on-device both push
tiny), so the technique's main payoff doesn't apply.

**Sub-step B — the A* twist: precision and monotonicity.**

```
  Quantization vs the monotonicity invariant

  fp32:  penalty(8%) = 3.20,  penalty(9%) = 3.31   (distinct, monotone↑)
  int8:  penalty(8%) = 3.0,   penalty(9%) = 3.0    (COLLAPSED → tie)
  a tie isn't strictly decreasing → mostly OK for admissibility
  BUT coarse buckets can also INVERT near boundaries → 9% < 8% → ILLEGAL
  → if you ever quantize, RE-VERIFY monotonicity on the quantized fn
```

The same property test from `04-model-selection` (monotone & ≥0) must run
*on the quantized model*, not just the fp32 one — quantization can break
a property the float model satisfied.

**Sub-step C — and the finite-BLOCKED edge.** Over-max must map to a large
*finite* number (cost.ts:5, `BLOCKED = 1e9`). Low-precision int types
can't even represent 1e9 — int8 maxes at 127. So a naively quantized cost
would either overflow or saturate the BLOCKED sentinel, collapsing the
"flattest-but-steep vs disconnected" distinction. Any quantization scheme
has to preserve a representable large-finite over-max value.

### Move 3 — the principle

Quantization trades precision for size and speed, and it's essential for
big on-device models. flattr's learned cost is tiny by design, so the
trade rarely pays — and where it would, the precision loss threatens two
A* invariants (monotonicity near grade boundaries, and the
large-but-finite BLOCKED value int8 can't even hold). The mature call:
quantization is a tool for when the model is big enough to need it, and
flattr's isn't — but if you ever apply it, re-verify the admissibility
properties on the quantized function, because float-level guarantees don't
survive quantization for free.

## Primary diagram

```
  Quantization vs flattr's tiny cost (mostly unneeded, A*-risky)

  ┌─ trained cost (fp32) ───────────────────────┐
  │ linear coeffs / small GBT → already KB        │
  └──────────────┬────────────────────────────────┘
  ┌─ quantize? ──▼───────────────────────────────┐
  │ size win: negligible (already small)          │
  │ risk: coarse buckets near grade boundaries    │
  │       → ties or INVERSIONS → monotonicity?    │
  │ risk: int8 can't hold finite BLOCKED (1e9)    │
  └──────────────┬────────────────────────────────┘
  ┌─ if applied: RE-VERIFY ─▼────────────────────┐
  │ monotone↑ in grade & ≥0 ON the quantized fn   │
  │ over-max → representable large finite value   │
  └────────────────────────────────────────────────┘
```

## Elaborate

The deep point is that quantization is *another* place where flattr's
A*-correctness contract reaches into an ML decision. For a generic model,
quantization's only cost is a slightly worse metric. For flattr's cost,
quantization can violate a *correctness* property (monotonicity → A*
optimality) and a *representation* property (finite BLOCKED → the
no-route distinction). So the answer to "would you quantize?" isn't "sure,
standard practice" — it's "no, the model's already tiny, and if I did I'd
re-run the admissibility property tests on the quantized function because
those guarantees don't transfer." That nuance — quantization interacting
with an optimization invariant — is what separates a rote answer from one
that understands the system.

## Project exercises

### QUANT.1 — re-verify invariants under simulated quantization

- **Exercise ID:** QUANT.1
- **What to build:** a test that rounds `penalty`'s output to a coarse
  grid (simulating quantization) and re-runs the monotone/≥0 property
  check, demonstrating whether coarse buckets break the invariant near
  grade boundaries.
- **Why it earns its place:** it proves the float-level guarantee doesn't
  automatically survive precision loss — the exact trap quantization sets
  for an A*-embedded cost.
- **Files to touch:** `features/routing/cost.test.ts` (add a
  quantize-then-verify case), reuse the `assertMonotoneNonNeg` helper from
  MODEL.1.
- **Done when:** the test shows a fine grid keeps `penalty` monotone and a
  deliberately coarse grid breaks it, making the risk concrete.
- **Estimated effort:** 2-3 hours.

## Interview defense

**Q: Would you quantize flattr's learned cost?** Answer: almost certainly
not. The model is tiny by design — a linear cost or small monotone GBT,
already kilobytes — so quantization's size win is negligible. And it's
risky here: coarse int buckets can make a 9% grade tie or even invert
below an 8% grade near boundaries, breaking the monotonicity A* needs, and
int8 can't even represent the large-but-finite BLOCKED value (1e9). If I
ever did quantize, I'd re-run the admissibility property tests on the
quantized function, because float guarantees don't survive precision loss.

```
  quantize big models for size/speed
  flattr cost: already tiny → skip; if applied, RE-VERIFY monotone + BLOCKED
```

Anchor: *"`BLOCKED = 1e9` (cost.ts:5) — int8 can't hold it, and coarse
buckets can break monotonicity, so quantization fights A*'s invariants."*

## See also

- [12-on-device-inference.md](12-on-device-inference.md) — the on-device budget quantization usually serves.
- [04-model-selection.md](04-model-selection.md) — the monotone property quantization can break.
- [09-calibration.md](09-calibration.md) — precision loss also coarsens the cost scale.
