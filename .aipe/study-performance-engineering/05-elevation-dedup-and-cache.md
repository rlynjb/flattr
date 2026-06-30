# Elevation dedup + cache — the real rate-limit defense

> Industry name: **request coalescing by spatial key + persistent read-through
> cache**. Type: Language-agnostic.

The free Open-Meteo elevation API throttles under load — the project context says
so explicitly. flattr's answer is two layers: never sample finer than the data's
resolution (dedup), and never re-fetch a cell you've seen (persistent cache). The
cache is the part that actually keeps the app usable.

## Zoom out — where this concept lives

Dedup lives at build time and run time; the persistent cache lives in the mobile
layer in front of the provider. Together they sit between every graph build and
the rate-limited API.

```
  Zoom out — the two defenses in front of the elevation API

  ┌─ Build (pipeline/ + mobile buildGraph) ───────────────────┐
  │  sampleElevations(nodes, provider, {dedupePrecision})     │ ← dedup here
  │  ★ collapse nodes in one ~90m cell to ONE query           │
  └──────────────────────────┬─────────────────────────────────┘
                             │ provider.sample(missPoints)
  ┌─ Cache (mobile/src/elevCache.ts + useTileGraph) ─▼────────┐
  │  ★ cachedElevation: cell-key lookup, miss → fetch → put   │ ← we are here
  │     persistent (AsyncStorage), survives restarts          │
  └──────────────────────────┬─────────────────────────────────┘
                             │ only the misses
  ┌─ Provider (Open-Meteo, rate-limited) ─▼───────────────────┐
  │  openMeteoProvider — batch 100, backoff, sleep 300-400ms  │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this is the read-through cache you've built in front of a slow API,
keyed cleverly. The cleverness is the key — a ~90m DEM grid cell, not a raw
lat/lng — so two different coordinates that fall in the same cell are the *same*
cache entry. DEM elevation doesn't change, so a hit is valid forever.

## Structure pass — the skeleton

**Axis traced: how many requests reach the API?** It drops at two seams — the
dedup key and the cache lookup.

```
  One axis — "how many points hit the API?" — across two seams

  ┌─ all graph nodes (e.g. 1621) ─────────────────────────────┐
  │                                                           │  → N points
  └──────────────────────────┬─────────────────────────────────┘
        seam 1: dedupePrecision → cellKey (elevation.ts:42)
  ┌─ one rep per ~90m cell ──▼────────────────────────────────┐
  │                                                           │  → C cells (C < N)
  └──────────────────────────┬─────────────────────────────────┘
        seam 2: cache lookup (useTileGraph.ts:44-51)
  ┌─ only cache misses ──────▼────────────────────────────────┐
  │                                                           │  → M misses (M ≤ C)
  └──────────────────────────┬─────────────────────────────────┘
                             │ revisited area → M = 0
  ┌─ Open-Meteo ─────────────▼────────────────────────────────┐
  │  batch 100/request                                        │
  └────────────────────────────────────────────────────────────┘
```

Two seams, two drops: N → C (dedup), C → M (cache). On a revisited area M = 0 —
zero requests. That zero is the whole point.

## How it works

### Move 1 — the mental model

You've put a cache in front of a slow `fetch` before — check the map, return on
hit, fetch + store on miss. flattr does exactly that, with two twists: (1) the key
is a quantized grid cell so nearby points share an entry, and (2) the map is
persisted to disk so it survives an app restart.

```
  The pattern — quantize to a cell, then read-through cache

   coords (47.6181, -122.3284)
         │  round to ~90m cell
         ▼
   cellKey "59522,-152855"  ──▶ cache hit?  ──yes──▶ return cached elev
         │                              │
         │                              no
         │                              ▼
         └──────────────────────▶ fetch ONE batch of misses
                                  put each into cache (+ persist debounced)
```

The load-bearing part: the **quantization key**. Drop it (cache by raw lat/lng) and
every slightly-different coordinate misses, so the cache barely helps and you keep
hammering the API. The cell key is what turns "near this place again" into a hit.

### Move 2 — the walkthrough

**Seam 1 — dedup before fetching.** At build time, `sampleElevations` collapses
all nodes in one `prec`-sized cell to a single representative query:

```ts
// pipeline/elevation.ts:42-52 — dedup to one rep per cell
const keyOf = (lat, lng) => `${Math.round(lat / prec)},${Math.round(lng / prec)}`;
const repByKey = new Map<string, {lat, lng}>();
for (const id of ids) {
  const k = keyOf(nodes[id].lat, nodes[id].lng);
  if (!repByKey.has(k)) repByKey.set(k, { lat: nodes[id].lat, lng: nodes[id].lng });  // first wins
}
const keys = [...repByKey.keys()];
const elevs = await provider.sample(keys.map((k) => repByKey.get(k)!));  // fetch only reps
```

`prec` is `DEDUPE = 0.0008` (~90m) on mobile (`useTileGraph.ts:68`), matched to the
Copernicus 90m DEM the free provider uses (`elevation.ts:90`). Sampling finer than
the DEM is wasted requests — the data can't resolve it anyway. The comment names
the dual purpose: "don't sample finer than the DEM resolution (and stay under
free-tier request limits)" (`elevation.ts:40-41`).

**Seam 2 — the read-through cache.** On mobile, the provider is wrapped so misses
are the only thing fetched:

```ts
// mobile/src/useTileGraph.ts:38-62 — cachedElevation wrapper
async sample(points) {
  const out = new Array(points.length);
  const missPts = [], missIdx = [];
  points.forEach((pt, i) => {
    const hit = getElev(cellKey(pt.lat, pt.lng));   // cell-key lookup
    if (hit !== undefined) out[i] = hit;            // ← hit: no request
    else { missPts.push(pt); missIdx.push(i); }     // ← miss: collect
  });
  if (missPts.length) {
    const got = await p.sample(missPts);            // ONE batch for all misses
    got.forEach((e, j) => {
      out[missIdx[j]] = e;
      putElev(cellKey(missPts[j].lat, missPts[j].lng), e);  // cache it
    });
  }
  return out;
}
```

Revisit an area and every point is a hit — `missPts` is empty, `p.sample` is never
called, **zero requests**. The comment calls this out: "Overlapping/revisited areas
need ZERO elevation requests — the main cause of throttling" (`useTileGraph.ts:34-35`).

**Persistence.** The cache is backed by AsyncStorage so it survives restarts. Writes
are debounced (4s) and batched, with a `MAX_ENTRIES = 50000` cap and oldest-drops
eviction (Map keeps insert order):

```ts
// mobile/src/elevCache.ts:35-57 — write-through, debounced persist, capped
export function putElev(key, value) {
  if (mem.has(key)) return;                  // already cached
  mem.set(key, value);
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS); // 4000ms
}
async function persistNow() {
  let entries = [...mem.entries()];
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES); // drop oldest
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
}
```

Only successfully-fetched real values are cached — flat-fallback zeros are never
stored (the fallback happens in `bestEffortElevation`, outside the cache wrapper,
`useTileGraph.ts:20-31`), so a throttled build doesn't poison the cache with bogus
flat grades.

### Move 3 — the principle

The cheapest request is the one you don't make. flattr stacks two
request-eliminators: dedup removes requests that the data resolution makes
pointless, and the persistent cache removes requests for places you've already
seen. The key design choice — quantize to the data's natural cell — is what makes
both work, because it turns "approximately the same place" into "exactly the same
key." **Measurement gap:** there's no cache-hit-rate metric. The defense is sound by
construction, but "how many requests did the cache actually save" is uncounted — a
hit/miss counter in `cachedElevation` would make the win visible and prove the
throttling defense empirically.

## Primary diagram

```
  Elevation dedup + cache — full recap

  graph nodes (N) ─┐
                   │ seam 1: dedupePrecision ~90m (elevation.ts:42)
                   ▼
  cell reps (C) ───┐
                   │ seam 2: cachedElevation lookup (useTileGraph.ts:44)
       ┌───────────┴───────────┐
   cache HIT                cache MISS
   return cached            collect → ONE batch fetch (Open-Meteo, 100/req)
   (0 requests)             → putElev → debounced persist (4s) → AsyncStorage
                                                              (MAX_ENTRIES 50000)
  revisited area → all hits → M=0 requests → no throttling
```

## Elaborate

This is read-through caching (cache-aside's sibling) plus spatial request
coalescing. The spatial-key idea is the same one behind tile pyramids and
geohashing: quantize continuous space to a discrete grid so lookups are exact. The
"valid forever" property is specific to DEM data — terrain elevation is static, so
there's no TTL/invalidation problem that a normal API cache would have
(`elevCache.ts:2-4`: "DEM samples never change, so cached values are valid
forever"). That's why this cache can be aggressive in a way a data-freshness cache
can't. It composes with the single-flight pump (`02-single-flight-pump.md`): depth-1
limits concurrency, the cache limits per-build request count, together they keep the
app under quota. For the retry/backoff semantics on the misses that *do* fetch, see
`study-networking`.

## Interview defense

**Q: Why key the cache by a grid cell instead of by coordinate?**

DEM elevation has ~90m resolution — finer coordinates resolve to the same data. If
I cached by raw lat/lng, two points 10m apart would be separate entries, both
missing on a near-revisit, and I'd keep hitting the throttled API for data that's
identical. Quantizing to a 90m cell makes "near here again" a cache hit, which is
the whole point. Same key powers the build-time dedup too.

```
  raw key:  (47.6181,-122.3284) ≠ (47.6182,-122.3285) → 2 misses
  cell key:  "59522,-152855"    = "59522,-152855"      → 1 entry, 1 hit
```

Anchor: *"key by the data's resolution, not the input's precision."*

**Q: What stops a throttled build from poisoning the cache with flat zeros?**

The flat-fallback lives in `bestEffortElevation`, which wraps *outside* the cache.
Only the inner `cachedElevation` calls `putElev`, and it only runs on values the
provider actually returned. When the provider throws (throttled), the outer wrapper
catches and returns zeros — but those zeros never reach `putElev`. So the cache
holds only real elevation; a degraded region is re-fetched later, not served bogus
from cache.

Anchor: *"fallback wraps outside the cache, so only real values persist."*

## See also

- `02-single-flight-pump.md` — concurrency bound this composes with.
- `06-debounced-throttled-fetch.md` — the debounce that limits how often builds run.
- `audit.md` lens 5 (I/O bottlenecks), lens 6 (caching).
- `study-networking` — retry/backoff on the misses that do fetch.
