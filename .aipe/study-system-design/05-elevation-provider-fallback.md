# Elevation Provider Fallback + Persistent Cache

**Industry names:** provider abstraction / strategy pattern / cache-aside +
circuit-style fail-open. **Type:** Industry standard (the provider interface),
project-specific in how the fallback chain and the persistent cache compose.

---

## Zoom out, then zoom in

Elevation is the one piece of data flattr can't compute itself — it has to come
from an external DEM service. That makes it the system's weakest dependency:
free elevation APIs rate-limit (the spec warns Open-Meteo 429s under heavy
testing, `context.md`), and on a phone you might be offline entirely. flattr
handles this with three composed layers: an *interface* so providers are
swappable, a *fail-open wrapper* so a dead API never blocks a route, and a
*persistent cache* so a sampled cell is never re-fetched.

```
  Zoom out — where elevation handling lives

  ┌─ BUILD + RUNTIME (shared engine) ────────────────────────────────────┐
  │  ElevationProvider interface (elevation.ts:7-10)                      │
  │     ├─ googleProvider     ─┐                                          │
  │     ├─ openMeteoProvider  ─┤ pick one (run-build.ts:22-38)            │ ← here
  │     └─ flat fixture        ┘                                          │
  │            │ wrapped by:                                              │
  │            ├─ cachedElevation  → elevCache (AsyncStorage)             │
  │            └─ bestEffortElevation → flat 0m on error, flag degraded   │
  └────────────────────────────────────────────────────────────────────── ┘
```

Zoom in: the concept is **isolating a flaky external dependency behind one
interface, then wrapping it so it caches aggressively and never fails the
caller.** The question it answers: *how does a route still build when the
elevation API is throttled or the phone is offline?*

## Structure pass

**Layers.** Three wrappers stack around the raw provider, each adding one
property:

```
  the elevation stack — each layer adds one guarantee

  ┌─ bestEffortElevation ────────────────┐  → NEVER throws (fail-open)
  │  ┌─ cachedElevation ──────────────┐  │  → skips fetched cells (cache-aside)
  │  │  ┌─ openMeteoProvider ──────┐  │  │  → the raw HTTP call (can throw/429)
  │  │  │  fetch open-meteo.com    │  │  │
  │  │  └──────────────────────────┘  │  │
  │  └────────────────────────────────┘  │
  └──────────────────────────────────────┘
   outermost = strongest guarantee, innermost = the risky part
```

**Axis — `failure` (where does an elevation error stop?).** Trace a 429 outward:

```
  "what happens to a 429 from the elevation API?" — traced up the wrappers

  ┌──────────────────────────────────────┐
  │ openMeteoProvider                     │  → THROWS after retries (elevation.ts:108-119)
  └──────────────────────────────────────┘
        │  error propagates up
        ▼
  ┌──────────────────────────────────────┐
  │ cachedElevation                       │  → passes the error through (no swallow)
  └──────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────┐
  │ bestEffortElevation                   │  → CATCHES, returns flat 0m, flags degraded
  └──────────────────────────────────────┘     (useTileGraph.ts:23-28)

  the failure stops at the outermost wrapper — the caller never sees it
```

**Seam.** The `ElevationProvider` interface (`elevation.ts:7-10`) is the seam.
Because it's a one-method contract (`sample(points) → number[]`), every wrapper
*is* an `ElevationProvider` too — so they compose like middleware. The interface
is what lets cache, fail-open, and the raw call nest cleanly.

## How it works

### Move 1 — the mental model

You've wrapped a `fetch` before — a retry wrapper, a cache wrapper, an
error-boundary wrapper. Each takes the same shape and returns the same shape, so
they stack. flattr does exactly that with elevation: one interface, and each
concern is a wrapper that takes a provider and returns a provider.

The strategy in one sentence: **one provider interface, composed wrappers that
each add caching or fail-open behavior without the inner layer knowing.**

```
  The pattern — middleware composition over one interface

   provider = bestEffort( cached( openMeteo(fetch) ) )
                  │          │         │
                  │          │         └─ does the HTTP work, may 429
                  │          └─ checks cache; fetches only misses
                  └─ catches any throw → flat 0m + degraded flag

   each layer: ElevationProvider in, ElevationProvider out  → they nest
```

### Move 2 — the walkthrough

**Step 1 — the interface is one method.** That minimalism is what makes
composition work:

```ts
// pipeline/elevation.ts:7-10
export interface ElevationProvider {
  /** Elevation in meters for each point, in the same order. */
  sample(points: LatLng[]): Promise<number[]>;
}
```

Three implementations satisfy it: `googleProvider` (`elevation.ts:62+`, batches
256), `openMeteoProvider` (`elevation.ts:85+`, batches 100, the free default),
and a flat fixture (synthetic 0m, `run-build.ts:28`). The build picks one based
on env (`run-build.ts:22-38`): Google if a key is set, flat if `FLAT_ELEVATION=1`,
else Open-Meteo.

**Step 2 — the raw provider already retries and backs off.** Before any
wrapper, `openMeteoProvider` handles transient failures itself:

```ts
// pipeline/elevation.ts:108-119 (Open-Meteo, retry loop sketch)
// batches of 100, 300ms between batches (free-tier friendly)
// on 429: await sleep(delayMs * 2 ** (attempt + 1))   // exponential backoff
// retries: 3 (default), then throws
```

So the inner layer is already resilient to *transient* throttling. It only
throws when retries are exhausted — a *sustained* outage. That's what the
outer wrapper is for.

**Step 3 — `cachedElevation` makes a sampled cell free forever.** This wrapper
checks the persistent cache per DEM cell and only fetches the misses:

```ts
// mobile/src/useTileGraph.ts:38-62 (cachedElevation), :36 (cellKey)
const cellKey = (lat, lng) =>
  `${Math.round(lat / DEDUPE)},${Math.round(lng / DEDUPE)}`;  // 36: ~90m cell
// 45: hit?  getElev(cellKey(...)) → reuse
// 52-57: miss → provider.sample(missingPoints), then putElev(...) each
```

The cache key is a ~90m grid cell (`DEDUPE = 0.0008`, `useTileGraph.ts:69`),
matching the free DEM resolution — sampling finer than the data resolution is
wasted. Revisited areas hit zero API calls.

**Step 4 — the cache is persistent and survives restarts.** `elevCache.ts`
mirrors the in-memory `Map` to a single AsyncStorage key, debounced:

```ts
// mobile/src/elevCache.ts:7-9, :35-40, :42-53
const STORAGE_KEY = "flattr.elevCache.v1";       // 7
const PERSIST_DEBOUNCE_MS = 4000;                // 8: batch writes
const MAX_ENTRIES = 50000;                       // 9: LRU cap
// putElev: set in memory, mark dirty, schedule debounced persist (39)
// persistNow: slice to newest 50k, write JSON blob to AsyncStorage (49-53)
```

It loads once on mount (`useTileGraph.ts:126-128`), so a cell sampled in a prior
session is instant *and free* this session. That's the real defense against the
documented 429 problem — you mostly stop hitting the API at all.

```
  Layers-and-hops — an elevation request through the stack

  ┌─ Hook: useTileGraph (on-device build) ───────────────────────────────┐
  │  buildGraph(...) calls elev.sample(points)                           │
  │            │ hop 1: bestEffort → cached.sample(points)               │
  │            ▼                                                          │
  │  cachedElevation: split into hits / misses (elevCache lookup)        │
  │            │ hits → return from memory (NO network)                  │
  │            │ misses ↓ hop 2: openMeteo.sample(misses)                │
  └────────────┼────────────────────────────────────────────────────── ┘
               │                                  ┌─ Open-Meteo API ────┐
               │ hop 3 (misses only) ───────────► │ open-meteo.com      │
               │ ◄─────────────────────────────── │ (429? retry+backoff)│
               │   meters (or throw on outage)    └─────────────────────┘
               ▼
  ┌─ AsyncStorage ───────────────────────────────────────────────────────┐
  │  hop 4: putElev(cell, meters) → debounced write of flattr.elevCache.v1│
  └────────────────────────────────────────────────────────────────────── ┘
```

**Step 5 — `bestEffortElevation` makes failure impossible for the caller.**
The outermost wrapper catches any throw and returns flat elevations, flagging
the region so the rest of the system knows the grades are fake:

```ts
// mobile/src/useTileGraph.ts:20-28 (bestEffortElevation)
return {
  async sample(points) {
    try { return await p.sample(points); }      // try the real provider
    catch {
      onFallback();                              // 26: mark region degraded
      return points.map(() => 0);                // flat 0m — route still builds
    }
  }
};
```

`onFallback` sets `degraded = true` (`useTileGraph.ts:195`), which (a) keeps the
region out of the *display* graph so fake all-green grades don't paint over real
ones (`useTileGraph.ts:150-162`), (b) triggers the 12s self-heal retry
(`useTileGraph.ts:209-218`), and (c) drives the "Grades approximate — retrying"
UI message (`MapScreen.tsx:375-376`). Connectivity is preserved (the region is
still in the *routing* graph); only fidelity degrades.

#### Move 2 variant — what breaks if you remove each layer

The kernel is the interface plus two wrappers:

1. **The `ElevationProvider` interface** (`elevation.ts:7-10`). Remove it and
   the wrappers can't compose — caching and fail-open would each have to be
   baked into every provider. *Breaks: swappability and composition.*
2. **`cachedElevation`** (`useTileGraph.ts:38-62`). Remove it and every pan
   re-fetches elevation it already has, hammering the free API straight into the
   429 wall. *Breaks: staying under rate limits.*
3. **`bestEffortElevation`** (`useTileGraph.ts:20-28`). Remove it and a 429 or
   offline state throws out of `buildGraph`, the build fails, and the region
   never loads. *Breaks: routing while the API is down.*

Optional hardening: the inner retry/backoff (`elevation.ts:108-119`) handles
*transient* throttling; the dedupe-by-cell (`elevation.ts:40-59` build-time,
`cellKey` runtime) avoids sub-resolution waste. Both are tuning on top of the
three load-bearing layers.

### Move 3 — the principle

The principle is **isolate the dependency you don't control behind one
interface, then layer caching and fail-open around it as composable wrappers.**
The single-method interface is what makes the layering possible — each concern
(cache, fail-open) is independently testable and stacks without the others
knowing. And the fail-open default is the right call for a *quality* signal like
elevation: a route with approximate grades beats no route. Pair fail-open with an
honest flag (`degraded`) so the system never *silently* serves bad data — it
serves best-effort data, labeled.

## Primary diagram

```
  Elevation provider fallback + persistent cache — the full picture

  ┌─ pick provider (run-build.ts:22-38) ─────────────────────────────────┐
  │  Google (key set) | flat fixture (FLAT_ELEVATION=1) | Open-Meteo      │
  │  all satisfy ElevationProvider.sample (elevation.ts:7-10)            │
  └───────────────────────────────┬────────────────────────────────────── ┘
                                   │ wrapped (outer → inner)
                                   ▼
  ┌─ bestEffortElevation (useTileGraph.ts:20-28) ────────────────────────┐
  │  try inner; catch → flat 0m + degraded flag (never throws)           │
  │  ┌─ cachedElevation (ts:38-62) ────────────────────────────────────┐ │
  │  │  per ~90m cell: hit → memory (free) | miss → fetch + putElev     │ │
  │  │  ┌─ openMeteoProvider (elevation.ts:85+) ───────────────────────┐│ │
  │  │  │  batch 100, 300ms spacing, 429 → exp backoff, then throw     ││ │
  │  │  └──────────────────────────────────────────────────────────────┘│ │
  │  └──────────────────────────────────────────────────────────────────┘ │
  └──────────────────┬─────────────────────────────────┬────────────────── ┘
                     │ persist (debounced 4s, LRU 50k)  │ degraded → self-heal
                     ▼                                   ▼ retry 12s + UI note
            AsyncStorage flattr.elevCache.v1     (useTileGraph.ts:209-218)
```

## Elaborate

The provider interface is the classic Strategy pattern, and the wrapping is
middleware composition — the same shape as Express middleware or React HOCs,
applied to a data provider. The interesting design judgment is the *order* of
the wrappers: cache inside fail-open means a cache hit never triggers the
fail-open path, and the degraded flag only fires on a real outage, not on cached
data. Flip them and you'd get spurious degraded flags on cached cells.

The persistent cache is the practical heart. The spec explicitly warns that
Open-Meteo 429s under heavy use (`context.md`, "External-data caveat"), and the
50k-entry AsyncStorage cache (`elevCache.ts:9`) is what turns a chronic problem
into a first-visit-only one. Keying by ~90m cell rather than exact coordinate is
the move that makes the cache dense — nearby points share a cell, so the hit rate
is high. Read `04-honest-fallback-routing.md` for the routing side of the
degraded flag and `02-on-device-pipeline-rerun.md` for where `sample` is called
on-device.

## Interview defense

**Q: How does a route still build when the elevation API is down?**
Three composed layers around one interface. `bestEffortElevation`
(`useTileGraph.ts:20-28`) catches any provider error and returns flat 0m
elevations, so `buildGraph` never fails — the route still computes, just with
approximate grades, and the region is flagged `degraded` so the UI says "grades
approximate, retrying" (`MapScreen.tsx:375`) and a 12s timer re-tries
(`useTileGraph.ts:209-218`).

```
  bestEffort( cached( openMeteo ) )
       │         │        └─ may 429 / be offline → throws
       │         └─ serves fetched cells from AsyncStorage (avoids most calls)
       └─ catch → flat 0m + degraded flag → route survives, labeled
```
Anchor: *fail-open with an honest degraded flag — best-effort data, never
silent bad data.*

**Q: Why does this design avoid the documented 429 problem?**
The persistent cache. Elevation per location is constant, so once a ~90m cell is
sampled it's cached in memory and in AsyncStorage (`elevCache.ts`), surviving
restarts (`useTileGraph.ts:126-128`). After the first visit to an area, those
cells cost zero API calls — the app mostly stops hitting Open-Meteo, which is
where the 429s came from.

**Q: The load-bearing part people forget?**
The wrapper *order* — cache inside fail-open. It means a cache hit never trips
the degraded flag and the flag only fires on a genuine outage. Reverse them and
cached cells would spuriously mark regions degraded.

## See also

- `02-on-device-pipeline-rerun.md` — where `sample` runs on-device
- `04-honest-fallback-routing.md` — the routing side of the degraded flag
- `audit.md` §4 (caching), §6 (failure handling)
- neighboring: **study-networking** (retry, backoff, batching on the wire),
  **study-database-systems** (AsyncStorage key-value durability)
