# LLM Caching

*Industry name: response / prompt caching — a production-serving optimization.*

## Zoom out

```
  Serving stack (where caching lives)
  ┌─────────────────────────────────────────────┐
  │  client request                              │
  │      │                                       │
  │      ▼                                        │
  │  ┌─────────┐  hit   ┌──────────────┐          │
  │  │  CACHE  │───────►│ return saved │  cheap   │
  │  └────┬────┘        └──────────────┘          │
  │       │ miss                                   │
  │       ▼                                        │
  │  ┌──────────────┐  store  ┌─────────┐          │
  │  │ EXPENSIVE OP │────────►│  CACHE  │  costly  │
  │  └──────────────┘         └─────────┘          │
  └─────────────────────────────────────────────┘
```

Caching is the oldest trick in serving: if the same expensive computation will be asked for again, do it once and keep the answer. For LLMs the "expensive op" is the model call (dollars + latency), and the key is usually the prompt (or a normalized hash of it). You ship a cache when the same inputs recur and the output is deterministic-enough to reuse.

## How it works

### Move 1 — the pattern: key → stored value

```
  prompt ──hash──► key ──lookup──► [value | MISS]
```

Mental model: a cache is a pure function memoizer wearing a TTL. The only hard parts are (1) choosing a key that means "same request" and (2) deciding when a stored value goes stale. LLM caching has two flavors:

- **Exact-prompt cache** — key = hash(full prompt). Trivial, brittle (one token differs → miss).
- **Provider prompt caching** — the *provider* caches your long, stable prefix (system prompt, tools, big context) so repeated calls only pay for the changing tail. Different mechanism, same goal: don't recompute the stable part.

### Move 2 — step by step (exact-prompt cache)

```
  1. normalize prompt   "Route A→B, max 8%"  ─► canonical string
  2. key = sha256(canonical)
  3. GET key from store ──► hit?  ─► return cached sentence
  4. miss ─► call model ─► get sentence
  5. SET key = sentence  (with TTL / size cap)
  6. return sentence
```

The store is anything with get/set: an in-memory `Map`, AsyncStorage on device, Redis server-side. The size cap + eviction policy (LRU, insert-order drop) is what keeps it from eating memory.

### Move 3 — the principle

**Cache the expensive, stable, recurring computation — wherever it lives.** "LLM caching" is just this principle pointed at model calls. The same principle already shows up all over a routing engine; the model is incidental.

## In this codebase

**NOT YET EXERCISED as LLM caching** — there is no model call to cache. But flattr is *built around* the exact same pattern, twice:

```
  EXPENSIVE OP                          CACHE (compute once, reuse)
  ─────────────────────────────────────────────────────────────────
  OSM fetch + elevation sampling   ──►  graph.json   (pipeline output)
  Open-Meteo DEM lookup (per cell) ──►  mobile/src/elevCache.ts
  [future] route → English sentence ──► (would cache on route key)
```

- **`graph.json` is a prebuilt cache.** The pipeline (`pipeline/elevation.ts`, `sampleElevations`) does the costly OSM + elevation work *once* at build time and freezes the result. Serving never recomputes it — it reads the cache. That is response caching with the cache key being "this map area."
- **`mobile/src/elevCache.ts` is a textbook cache** — keyed by ~90m DEM cell (`getElev`/`putElev`), in-memory `Map` + on-disk AsyncStorage, debounced writes, `MAX_ENTRIES` cap with oldest-first eviction. The header comment says it outright: *"already-fetched areas never re-hit the free elevation API."* Swap "elevation API" for "model" and this file *is* an LLM cache.
- **The LLM seam where caching would attach:** `features/routing/summary.ts:11` (`routeSummary`) returns the numbers a narration prompt would consume. If a future "describe this route in a sentence" call existed, identical routes (same edges, same `userMax`) would produce identical sentences — a perfect cache key. You'd hash the route + max, store the sentence next to the summary, and skip the model on repeat. **Not built. Design note only.**

The muscle is already trained — you cache expensive external computation correctly today. Adding an LLM cache later is the same `elevCache.ts` shape with a prompt hash for a key.

## See also

- `02-llm-cost-optimization.md` — caching is one of the three cost levers
- `04-rate-limiting-backpressure.md` — the other reason `elevCache` exists (avoid re-hitting a rate-limited API)
- `features/routing/summary.ts:11` — the future narration seam a route cache would wrap
