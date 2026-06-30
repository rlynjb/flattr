# Rate limiting & backpressure — the geocode/elevation calls

**Industry name(s):** rate limiting / throttling / backpressure.
**Type:** Industry standard. **Has a REAL home in flattr** — the Nominatim and Open-Meteo HTTP calls.

## Zoom out — flattr already pages itself to a 1 req/sec external limit

This isn't a hypothetical for flattr. Its *only* external calls —
Nominatim geocoding and Open-Meteo elevation — are rate-limited services,
and flattr already shapes its request rate around them. `MapScreen.tsx`
deliberately issues the From/To geocodes *sequentially* with the comment
"Nominatim allows ~1 req/sec," debounces autocomplete, and the elevation
API *429s on quota*. So rate limiting and backpressure have a real,
non-LLM home in this repo today. The LLM version (token-per-minute
limits, queueing describe calls) would attach at a future describe call —
but the pattern is already exercised against real HTTP dependencies.

```
  Zoom out — where flattr meets rate limits TODAY

  ┌─ UI (mobile/) ──────────────────────────────────────────┐
  │  typing → debounced suggest · From/To → sequential geocode│
  └────────────────────────────┬─────────────────────────────┘
              REAL rate limits ▼
  ┌─ External services ─────────────────────────────────────┐
  │  Nominatim  ~1 req/sec policy                           │
  │  Open-Meteo elevation  429 on quota                    │
  └────────────────────────────┬─────────────────────────────┘
              ★ same pattern would shape a future describe call
```

## Structure pass

- **Layers:** UI (request source) → engine (`geocode`) → external service
  (rate-limited).
- **Axis — request pressure vs service capacity:** the UI can *generate*
  far more requests than the service will *accept* (a fast typist, two
  endpoints at once). Rate limiting throttles the source; backpressure is
  the source *slowing down* because the sink is full.
- **Seam:** `MapScreen.tsx:189` is the throttle seam — the From geocode
  and the To geocode are `await`-ed in sequence, on purpose, so two calls
  never hit Nominatim in the same second. The rate-shaping lives in the
  *caller*, not in `geocode()` itself.

## How it works

### Move 1 — the mental model

Rate limiting caps *how often* you call a dependency; backpressure is the
feedback that makes a fast producer wait for a slow consumer. Three tools
do most of the work: **debounce** (drop bursts — only fire after input
settles), **serialize** (one call at a time, so N calls take N×latency
not N-at-once), and **token bucket / spacing** (enforce a minimum gap
between calls). flattr uses the first two today against real limits.

```
  Pattern — three throttles, by where pressure builds

  debounce    typing bursts → fire once after settle (suggest)
  serialize   N parallel → N sequential (From then To geocode)
  spacing     enforce ≥ Δt between calls (token bucket / 1 req/sec)
        │
  flattr today: debounce (suggest) + serialize (geocode pair)
```

### Move 2 — the walkthrough

**Serialize — the From/To geocode pair.** `MapScreen.tsx` resolves two
addresses but never fires them together:

```ts
// MapScreen.tsx:182 — From, awaited first
const a = await geocode(from, { viewbox });
...
// MapScreen.tsx:189 — To, awaited AFTER → "Nominatim allows ~1 req/sec"
const b = await geocode(to, { viewbox });
```

`Promise.all([geocode(from), geocode(to)])` would be faster but would
fire two requests in the same instant — exactly what the ~1 req/sec
policy forbids. The sequential `await` *is* the rate limiter.

**Debounce — autocomplete suggestions.** Typing generates a request per
keystroke unless you damp it. flattr does:

```ts
// MapScreen.tsx:80 — fire only after input settles (400ms)
suggestTimer.current = setTimeout(async () => {
  const results = await geocodeSuggest(text, { viewbox: searchViewbox, ... });
  ...
}, 400);
```

plus a 3-char minimum (`MapScreen.tsx:75`) — so a fast typist generates
*one* geocode, not ten. That's backpressure against the same Nominatim
limit.

**The elevation 429 — backpressure from the sink.** Open-Meteo returns
429 when the build pipeline exceeds quota. The response there is
*caching* (`elevCache.ts` — already-fetched cells never re-hit the API)
plus retry/backoff (next file). Caching is backpressure relief: the more
you cache, the less pressure reaches the rate-limited sink.

**Where an LLM rate limit would attach.** A future describe call against
a cloud model has a tokens-per-minute limit. The *same* three tools
apply: debounce describe regeneration, serialize concurrent describes,
and space calls under the TPM budget — layered onto the existing
request-shaping in `MapScreen.tsx`.

### Move 3 — the principle

Shape the request rate at the *source*, to the *slowest* dependency's
limit. flattr does this today: it serializes the geocode pair and
debounces suggestions because Nominatim only tolerates ~1 req/sec, and it
caches elevation because Open-Meteo 429s. The LLM version is the same
discipline against a token budget. Backpressure is just letting the slow
sink set the producer's pace.

## Primary diagram

```
  flattr's request shaping (real, today)

  ┌─ typing ──────┐  debounce 400ms + 3-char min (MapScreen.tsx:75/80)
  │               ▼
  │   geocodeSuggest ──────────► Nominatim (~1 req/sec)
  │
  ┌─ Route press ─┐  serialize (MapScreen.tsx:182 → :189)
  │   geocode(from) ──await──► geocode(to) ──► Nominatim
  │
  ┌─ build ───────┐  cache-first (elevCache.ts) → fewer calls
  │   elevation ──────────────► Open-Meteo (429 on quota)
  └─────────────────────────────────────────────────────────
  (future) describe ──► space under TPM budget ──► cloud model
```

## Elaborate

The cleanest backpressure relief flattr has isn't a throttle at all —
it's the cache. `elevCache.ts` removes pressure from the elevation API by
never asking twice for the same cell, which does more for the 429 problem
than any retry. The general lesson: the best way to survive a rate limit
is to *not make the call*. For a future describe feature, the
describe-cache (see [01-llm-caching.md](01-llm-caching.md)) is the first
line of rate-limit defense, before any spacing logic. Throttle what you
can't cache; cache everything you can.

## Project exercises

### B6-RATE.1 — explicit spacing for the geocode pair

- **Exercise ID:** B6-RATE.1
- **What to build:** a small `rateLimit(minGapMs)` helper that enforces a
  ≥1000 ms gap between Nominatim calls, replacing the implicit
  sequential-`await` with an explicit token-bucket spacing.
- **Why it earns its place:** it turns the load-bearing comment at
  `MapScreen.tsx:189` into enforced behavior that survives refactors.
- **Files to touch:** new `pipeline/rateLimit.ts`, call sites
  `MapScreen.tsx:182`/`:189`/`:82`.
- **Done when:** two geocodes fired back-to-back are spaced ≥1 s, proven
  by a test with a fake clock.
- **Estimated effort:** 2–3 hrs.

### B6-RATE.2 — bounded concurrency for elevation fetches

- **Exercise ID:** B6-RATE.2
- **What to build:** a concurrency-capped queue for elevation requests
  (e.g. ≤4 in flight) feeding `elevCache`, so a corridor load can't burst
  the Open-Meteo quota.
- **Why it earns its place:** it adds backpressure at the real 429 source
  the cache alone can't cover (cold cells).
- **Files to touch:** the elevation fetch path (`pipeline/elevation.ts`),
  reuse `elevCache.ts` get/put.
- **Done when:** a cold corridor load never exceeds the cap in flight and
  429 rate drops under load.
- **Estimated effort:** 3–4 hrs.

## Interview defense

**Q: does flattr handle rate limits?** Answer: yes, against real
services. Its only external calls are Nominatim and Open-Meteo, both
rate-limited. The From/To geocodes are `await`-ed *sequentially*
(`MapScreen.tsx:189`, commented "Nominatim allows ~1 req/sec") so two
requests never hit the same second; autocomplete is debounced 400 ms with
a 3-char floor (`MapScreen.tsx:75`/`:80`); and elevation 429s are
absorbed by `elevCache` so already-fetched cells never re-call. That's
serialize + debounce + cache — the same three tools an LLM TPM limit
would need, which would attach at a future describe call. Load-bearing
point: shape the request rate at the source to the slowest dependency,
and the strongest throttle is the call you cache away.

```
  serialize + debounce + cache → fit the ~1 req/sec sink
```

Anchor: *"flattr's rate limiting isn't hypothetical — the sequential
geocode at `MapScreen.tsx:189` exists because Nominatim demands it."*

## See also

- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — what to do when the throttled call still fails.
- [01-llm-caching.md](01-llm-caching.md) — the cache is the best backpressure relief.
- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — quota is flattr's real cost; rate limiting protects it.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — track throttle waits and 429s as span attributes.
