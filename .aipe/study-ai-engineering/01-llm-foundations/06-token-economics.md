# Token economics

**Industry name(s):** token economics / cost ledger / price-per-1K-tokens
/ unit economics. **Type:** Industry operational discipline.

## Zoom out — where this would sit in flattr

You pay per token — input and output, at different rates — and that's the
whole bill for a cloud LLM. So cost scales with prompt size × call volume.
flattr makes **no model call**, so its LLM bill is exactly zero. The
would-be route-describe call is the cheapest possible kind: three numbers
in, one sentence out — tens of tokens. And because flattr is local-first
Expo, the *right* default is on-device inference (dryrun-style), where the
marginal cost per call is literally zero — you pay for the download, not
the request.

```
  Zoom out — the (tiny) cost ledger flattr would have

  ┌─ engine ────────────────────────────────────────────────┐
  │ routeSummary() ─► RouteSummary {distanceM,climbM,steep}  │
  └────────────────────────────┬─────────────────────────────┘
                              │ summary.ts:5
  ┌─ ★ would-be call — pick the cheap lane ─▼───────────────┐
  │ on-device (dryrun-style)  → $0 marginal / call  ◄ default│
  │ cloud fallback            → ~30 tok in + ~25 out         │
  │                             = fractions of a cent / call │
  └──────────────────────────────────────────────────────────┘
```

flattr has **no cost ledger** because it has no model. The lesson: the
describe seam is so small that cost is a non-issue, and local-first makes
it zero — so cost should never be the reason *not* to add it.

## Structure pass

- **Layers:** engine (free) → would-be LLM call (priced) → UI.
- **Axis — marginal cost per call:** above the LLM boundary every
  operation is free CPU. At a *cloud* LLM boundary each call costs
  input-tokens × rate + output-tokens × rate. At an *on-device* boundary
  the marginal cost flips back to ~zero (fixed model download, free
  inference). The axis is "what does the next call cost?"
- **Seam:** the cost flips at `summary.ts:5` → the describe call. Which
  lane you pick (on-device vs cloud) decides whether the marginal cost is
  zero or a few hundredths of a cent.

## How it works

### Move 1 — the mental model

You know an n+1 query problem: one cheap call becomes thousands and the
bill explodes. LLM cost is the same shape — per-call price × volume — but
with a twist: the price is proportional to *token count*, and output
tokens usually cost more than input. So a cost ledger tracks tokens-in,
tokens-out, and calls.

```
  Pattern — the cost of an LLM feature

  cost = calls × (in_tokens × in_rate + out_tokens × out_rate)

  flattr describe (cloud):  ~30 in  + ~25 out  per route
  big-RAG app:           ~4000 in  + ~600 out per query   ← 100x+ flattr
  on-device (dryrun):       $0 marginal — fixed model download
```

### Move 2 — the walkthrough

**The input is three numbers — cost is structurally tiny.** `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

A describe prompt over this is ~30 input tokens, ~25 output. Even at cloud
rates that's a fraction of a cent per route. There's no document stuffing,
no chat history, no retrieval context — the thing that makes RAG apps
expensive is simply absent. The bounded prompt
([02-tokenization.md](02-tokenization.md)) is also a bounded *bill*.

```
  Layers-and-hops — where the meter would (barely) run

  ┌─ engine ──┐ {3 numbers}   ┌─ describe call ──┐ blurb
  │routeSummary│ ───────────► │ ~30 in / ~25 out │ ──► UI
  └───────────┘  (free CPU)   └────────┬─────────┘
                                  cost flips here (summary.ts:5)
                          on-device → $0   |   cloud → ~¢0.00x
```

**Local-first makes it zero.** flattr already runs offline-capable Expo;
the dryrun pattern (on-device model with cloud fallback) fits naturally.
On-device, the marginal cost per describe is zero — you amortize a
one-time model download. Cloud is a *fallback* for when on-device isn't
available, and even then the bill is trivial because the prompt is three
numbers. (See [08-provider-abstraction.md](08-provider-abstraction.md) for
the on-device-vs-cloud factory.)

**Where cost could sneak up.** Volume. If you described *every* route on
*every* slider drag, calls multiply. The cheap defense is the cache keyed
on `RouteSummary` (sound because temp=0,
[03-sampling-parameters.md](03-sampling-parameters.md)) — identical
summaries don't re-call. That, plus on-device default, keeps the ledger at
zero in practice.

### Move 3 — the principle

LLM cost is per-token × volume; design the input small and the call rare
and the bill stays negligible. flattr's describe seam is the easy case —
tiny input, low volume, and a local-first runtime that makes on-device the
zero-cost default. Cost is not a reason to skip this feature.

## Primary diagram

```
  Token economics — flattr's would-be ledger is ≈ $0

  ┌─ engine (free CPU) ─────────────────────────────────────┐
  │ RouteSummary {3 numbers}                                 │
  └────────────────────────────┬─────────────────────────────┘
                            summary.ts:5  ← cost flips here
  ┌─ would-be describe call (NOT BUILT) ────▼───────────────┐
  │ on-device (dryrun)  → $0 marginal  ◄ local-first default │
  │ cloud fallback      → ~30 in/25 out → ¢0.00x, cache it   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The discipline in real apps: log tokens-in/out per call, attribute cost
per feature, set a budget, and watch for volume amplification (loops,
retries, per-keystroke calls). flattr inverts the usual worry — the prompt
is so small that the *only* cost lever is call volume, killed by caching
and on-device inference. In Rein's portfolio, AdvntrCue (cloud GPT-4) is
where the ledger actually matters; flattr is the "cost is a non-issue"
end of the spectrum, by design.

## Project exercises

### B-TE.1 — token+cost log on the stub

- **Exercise ID:** B-TE.1
- **What to build:** wrap `describeRoute` so each call logs estimated
  tokens-in/out and a cost estimate (cloud rate constant), proving the
  per-call bill is sub-cent.
- **Why it earns its place:** it makes the "cost is negligible" claim a
  measured ledger at the real seam.
- **Files to touch:** new `features/routing/describe.ts`;
  `mobile/src/MapScreen.tsx:159` (call site).
- **Done when:** the log shows token counts and a sub-cent estimate.
- **Estimated effort:** 1 hr.

### B-TE.2 — volume guard via cache

- **Exercise ID:** B-TE.2
- **What to build:** cache `describeRoute` on the rounded `RouteSummary`
  so slider drags that don't change the summary don't re-call, capping
  volume.
- **Why it earns its place:** it closes the one real cost lever (volume)
  at the seam where slider changes drive recomputation.
- **Files to touch:** `features/routing/describe.ts`;
  `mobile/src/MapScreen.tsx:159` (recompute site), `:381` (GradeSlider).
- **Done when:** repeated identical summaries hit the cache; a test proves
  no extra calls.
- **Estimated effort:** 1 hr.

## Interview defense

**Q: What would an LLM route description cost flattr?** Answer: Near zero.
The input is three numbers (~30 tokens in, ~25 out), so even cloud rates
are fractions of a cent per route — and flattr is local-first, so the
right default is on-device inference (dryrun-style) where the marginal cost
is literally zero. The only cost lever is volume, which a cache keyed on
`RouteSummary` kills. Cost is never the reason to skip this.

```
  {3 numbers} → on-device → $0   |   cloud → ¢0.00x (cache it)
```

Anchor: *"the describe prompt is three numbers — tiny bill, and on-device
makes it zero; cost is a non-issue at the summary.ts:5 seam."*

## See also

- [02-tokenization.md](02-tokenization.md) — tokens as the billing unit.
- [08-provider-abstraction.md](08-provider-abstraction.md) — on-device vs cloud lane.
- [03-sampling-parameters.md](03-sampling-parameters.md) — temp 0 makes caching sound.
