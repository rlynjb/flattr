# Token Economics
*Token-based pricing — Industry standard*

## Zoom out

LLM bills are denominated in tokens (file 02), split into input (prompt) and output (completion) — and output typically costs ~5x input per token. Knowing this changes design: you pay to make the model *talk*, not to make it *read*. You've watched this meter run on AdvntrCue; flattr's hypothetical volume is so small the meter would barely move.

```
LAYERS — where the bill is computed
┌─────────────────────────────────────────────┐
│ prompt tokens (cheap)   ─► [ LLM ] ─► output  │
│                                       tokens   │
│   cost = in·$_in  +  out·$_out                 │ ◄── out rate ≈ 5x in
└─────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Two meters: input tokens (everything you send — system prompt + context + user text) and output tokens (everything generated). Output is the expensive one, often ~5x the input rate, because generation is the compute-heavy autoregressive loop. So a long prompt with a short answer is cheap; a short prompt that triggers a verbose answer is not. Cap output length; trim input only when it's actually large.

```
PATTERN — the two meters (illustrative rates)
  input:  2000 tok × $X      ── the cheap meter
  output:  200 tok × $5X     ── the expensive meter
                              ── short answer ≠ cheap if you don't cap it
```

**Move 2 — the mechanism.** You're billed per token both directions; the provider counts after tokenization, so your char→token estimate (file 02) feeds your cost estimate. Levers, in order of impact: cap `max_tokens` on output, reuse/cache static prompt prefixes if the provider supports it, and only then prune input context. A "describe my route" call sends ~a few hundred input tokens and asks for one sentence (~20 output tokens) — fractions of a cent, even at scale.

```
MECHANISM — cost levers, biggest first
  1. cap max_tokens (output) ──────────► biggest lever
  2. cache static prompt prefix
  3. trim input context  ──────────────► only if input is large
```

**Move 3 — principle.** Budget the output first — you pay most to make the model speak, least to make it listen.

## In this codebase

**Not yet exercised in flattr.** There is no LLM, no cost ledger, no metering — nothing to bill. If the `features/routing/summary.ts:11` narration existed, volume would be trivial: tiny structured input, one-sentence output, called only when a user resolves a route. No batching, no high-throughput path, no need for a cost guardrail. The honest answer is that token economics is a real discipline you've practiced elsewhere, but flattr would never feel it — there's no attachment point for a cost ledger because there's no spend to track.

## See also
- [02 — Tokenization](02-tokenization.md)
- [05 — Streaming](05-streaming.md)
