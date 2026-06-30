# LLM caching — exact, prompt, and semantic caches

**Industry name(s):** response caching / prompt caching / semantic cache.
**Type:** Industry standard (study material). **Not present for LLM in flattr** — but the caching *instinct* already ships in `elevCache.ts`.

## Zoom out — flattr already caches a slow, repeated external call

You've shipped a cache, just not for an LLM. `mobile/src/elevCache.ts`
caches elevation samples keyed by a ~90 m DEM cell, in memory and on
disk, so an already-fetched area *never re-hits the free elevation API*
— the exact pattern an LLM exact-cache uses (key the input, store the
output, skip the expensive call on a repeat). There's no LLM call to
cache today. But a route-describe feature is the textbook exact-cache
candidate: its input is `RouteSummary`'s three numbers, which repeat
constantly, and its output is prose that's expensive to regenerate.

```
  Zoom out — flattr's existing cache vs a future LLM cache

  ┌─ External elevation API (slow, throttled) ──────────────┐
  │  Open-Meteo — 429s on quota                             │
  └────────────────────────────┬─────────────────────────────┘
              cached by ▼  elevCache.ts (key = DEM cell)
  ┌─ elevCache (TODAY) ─────────────────────────────────────┐
  │  mem Map + AsyncStorage; "cached values valid forever"  │
  └────────────────────────────┬─────────────────────────────┘
              ★ same pattern, no LLM call exists to cache
  ┌─ (future) describe call ───▼─────────────────────────────┐
  │  key = RouteSummary; value = prose → EXACT cache         │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** external dependency → cache → consumer.
- **Axis — key precision:** exact-cache keys on the literal input
  (`elevCache` keys on a quantized cell; a describe cache keys on
  `RouteSummary`). Semantic cache keys on *meaning* (embedding
  similarity) — flattr has no embeddings, so semantic caching is the one
  variant with no home here.
- **Seam:** `elevCache.ts:31`/`:35` (`getElev`/`putElev`) is the
  get-or-fetch boundary. A describe cache would sit at the same boundary
  around the future LLM call: `getDescribe(key) ?? (await call, put)`.

## How it works

### Move 1 — the mental model

Three cache types, by how the key is computed. **Exact cache**: hash the
literal prompt; a byte-identical repeat hits. **Prompt cache** (provider
feature): the model reuses computation over a shared *prefix* across
calls. **Semantic cache**: embed the input and hit on *similar* (not
identical) inputs — needs a vector store. flattr's `elevCache` is an
exact cache (quantized key). A describe cache would also be exact,
because `RouteSummary` is three discrete numbers — semantic similarity
adds nothing.

```
  Pattern — cache types by key

  exact      key = hash(input)        identical repeat → hit
  prompt     key = shared prefix      provider reuses prefix compute
  semantic   key = embedding ~近       similar input → hit (needs vectors)
        │
  flattr today: elevCache = EXACT (quantized DEM cell)
  flattr future: describe = EXACT (RouteSummary as key)
```

### Move 2 — the walkthrough

**flattr's existing exact cache — `elevCache.ts`.** The header states the
caching logic precisely:

```ts
// elevCache.ts:1 — "Persists across app restarts so already-fetched
// areas never re-hit the free elevation API ... DEM samples never
// change, so cached values are valid forever."
```

Get-or-skip lives in two tiny functions:

```ts
// elevCache.ts:31 / :35 — the cache boundary
export function getElev(key: string): number | undefined { return mem.get(key); }
export function putElev(key: string, value: number): void {
  if (mem.has(key)) return;           // ← idempotent insert
  mem.set(key, value); dirty = true;  // ← debounced persist follows
}
```

Two cache disciplines worth stealing for an LLM cache are already here:
a **two-tier** store (memory + `AsyncStorage`) and a **bounded** one
(`MAX_ENTRIES = 50000`, oldest drop first, `elevCache.ts:9`).

**Why a describe cache is exact, and why it's a strong fit.** A future
describe call's input is `RouteSummary`:

```ts
// summary.ts:5 — three numbers → a perfect exact-cache key
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

`JSON.stringify(summary)` (or a rounded form) is the key; the prose is
the value. Identical routes recur constantly (re-render, re-open), so the
hit rate is high — and the prose for a given summary *never changes*,
exactly like the "valid forever" elevation samples.

**Where semantic caching would and wouldn't help.** It wouldn't: two
*similar* summaries (`climbM:39` vs `climbM:40`) should arguably produce
slightly different prose, and embedding three numbers to find
near-matches is overkill versus just rounding the key. Exact cache on a
rounded `RouteSummary` is the right tool.

### Move 3 — the principle

Cache the expensive, repeated, deterministic-output call at its input
boundary. flattr already does this for elevation in `elevCache.ts`; a
route-describe cache is the same move with `RouteSummary` as the key. The
cache type follows the key's nature — discrete inputs want an exact
cache, and flattr's inputs are discrete, so the fancy semantic variant
stays on the shelf.

## Primary diagram

```
  The caching instinct, transferred to a describe call

  ┌─ elevCache.ts (SHIPPED) ────────────────────────────────┐
  │  key = DEM cell → elev (mem + disk, bounded, forever)   │
  │  getElev:31 / putElev:35  ← cache boundary              │
  └──────────────────────────┬───────────────────────────────┘
            same boundary, new key ▼ (future)
  ┌─ describe cache ────────────────────────────────────────┐
  │  key = RouteSummary {dist,climb,steep}  → prose         │
  │  getDescribe(key) ?? (await LLM, putDescribe)           │
  │  type: EXACT (semantic adds nothing for 3 numbers)      │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The non-obvious cost of an LLM exact-cache that `elevCache` sidesteps is
**invalidation**. Elevation is "valid forever" — the DEM never changes —
so `elevCache` never invalidates, which is why it's so simple. A describe
cache inherits that *if* the prompt and model are pinned: change the
prompt template or the model version and every cached prose answer is now
stale. The practical move is to version the cache key (include a
prompt/model version), so a template change rotates the whole cache —
the one piece of complexity the elevation cache never had to handle.

## Project exercises

### B6-CACHE.1 — exact-cache a describe call, modeled on `elevCache`

- **Exercise ID:** B6-CACHE.1
- **What to build:** a `describeCache` keyed by a rounded `RouteSummary`,
  with `getDescribe`/`putDescribe` mirroring `getElev`/`putElev`, two-tier
  (mem + `AsyncStorage`) and bounded.
- **Why it earns its place:** it reuses a proven flattr pattern for the
  most cacheable LLM call the app could have.
- **Files to touch:** new `mobile/src/describeCache.ts` (copy the shape
  of `elevCache.ts`), reuse `RouteSummary` from `summary.ts:5`.
- **Done when:** a repeated identical `RouteSummary` returns cached prose
  without a second call, and survives an app restart.
- **Estimated effort:** 2–3 hrs.

### B6-CACHE.2 — version the cache key

- **Exercise ID:** B6-CACHE.2
- **What to build:** fold a `promptVersion`/`modelVersion` into the
  describe-cache key so a template change invalidates stale prose.
- **Why it earns its place:** it adds the one discipline `elevCache`
  never needed (invalidation) — the real gotcha of LLM caching.
- **Files to touch:** `mobile/src/describeCache.ts` (key builder).
- **Done when:** bumping the version misses all prior cache entries.
- **Estimated effort:** 1 hr.

## Interview defense

**Q: would you cache flattr's route descriptions, and how?** Answer:
yes, with an exact cache keyed by `RouteSummary` (`summary.ts:5`) —
three discrete numbers that repeat constantly and map to prose that's
stable for a fixed prompt/model. I'd model it on the cache flattr already
ships: `elevCache.ts`, which keys elevation by DEM cell, stores
mem-plus-disk, bounds entries, and treats values as valid forever. The
one thing I'd add that `elevCache` doesn't need is key versioning, so a
prompt change invalidates stale prose. Semantic caching adds nothing for
three numbers. Load-bearing point: cache the expensive repeated call at
its input boundary — flattr already does exactly that for elevation.

```
  RouteSummary → [exact cache, versioned key] → prose (skip LLM on hit)
```

Anchor: *"flattr's `elevCache` is the caching instinct already in the
repo; a describe cache is the same move with `RouteSummary` as the key."*

## See also

- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — a cache hit is the cheapest cost lever.
- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — caching reduces pressure on the throttled API.
- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — serve stale cache when the call fails.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — cache hit/miss as a span attribute.
