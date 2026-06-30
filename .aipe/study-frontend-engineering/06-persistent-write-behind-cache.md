# 06 — Persistent write-behind cache

**Industry names:** two-tier (L1/L2) cache; write-behind / write-back with batched
debounced flush; cache-aside read path. **Type:** Industry standard, project-
specific build on AsyncStorage.

## Zoom out, then zoom in

You've built the in-memory half of this: a `Map` you check before fetching. flattr
adds a second tier — AsyncStorage on disk — so the cache *survives app restarts*,
because the elevation values it holds never change (a DEM sample for a lat/lng is
the same forever) and re-fetching them is the main cause of API throttling. The
write to disk is **write-behind**: batched and debounced, off the read path.

```
  Zoom out — the two-tier elevation cache

  ┌─ Hook (useTileGraph) ─────────────────────────────────────────┐
  │  cachedElevation → getElev / putElev (per ~90m DEM cell)       │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ L1 read (sync, in-memory Map)
  ┌─ elevCache.ts ────────────────▼───────────────────────────────┐
  │  mem: Map<key,number>   ← L1, hot                              │ ← we are here
  │  putElev → debounced flush (4s) → AsyncStorage   ← L2, durable │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ persisted JSON blob
  ┌─ Platform (AsyncStorage) ─────▼───────────────────────────────┐
  │  "flattr.elevCache.v1" → {key: elevation, …}                  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: cache-aside on read (check L1, miss → fetch → fill), write-behind on
persist (mutate L1 now, flush L2 later in a batch).

## Structure pass

**Layers:** (1) `cachedElevation` wrapper splits hits/misses → (2) L1 in-memory
`Map` → (3) debounced batched flush → (4) L2 AsyncStorage JSON blob.

**Axis — cost (latency + how often the metered API is hit):**

```
  Axis: "what does a read cost, and how often do we hit the API?"

  ┌─ cachedElevation read ────────┐  splits points into hits/misses
  │  hit → from Map (free, sync)  │  only MISSES go to the network
  └───────────┬───────────────────┘
  ┌─ L1 Map ──▼───────────────────┐  hit = ~0 cost, no request
  │  warm within a session         │
  └───────────┬────────────────────┘
  ┌─ L2 disk ─▼───────────────────┐  warm ACROSS sessions: restart →
  │  loaded once on mount          │  previously-fetched cells are free
  └────────────────────────────────┘
```

**Seams (load-bearing):**
- `getElev` hit/miss split (`useTileGraph.ts:46–51`) — cost axis flips: hits cost
  nothing, only misses touch the metered API.
- the debounced flush (`elevCache.ts:39, 42`) — flips the write off the read path:
  `putElev` returns instantly, the disk write happens 4 s later in one batch.

## How it works

### Move 1 — the mental model

Cache-aside you know: `cache.get(k) ?? (cache.set(k, fetch(k)), …)`. Write-behind
is the persist side: don't write to disk on every `put` — mark dirty, flush the
whole batch on a timer. Two tiers because L1 is fast-but-volatile and L2 is
slow-but-durable, and elevation data is *immutable* so L2 is always valid.

```
  Pattern — cache-aside read, write-behind persist

  READ (cachedElevation):
    points ─► for each: L1 hit? ──yes──► use it (free)
                            └──no──► collect miss ─► fetch batch ─► fill L1+out

  PERSIST (putElev):
    set L1 now ─► mark dirty ─► (if no timer) start 4s timer
                                     │
                                     ▼ flush: write WHOLE Map to AsyncStorage once
```

The kernel — what breaks without each part:
- **L1 `Map`** — remove it and every elevation lookup is an async disk read or an
  API call; the per-pan build would stall on I/O.
- **miss-batching in `cachedElevation`** — remove it and you'd issue one API call
  per point instead of one call for all misses; throttling returns immediately.
- **debounced flush** — remove it and you write the entire growing blob to disk on
  *every* `put` (hundreds per build); disk I/O dominates and jank returns.
- **load-once guard** — remove it and re-loading the cache clobbers in-memory
  values fetched since the last load.

Optional hardening (not kernel): the `MAX_ENTRIES` cap + insertion-order eviction,
the `v1` key namespace, the corrupt-JSON `try/catch`.

### Move 2 — the walkthrough

**The read path — hit/miss split** — `useTileGraph.ts:38–62`:

```ts
function cachedElevation(p) {
  return { async sample(points) {
    const out = new Array(points.length);
    const missPts = [], missIdx = [];
    points.forEach((pt, i) => {
      const hit = getElev(cellKey(pt.lat, pt.lng));   // ① L1 lookup, sync
      if (hit !== undefined) out[i] = hit;            //    hit → fill output, no network
      else { missPts.push(pt); missIdx.push(i); }     //    miss → collect for one batch fetch
    });
    if (missPts.length) {
      const got = await p.sample(missPts);            // ② ONE API call for ALL misses
      got.forEach((e, j) => {
        out[missIdx[j]] = e;
        putElev(cellKey(missPts[j].lat, missPts[j].lng), e); // ③ fill L1 (real values only)
      });
    }
    return out;
  }};
}
```

**① The DEM-cell key.** `cellKey` rounds lat/lng to a ~90 m grid (`DEDUPE = 0.0008`,
`:36, :68`) matching the free DEM resolution. Two nearby points collapse to one
key — so revisiting an area, even at a slightly different pan, hits the same cells.
This dedup is *why* the cache is effective: the map covers the same ground
repeatedly.

**② One call for all misses.** The split means a build of 500 points where 480 are
cached makes *one* API call for the 20 misses, not 20. Against a metered API,
batch-the-misses is the difference between staying under quota and 429ing.

**③ Only real values cached.** `putElev` is called only inside the success path —
flat-fallback 0 m values (pattern `05`) are *never* cached, so a degraded build
doesn't poison the cache with bogus zeros that would survive forever.

**The L1 store + write-behind flush** — `elevCache.ts`:

```ts
const mem = new Map<string, number>();   // L1

export function getElev(key) { return mem.get(key); }   // sync read

export function putElev(key, value) {
  if (mem.has(key)) return;              // ① immutable: never overwrite a cached cell
  mem.set(key, value);                   // ② L1 write — instant
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS); // ③ schedule flush
}

async function persistNow() {
  persistTimer = null;
  if (!dirty) return;
  dirty = false;
  let entries = [...mem.entries()];
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);  // ④ evict oldest
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries))); // ⑤ one write
}
```

**① Write-once.** `if (mem.has(key)) return` — a cached cell is never overwritten,
because DEM elevation is immutable. This also makes `putElev` idempotent and cheap.

**②③ Instant L1, deferred L2.** The `Map.set` is synchronous and returns
immediately — the build never waits on disk. A single timer is armed; the first
`put` in a quiet window schedules a flush 4 s out, and subsequent puts ride the
same timer (they just set `dirty`). So a build that fills 200 cells triggers *one*
disk write, not 200.

```
  Layers-and-hops — write-behind keeps disk off the hot path

  ┌─ build (hot path) ────────────────────────────────────────────┐
  │ putElev × 200 → mem.set (sync, instant) → returns              │
  └───────────────────────────┬───────────────────────────────────┘
                              │ 4s later, ONCE
  ┌─ flush (cold path) ───────▼───────────────────────────────────┐
  │ persistNow → JSON.stringify whole Map → AsyncStorage.setItem   │
  └───────────────────────────────────────────────────────────────┘
```

**④ Eviction.** `MAX_ENTRIES = 50000`; over the cap, slice to the newest. `Map`
preserves insertion order, so this is rough FIFO — oldest cells drop first. A
safety valve, not a hot concern at typical usage.

**⑤ One atomic blob.** The entire cache is stringified and written under one key.
Simple and correct for this size; the tradeoff named honestly — it's O(n) per
flush, which is why the flush is debounced and capped rather than per-entry.

**The L2 load — once, on mount** — `elevCache.ts:17–29` + `useTileGraph.ts:126–128`:

```ts
useEffect(() => { loadElevCache(); }, []);   // hook mounts → hydrate L1 from disk
// loadElevCache: if (loaded) return; ... for (const k in obj) if (!mem.has(k)) mem.set(k, obj[k]);
```

The `loaded` guard makes it run exactly once. The `if (!mem.has(k))` merge means a
value fetched *before* the disk load finishes isn't clobbered by the stale disk
copy. After this, a cold app start has every previously-fetched cell warm — so the
common case (reopening the app over your own neighborhood) makes **zero** elevation
requests.

```
  State diagram — cache warmth across a restart

   first launch:   L1 empty, L2 empty → all misses → API → fill L1 → flush L2
   pan around:     L1 warm → mostly hits → few API calls
   ── app restart ──
   relaunch:       loadElevCache → L1 hydrated from L2 → revisits = 0 requests
```

### Move 3 — the principle

Two tiers because speed and durability are different properties — keep a hot
volatile L1 for read latency and a cold durable L2 for cross-session survival, and
sync them write-behind so persistence never sits on the read path. The leverage
multiplier here is the *immutable* data: when values never change, the cache is
trivially correct (no invalidation, write-once), L2 is always valid, and the only
real decisions are key granularity (the DEM cell) and flush cadence. The
transferable rule: match the cache key to the data's natural resolution, batch the
misses, and defer the durable write.

## Primary diagram

```
  Two-tier write-behind elevation cache — full picture

  READ (cachedElevation, useTileGraph.ts)
  points ─► getElev(cellKey) per point
              hits → output (free, no request)
              misses → ONE p.sample(missPts) → fill output + putElev each

  L1 (elevCache.ts mem: Map)              L2 (AsyncStorage "flattr.elevCache.v1")
  ┌──────────────────────┐   putElev      ┌──────────────────────────────────┐
  │ key → elevation       │  set + dirty   │ {key: elevation, …} JSON blob     │
  │ sync read, write-once │ ─────timer────►│ debounced 4s, batched, capped 50k │
  └──────────┬───────────┘  persistNow     └──────────────┬───────────────────┘
             ▲                                             │ loadElevCache (once, on mount)
             └─────────────── hydrate on app start ────────┘
```

## Elaborate

L1/L2 caching and write-behind are straight out of CPU-cache and database
buffer-pool design — flattr applies them at the app layer over AsyncStorage. The
clean part is leaning on *immutability*: most cache complexity is invalidation, and
DEM samples never change, so the cache is write-once with no TTL and L2 is eternal.
The one rough edge worth naming: persisting the entire blob per flush is O(n); at
50k entries that's a non-trivial `JSON.stringify` + write, which is why it's
debounced — but a growth-heavy future would want incremental persistence (e.g.
per-region keys) instead. Read next: `02-single-flight-pump.md` (the build this
cache accelerates), `05-debounce-as-throttle-with-self-heal.md` (the throttling
this cache exists to prevent), `study-system-design` (the storage story across the
app), `study-performance-engineering` (flush-cost measurement).

## Interview defense

**Q: "How do you avoid re-fetching elevation for areas the user already visited?"**
A two-tier cache. L1 is an in-memory `Map` keyed by ~90 m DEM cell; L2 is
AsyncStorage, loaded once on mount. The read path (`cachedElevation`) checks L1 per
point, batches only the *misses* into a single API call, and fills L1 with the real
values. Because DEM elevation is immutable, cache entries are write-once and never
expire — and L2 makes them survive restarts, so reopening over your own
neighborhood makes zero elevation requests.

```
  points → L1 hit/miss split → ONE batch fetch for misses → fill L1 → flush L2 (debounced)
```
*Anchor: match the cache key to the data's natural resolution (the DEM cell), and
batch the misses.*

**Q: "Why write-behind instead of writing to disk on each put?"**
Because the write must stay off the build's hot path. `putElev` does a synchronous
`Map.set` and returns instantly; it marks dirty and arms a single 4 s debounced
timer that flushes the *whole* map once. A build that fills 200 cells triggers one
disk write, not 200.

```
  putElev → mem.set (instant) → dirty → [4s timer] → one AsyncStorage write
```
*Anchor: the part people forget — only real values are cached; flat-fallback 0 m
values are never written, so a degraded build can't poison the cache.*

## See also

- `02-single-flight-pump.md` — the build pipeline this cache sits inside.
- `05-debounce-as-throttle-with-self-heal.md` — the throttling this prevents;
  why degraded values are never cached.
- `audit.md` §4, §7.
