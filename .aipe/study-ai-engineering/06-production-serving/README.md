# 06 — Production Serving

How an AI feature behaves once it's *running in front of users*: caching, cost, security, and surviving flaky dependencies. These are the operational concerns that separate a demo from a product.

**Honest framing for flattr:** there is **no LLM in production** here — no model serving, no inference, no token bill. So most of this section is *study material*: the pattern, then the closest real seam or analog already in the codebase. flattr earns its place because it does the *underlying* serving patterns (caching, rate limiting, retry) correctly against real external APIs — the muscle transfers directly to LLM serving.

**★ One genuine, latent concern: `03-prompt-injection.md`.** This is the single file where flattr has a real (future) security exposure, not just an absence. OSM `display_name` (`pipeline/geocode.ts:27,52,69`) is crowd-edited, server-controlled, **untrusted** text. Today it's a harmless map label. The moment it's templated into any prompt (e.g. route narration at `features/routing/summary.ts:11`), a place named *"Ignore previous instructions and…"* becomes a model instruction. Design the defense in before the first narration call ships.

## Files

| # | Concept | flattr status | Real seam / analog |
|---|---------|---------------|--------------------|
| 01 | [LLM Caching](01-llm-caching.md) | not exercised | `graph.json` is a prebuilt cache; `mobile/src/elevCache.ts` is a textbook cache |
| 02 | [LLM Cost Optimization](02-llm-cost-optimization.md) | N/A (no token bill) | Open-Meteo quota cost — dedup, batch, provider routing in `pipeline/elevation.ts` |
| 03 | [Prompt Injection](03-prompt-injection.md) ★ | **latent, real** | untrusted OSM `display_name` — `pipeline/geocode.ts:27,52,69` → future prompt seam |
| 04 | [Rate Limiting & Backpressure](04-rate-limiting-backpressure.md) | not exercised (for LLM) | sequential Nominatim calls `MapScreen.tsx:189`; batch+throttle `elevation.ts` |
| 05 | [Retry & Circuit Breaker](05-retry-circuit-breaker.md) | not exercised (for LLM) | **working** 429 retry-with-backoff `elevation.ts:107–119`; fail-fast geocode |

## The thread

```
  Every concept here already lives in flattr — pointed at a MAP API,
  not a model. Caching, rate limiting, retry: all correct, all today.
  Adding an LLM later reuses these exact shapes with a prompt as the
  payload. The one NEW risk an LLM introduces is prompt injection (03),
  and the untrusted vector for it is already flowing through the code.
```

## See also

- `../05-evals-and-observability/` — verifying output (the backstop for injection)
- `../04-agents-and-tool-use/` — injection severity scales with tool access
- `../ai-features-in-this-codebase.md` — the honest inventory of where AI does / doesn't exist
