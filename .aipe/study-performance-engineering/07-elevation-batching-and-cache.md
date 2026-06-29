# Elevation Batching + Dedup + Persistent Cache — the rate-limit defense

**Industry name(s):** request batching + spatial dedup + read-through cache with
exponential backoff. **Type:** Industry standard (I/O optimization against a
rate-limited upstream).

## Zoom out, then zoom in

Grades come from elevation, elevation comes from a free API (Open-Meteo, ~90 m
DEM) that 429s the moment you push it. flattr never lets it get pushed: it samples
one point per ~90 m cell (dedup), sends them 100 at a time (batch), retries 429s
with backoff, and — the real defense — *remembers every value forever* in a
persistent cache so revisited areas make **zero** requests.

```
  Zoom out — the elevation I/O stack

  ┌─ Coordination ────────────────────────────────────────────┐
  │  useTileGraph.ts: cachedElevation ∘ bestEffortElevation    │ ← we are here
  └───────────────────────────┬───────────────────────────────┘
                              │ misses only
  ┌─ Build pipeline ──────────▼───────────────────────────────┐
  │  pipeline/elevation.ts: dedup → batch 100 → backoff        │
  │  pipeline/build-graph.ts: sampleElevations stage           │
  └───────────────────────────┬───────────────────────────────┘
                              │ persisted across restarts
  ┌─ Storage ─────────────────▼───────────────────────────────┐
  │  mobile/src/elevCache.ts: in-mem Map + AsyncStorage        │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do I get elevation for thousands of points off a
free API without getting throttled into uselessness?"* The answer is four nested
defenses, and the outermost one (the persistent cache) does the most work.

## Structure pass

**Layers.** Four defenses, outside-in, each cutting the request count before the
next sees it:

```
  persistent cache  →  spatial dedup  →  batch  →  backoff
  elevCache.ts         ~90m cell key     100/req   429 retry
  (zero on revisit)    (fewer points)    (fewer    (survive
                                          requests)  bursts)
```

**Axis: I/O cost — "how many network requests does N points cost?"** Trace it
through the layers:

```
  One question down the defenses
  "requests for N graph nodes?"

  raw:              N points          → N/100 requests, all to network
  + dedup:          ~unique cells     → fewer points before batching
  + batch 100:      ceil(pts/100)     → ~1% of the naive request count
  + persistent cache: cells seen before → ZERO requests (the win)
```

**Seam.** The load-bearing boundary is `cachedElevation`'s split into hits and
misses (`useTileGraph.ts:42-58`): on one side, cached cells return with no I/O; on
the other, only the misses cross into the batching/backoff provider. The cache key
(`cellKey`, `useTileGraph.ts:36`) is the contract that makes a revisit a hit.

## How it works

### Move 1 — the mental model

It's a read-through cache (like memoizing an expensive `fetch`) with two twists:
the cache key is *spatial* (round lat/lng to a ~90 m grid, so nearby points share
a value), and it's *persisted to disk*, so it survives app restarts. The expensive
upstream is only ever touched for cells you've genuinely never seen.

```
  Read-through spatial cache — the shape

  points ──► for each: cellKey(lat,lng) = round to ~90m grid
                │
          cache hit? ── yes ──► use stored value      (no I/O)
                │ no
          collect misses ──► batch 100 ──► API (backoff) ──► store each
                │
          assemble results in original order
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** The defense is four parts; each removed loses a measurable
capability:

```
  cell key + cache lookup + batch + persist
     │           │            │       │
  ~90m round  hit/miss split  100/req  AsyncStorage
```

**Name each part by what breaks without it:**

- **Cell-key dedup (`elevation.ts:42-52` build-time; `useTileGraph.ts:36`
  device).** Rounds coordinates to a ~90 m grid (`DEDUPE = 0.0008`) so many graph
  nodes map to one sample. Remove it: you sample finer than the DEM's own
  resolution — pure wasted requests for values that are identical anyway.
- **Hit/miss split (`useTileGraph.ts:42-58`).** Only misses hit the network.
  Remove it: every build re-fetches everything, and the 429s come back.
- **Batch 100 (`elevation.ts:85,102`).** One request per 100 points. Remove it:
  N requests instead of N/100 → 100× the request count → instant throttle.
- **Persist (`elevCache.ts`).** Survives restart. Remove it: every cold start
  re-fetches the whole base area — the single biggest source of throttling, since
  testing reloads the app constantly.

```ts
// mobile/src/useTileGraph.ts:38-62  — read-through: split hits from misses
function cachedElevation(p: ElevationProvider): ElevationProvider {
  return {
    async sample(points) {
      const out = new Array<number>(points.length);
      const missPts: { lat: number; lng: number }[] = [];
      const missIdx: number[] = [];
      points.forEach((pt, i) => {
        const hit = getElev(cellKey(pt.lat, pt.lng));   // ← spatial cache lookup
        if (hit !== undefined) out[i] = hit;            // hit: no I/O
        else { missPts.push(pt); missIdx.push(i); }     // miss: queue for network
      });
      if (missPts.length) {
        const got = await p.sample(missPts);            // ← ONLY misses cross to batch+backoff
        got.forEach((e, j) => {
          out[missIdx[j]] = e;
          putElev(cellKey(missPts[j].lat, missPts[j].lng), e);  // store for next time
        });
      }
      return out;                                       // original order preserved
    },
  };
}
```

```ts
// pipeline/elevation.ts:100-126  — batch + exponential backoff on 429
for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {   // batch of 100
  const batch = points.slice(i, i + OPEN_METEO_BATCH);
  // ... build url ...
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url);
    if (res.ok) { json = await res.json(); break; }
    if (res.status === 429 && attempt < retries) {
      await sleep(delayMs * 2 ** (attempt + 1));     // ← exponential backoff
      continue;
    }
    throw new Error(`Open-Meteo elevation: ${res.status}`);  // give up → caller flattens
  }
  if (delayMs && i + OPEN_METEO_BATCH < points.length) await sleep(delayMs);  // inter-batch throttle
}
```

**Persist is debounced and batched too** — writes don't hit disk per value:

```ts
// mobile/src/elevCache.ts:35-40  — coalesce writes
export function putElev(key: string, value: number): void {
  if (mem.has(key)) return;                  // dedup at the cache layer too
  mem.set(key, value);
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);  // 4s debounce
}
```

**The composition order matters.** On the device, the provider is
`bestEffortElevation(cachedElevation(openMeteoProvider(..., { retries: 1 })))`
(`useTileGraph.ts:190-195`). Cache is *innermost-first* (checked before any
network), and `retries: 1` is deliberate: cache-first means a throttled build
should *fail fast to flat* rather than stall on doomed backoffs — the comment says
exactly this (`useTileGraph.ts:188-189`). The outermost `bestEffortElevation`
catches the throw and returns flat (0 m) so the build still produces a connected
graph (`useTileGraph.ts:20-31`).

```
  Execution trace — same area, second visit

  visit 1 (cold):  100 nodes → dedup 40 cells → 1 batch → 40 fetched, cached
  app restart:     loadElevCache() → 40 cells back in memory
  visit 2 (warm):  100 nodes → 40 cell keys → ALL HITS → 0 requests
                   ▲ the persistent cache turns a revisit into zero I/O
```

### Move 3 — the principle

Against a rate-limited upstream, the cheapest request is the one you never send.
Batching and backoff shrink and survive the requests you *do* send, but the
persistent, spatially-keyed cache is what makes most requests disappear entirely —
and a cache of immutable data (DEM values never change) is the easy, correct kind.
The generalizable move: layer your I/O defenses outside-in so the cheapest filter
(cache) runs first, and compose them in the order that fails fast.

## Primary diagram

```
  Elevation I/O — four nested defenses

  buildGraph → sampleElevations → provider.sample(points)
                                       │
  ┌─ cachedElevation (elevCache) ──────▼──────────────────────┐
  │  cellKey(~90m) → hit? → use stored (NO I/O)               │
  │                  miss → collect ──┐                       │
  └───────────────────────────────────┼──────────────────────┘
                                       │ misses only
  ┌─ openMeteoProvider (elevation.ts) ▼──────────────────────┐
  │  dedup (build-time) → batch 100 → 429? backoff 2^n        │
  │  throttled? throw ──► bestEffortElevation → flat 0m       │
  └───────────────────────────────────┬──────────────────────┘
                                       │ store
  ┌─ AsyncStorage (elevCache.ts) ──────▼──────────────────────┐
  │  debounce 4s · batch write · cap 50k · survives restart   │
  └───────────────────────────────────────────────────────────┘
       revisited area → all hits → 0 requests = rate-limit defended
```

## Elaborate

This is the standard pattern for any client over a metered API — the spatial twist
(round to the upstream's own resolution before keying) is specific to geo data and
is what lets one cached value serve many query points honestly. The DEM is
immutable, so there's no invalidation problem — the hard part of caching simply
doesn't exist here, which is why the cache can be permanent. The degraded-to-flat
fallback + capped self-heal retry (`useTileGraph.ts:209-218`) is the availability
companion: connectivity is preserved even when grades can't be fetched, and grades
self-correct later. → `05-single-flight-pump.md` for the concurrency limit that
ensures only one build's worth of these requests is ever in flight.

## Interview defense

**Q: How do you keep a free elevation API from throttling you?**

> Four nested defenses, cheapest first. A persistent, spatially-keyed cache
> (`elevCache.ts`) — round each point to the DEM's ~90 m cell, so revisited areas
> make zero requests and the cache survives restarts. Then dedup to one sample per
> cell, batch 100 points per request, and exponential backoff on 429. The cache
> is the real win: DEM values never change, so it's a permanent cache with no
> invalidation. A cold visit fetches; every revisit is all hits.

```
  cache (0 on revisit) → dedup → batch 100 → backoff 2^n
```

Anchor: *the cheapest request is the one you never send — the persistent cache is
the load-bearing defense, not the backoff.*

**Q: Why `retries: 1` on the device when the provider supports more?**

> Because the cache runs first. If a build still misses and the API is throttled,
> I want it to fail fast to flat elevation and keep the streets connected, not
> stall the build on doomed backoffs while the user waits. The outer
> `bestEffortElevation` catches the throw and returns 0 m, and a capped self-heal
> retry upgrades the grades later. Connectivity over fidelity, on purpose.

```
  cache miss + throttled → fail fast → flat 0m → self-heal retry later
```

Anchor: *compose I/O defenses in fail-fast order; degrade gracefully, heal later.*

## See also

- `05-single-flight-pump.md` — the one-build-at-a-time limit on these requests.
- `08-render-thread-search-and-debounce.md` — the debounce that gates when builds fire.
- `audit.md` lens 5 (I/O), lens 6 (caching/batching).
- Cross-guide: `study-networking` (backoff/retry semantics), `study-system-design` (build-time vs device-time).
