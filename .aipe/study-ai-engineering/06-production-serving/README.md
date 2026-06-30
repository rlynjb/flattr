# 06 — Production Serving (flattr)

The operational concerns of *running* an AI feature in production —
caching, cost, rate limits, retries, and the security of untrusted input.
flattr has **no LLM**: it's a local-first Expo app wrapping a hand-rolled
A* router over a grade-annotated street graph. So some of these patterns
are study material — but several have a **real, non-LLM home** in
flattr's only external calls: Nominatim geocoding and Open-Meteo
elevation. Those are rate-limited, throttle-on-quota services flattr
already shapes its behavior around, which makes them the honest place to
teach serving discipline.

## The honest framing

- **Rate limiting / retry / backpressure are NOT hypothetical.** flattr's
  geocode and elevation HTTP calls are real, rate-limited dependencies.
  `MapScreen.tsx:189` issues geocodes sequentially ("Nominatim allows ~1
  req/sec"), autocomplete is debounced, and `geocode.ts:24` throws on
  failure with no retry. These files teach the patterns *around those real
  calls first*, then note the LLM versions attach at a future
  route-describe call.
- **Caching already ships** as `mobile/src/elevCache.ts` — an exact cache
  keyed by DEM cell, mem + disk, that keeps the elevation API from being
  re-hit. That's the caching instinct a describe cache would reuse.
- **Cost is near zero.** Routing is local; the network calls are free.
  The real cost lever for a future describe feature is on-device vs cloud,
  not model tier.
- **Prompt injection** has a latent vector already in the repo: the
  untrusted OSM `display_name` (`geocode.ts:27`/`:52`).

## The five files

```
  01-llm-caching.md             exact/prompt/semantic; elevCache.ts is the
                                shipped instinct; describe → exact cache by
                                RouteSummary key
  02-llm-cost-optimization.md   cheap-model-first; describe is on-device,
                                cost ~$0; the real lever is on-device vs cloud
  03-prompt-injection.md        the OSM display_name vector (geocode.ts:27/:52)
  04-rate-limiting-backpressure.md  REAL home: Nominatim ~1 req/sec
                                (MapScreen.tsx:189), elevation 429s
  05-retry-circuit-breaker.md   REAL home: geocode/elevation throw
                                (geocode.ts:24); no retry today — honest gap
```

## Reading order

1. **`03-prompt-injection.md`** — the trust boundary already in the repo.
2. **`04-rate-limiting-backpressure.md`** — flattr's real rate-limit home,
   the Nominatim/Open-Meteo calls.
3. **`05-retry-circuit-breaker.md`** — what happens when those throttled
   calls fail; flattr's honest no-retry gap and where the wrapper belongs.
4. **`01-llm-caching.md`** — `elevCache.ts` as the shipped pattern; a
   describe cache keyed by `RouteSummary`.
5. **`02-llm-cost-optimization.md`** — why flattr's cost is near zero and
   the device boundary is the real lever.

## Cross-links

- **`../05-evals-and-observability/`** — knowing the served feature works
  (evals) and seeing what it did (traces); a cache hit and a retry count
  are span attributes.
- **`features/routing/summary.ts:5`** — `RouteSummary`, the deterministic
  output every future LLM call here keys off.
- Sibling guides under `.aipe/`: `study-system-design` (elevation
  provider fallback, on-device pipeline rerun), `study-networking`
  (the geocode/elevation HTTP behavior), `study-performance-engineering`
  (the cache as a latency lever).
