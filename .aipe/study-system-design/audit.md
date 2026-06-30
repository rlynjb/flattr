# System-design audit — flattr

Pass 1. Eight lenses, each walked against the codebase. Findings are grounded in
`file:line`. Where a lens finds nothing, it says `not yet exercised` — flattr is a
single-device app over a static artifact, so several distributed/scale lenses are
honestly empty. Inferred behavior is labeled **[inference]**.

---

## 1. system-map-and-boundaries

flattr has **two execution contexts and one trust boundary that matters**: the
build-time pipeline (Node, your machine, `npm run build:graph`) and the runtime app
(Expo / React Native, the phone). Between them sits a static artifact —
`data/graph.json`, copied to `mobile/assets/graph.json` (544 KB on disk).

Major components and responsibilities:

- **Build pipeline** (`pipeline/`) — owns turning OSM + elevation into a `Graph`.
  Entry `pipeline/run-build.ts:40`; orchestration `pipeline/build-graph.ts:12`.
- **Shared engine** (`features/`, `lib/`) — owns graph representation, cost, and
  search. Used by *both* contexts; `pipeline/build-graph.ts:2` notes it imports no
  `node:fs` precisely so it bundles for the app.
- **Artifact** — `mobile/assets/graph.json`, read once at startup
  (`mobile/src/loadGraph.ts:9`). This is the entire persisted state.
- **Runtime coverage engine** (`mobile/src/useTileGraph.ts:96`) — owns fetching and
  merging additional graph regions on-device.
- **UI** (`mobile/src/MapScreen.tsx`) — owns routing invocation, display, and the
  honesty card.

**Trust / external boundaries.** Three stateless third-party APIs, all reached over
HTTPS, none holding flattr state: Overpass (`pipeline/overpass.ts:4`), Open-Meteo /
Google Elevation (`pipeline/elevation.ts:92`, `:65`), Nominatim geocode
(`pipeline/geocode.ts:5`). Each is rate-limited and treated as untrusted-for-
availability — every call has a fallback or a retry. No API keys ship in the app:
Google requires `GOOGLE_ELEVATION_KEY` and is build-time only
(`pipeline/run-build.ts:23`); the runtime uses keyless Open-Meteo.

The sharp boundary: **the artifact**. Everything above it is your build machine;
everything below is the user's phone. → deep walk in `01-build-time-graph-artifact.md`.

---

## 2. request-response-and-data-flow

There is no server request flow. The two flows that matter are both client-side.

**Flow A — cold start + route** (the happy path):

```
  loadGraph (bundled JSON)  ─►  baseGraph
  tap From / To             ─►  setStartPt/setEndPt (coordinates, not node ids)
  endpoints effect          ─►  ensureBbox(corridor)  ─► on-device pipeline build
  graph (merge+stitch)      ─►  nearestNode re-snap   ─► directedAstar
  result                    ─►  routeToGeoJSON + routeSummary + honest card
```

Grounded: `MapScreen.tsx:139` (endpoint effect → `ensureBbox`), `:133` (re-snap
`nearestNode` against the *current* graph), `:151` (one `directedAstar` call). The
deliberate move: endpoints are stored as **coordinates**, and the node id is
re-derived every time the graph changes (`MapScreen.tsx:58`, `:133`) — so a closer
node appearing mid-load re-snaps correctly.

**Flow B — pan to load grades** (`useTileGraph.ts`):

```
  onRegionDidChange ─debounce 600ms─► queueViewport ─► pump (single-flight)
       │                                                  │
       │  gate: span ≤ MAX_LOAD_SPAN_DEG, grades toggled on
       ▼                                                  ▼
  fetchOverpass ─► buildGraph (cached+bestEffort elev) ─► prefixGraph ─► setView
```

Parallel vs serial: **deliberately serial.** Only one network build runs at a time
(`busyRef`, `useTileGraph.ts:113`), with the route corridor prioritized over the
viewport (`pump`, `:170`) so a pending route isn't starved by panning. This is a
*throughput sacrifice to stay under free-tier rate limits* — named, not apologized
for. → `02-on-device-pipeline-rerun.md`, `03-tile-merge-stitch.md`.

---

## 3. state-ownership-and-source-of-truth

| State | Owner | Where | Mutability |
| --- | --- | --- | --- |
| Base graph | the artifact | `mobile/assets/graph.json` via `loadGraph.ts` | immutable (rebuild to change) |
| Viewport / corridor regions | `useTileGraph` | `view`/`corridor` React state + refs | mutable, rebuilt on pan/route |
| Merged routing graph | derived | `useMemo` over base+corridor+view (`useTileGraph.ts:132`) | recomputed, never stored |
| Endpoints | `MapScreen` | `startPt`/`endPt` as **coordinates** (`:59`) | user-set |
| `userMax` (the one knob) | `MapScreen` | `useState` (`:56`) | user-set via slider |
| Elevation cache | `elevCache` module | in-memory `Map` + AsyncStorage (`elevCache.ts:11`) | append-only, never invalidated |

The source-of-truth discipline worth noting: **node ids are derived, not stored.**
The canonical endpoint is its lat/lng; the routable node id is re-derived from the
live graph (`MapScreen.tsx:133`). This is what lets corridor tiles load without
breaking an in-progress route. The single product knob, `userMax`, flows into the
cost function (`cost.ts:16`) and the display bands (`classify.ts`) — one value,
two consumers.

---

## 4. caching-and-invalidation

One real cache, and a coverage check that acts like a second.

**Elevation cache** (`mobile/src/elevCache.ts`) — keyed by ~90m DEM cell
(`useTileGraph.ts:36`), in-memory `Map` mirrored to AsyncStorage
(`STORAGE_KEY = "flattr.elevCache.v1"`, `elevCache.ts:7`). Writes debounced 4 s and
batched (`:8`, `:39`); a 50 000-entry cap drops oldest first (`:9`, `:48`).
**Invalidation strategy: none, by design** — "DEM samples never change, so cached
values are valid forever" (`elevCache.ts:3`). Only successfully-fetched values are
cached; flat-fallback zeros are not (`useTileGraph.ts:52-58`). This is the right
call: the underlying data is genuinely immutable, so an invalidation policy would
be pure overhead. → `05-elevation-provider-fallback.md`.

**Coverage check as cache** — `covers()` (`useTileGraph.ts:82`) is a read-through
guard: if the base graph or the current region already contains a requested bbox,
skip the fetch entirely (`:233`, `:273`). The twist: a **degraded** region (built
with flat-fallback elevation) reports `covers → false` so it gets refetched and
upgraded once the API recovers (`:83`). Stale-grade behavior is explicit: degraded
regions stay in the *routing* graph (flat grades still connect) but are excluded
from the *display* graph so bogus all-green doesn't paint over real grades
(`useTileGraph.ts:132` vs `:150`).

---

## 5. storage-choice-and-durability-boundaries

**There is no datastore.** The entire persistent state is one JSON file. This is the
defining architectural choice, so it deserves a clear statement of *why*:

- The graph is read-only at runtime and rebuilt offline. A database would add a
  server, a query layer, and an availability dependency to serve data that never
  changes between builds. The file wins on cold-start latency (no network, no query)
  and on operational cost (no server). → `01-build-time-graph-artifact.md`.
- Durability is the build's problem, not the runtime's: `run-build.ts:11` does a
  single `writeFileSync` of `JSON.stringify(graph)`. No atomic rename, no fsync — a
  crash mid-write corrupts `data/graph.json`, but it's regenerable from a command, so
  the durability bar is deliberately low. **[inference]** the on-disk
  serialization/atomicity mechanics belong to `study-database-systems`; the schema
  shape (`features/routing/types.ts`) belongs to `study-data-modeling`.
- The runtime's only durable store is AsyncStorage for the elevation cache
  (`elevCache.ts`), and that's a performance cache, not a source of truth — losing it
  costs requests, not correctness.

---

## 6. failure-handling-and-reliability

This is flattr's strongest system-design area. Every external dependency can fail,
and each failure has a named, distinct degradation:

- **Elevation API down/throttled** → `bestEffortElevation` catches and returns flat
  0 m so the build still produces a connected graph; the region is flagged
  `degraded` and silently re-queued up to `MAX_RETRIES = 6` to self-heal
  (`useTileGraph.ts:20`, `:209`). The user sees "Grades approximate — elevation
  unavailable, retrying" (`MapScreen.tsx:376`). → `05-elevation-provider-fallback.md`.
- **Overpass fails** (offline / rate-limited) → the build's `catch` keeps the last
  region; a later pan retries (`useTileGraph.ts:219`). The build-time fetch retries
  429/502/503/504 with linear backoff (`overpass.ts:42`).
- **No flat route vs no route at all** → the load-bearing reliability choice:
  `BLOCKED = 1e9` is **large-finite, not Infinity** (`cost.ts:5`), so an only-steep
  path is still returned and flagged, distinct from a disconnected "no route"
  (`RouteSummaryCard.tsx` three states). → `04-honest-fallback-routing.md`.
- **GPS denied** → camera falls back to the base-area center
  (`MapScreen.tsx:43`, `:102`); the app still works.
- **Single-flight + corridor priority** → guarantees one in-flight build and that a
  route never starves behind panning (`useTileGraph.ts:166`).

**Retries:** present at three layers — build-time Overpass backoff
(`overpass.ts:42`), runtime elevation 429 backoff (`elevation.ts:114`), and the
self-heal degraded-region re-queue (`useTileGraph.ts:209`). **Partial failure** is
handled per-region, not globally: one degraded tile doesn't poison neighbors.
Coordination mechanics across nodes → `study-distributed-systems` (mostly N/A here).

---

## 7. scale-bottlenecks-and-evolution

What breaks first as the covered area or the user base grows:

- **At 10× area** — the bundled `graph.json` (544 KB for a Capitol Hill slice) grows
  roughly linearly; a full-city graph would bloat the app bundle and the cold-start
  parse. `config.ts:4` explicitly keeps the bbox small for this reason. **[inference]**
  the fix the code already anticipates: ship a smaller base and lean harder on the
  on-device pipeline rerun (`useTileGraph.ts`), or split the artifact into lazily-
  loaded tiles.
- **At 10× users** — flattr has *no shared backend*, so user count doesn't load any
  flattr server. The bottleneck moves entirely onto the **third-party free tiers**:
  Overpass and Open-Meteo rate limits are global, not per-user, so many users panning
  uncovered areas would collectively exhaust quota. The serial single-flight pump and
  the 90m dedup cache (`useTileGraph.ts:113`, `elevCache.ts`) are exactly the
  throttle-avoidance levers — but they protect *one* device, not the fleet. This is
  the real scale ceiling: it's an externality, not internal capacity.
- **What stays stable** — routing itself. A* over a merged in-memory graph is
  CPU-local and independent of user count.
- **The change that forces rearchitecture** — moving elevation/OSM fetching server-
  side (a cache proxy in front of Overpass/Open-Meteo) the moment the global free-tier
  ceiling is hit. That introduces the first real backend, the first shared cache, and
  the first distributed-systems concerns — none of which exist today.

---

## 8. system-design-red-flags-audit

Ranked by architectural risk, each grounded:

1. **Free-tier rate limits are the whole reliability model** (`useTileGraph.ts`
   single-flight + dedup + backoff; `overpass.ts`, `elevation.ts`). The app's
   correctness under load depends on third parties whose limits are shared globally
   and outside flattr's control. *Mitigation already present:* aggressive caching +
   serialization + flat-fallback. *Real fix at scale:* a self-hosted proxy/cache.
2. **`edgeById` is O(E) linear scan** (`features/routing/graph.ts:3`,
   `Array.find`), called per edge in `routeSummary` (`summary.ts:14`) and
   `geojson`. On the merged multi-region graph this is O(E²)-ish for summary. The
   search engine avoids it (`indexEdges` builds an O(1) map, `astar.ts:12`), so the
   pattern to copy already exists in the repo. *Mechanism-level perf →
   `study-performance-engineering`.*
3. **Non-atomic artifact write** (`run-build.ts:11`, bare `writeFileSync`). A crash
   mid-write corrupts `graph.json`. Low blast radius (regenerable), but a temp-file +
   rename would cost nothing.
4. **`stitchGraph` re-scans all nodes on every merge** (`tiles.ts:45`), recomputed in
   a `useMemo` keyed on base/corridor/view (`useTileGraph.ts:132`). For a few regions
   this is fine; if region count grows it becomes the pan-latency cost.
5. **No upper bound on merged-graph node count.** Each pan into new territory adds a
   region and never evicts (`useTileGraph.ts` keeps `view`/`corridor`, base is
   permanent). Long sessions over wide areas grow memory unbounded. **[inference]**
   not yet a problem at the current bbox sizes; would need an LRU on regions to fix.

None of these are blocking at the current scope — flattr is a small-bbox, single-
device app and the code says so. They're the ordered list of what to harden *first*
the moment the scope grows.
</content>
