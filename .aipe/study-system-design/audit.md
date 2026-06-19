# Pass 1 — the 8-lens system-design audit

One `##` section per lens. Each names what the codebase actually does, grounded
in `file:line`, or says `not yet exercised`. Where a finding earns a dedicated
pattern file, the lens cross-links to it instead of restating it.

The honest frame up top: the spec (`docs/flattr-spec.md` §5, §8) targets
**Next.js + MapLibre GL JS on Netlify**, graph served from **Netlify Blobs**,
optional **server-side A\***. The **built** system is **Expo RN + a bundled
`graph.json` + client-side A\***. So several lenses below find the *as-designed*
architecture absent and the *as-built* one present. Both are named.

---

## 1. system-map-and-boundaries

Two phases joined by one artifact, plus a third (leaking) path. The full map is
in `00-overview.md`. The components and their trust boundaries:

**Build-time (offline, `tsx`):**
- `pipeline/run-build.ts:40-52` — the CLI entry. Picks an elevation source
  (`pickElevation`, `:22-38`), fetches OSM, builds, writes `data/graph.json`.
- `pipeline/build-graph.ts:12-30` — the stage DAG: `parseOsm → splitWays →
  sampleElevations → computeGrades → buildAdjacency`. Note `:2` — **no
  `node:fs`** in this module, deliberately, so it bundles for the phone.
- External deps, all over HTTP, all free-tier: Overpass
  (`pipeline/overpass.ts:4`), Open-Meteo / Google (`pipeline/elevation.ts`).

**The artifact (the boundary):**
- `data/graph.json` (544 KB) → copied to `mobile/assets/graph.json` (544 KB,
  byte-identical). The `Graph` type (`features/routing/types.ts:22-28`) is the
  *entire contract* between phases. → `02-bundled-graph-artifact.md`

**Run-time (Expo RN, on-device):**
- `mobile/src/loadGraph.ts:9-11` — imports the bundled JSON as `Graph`.
- `mobile/src/MapScreen.tsx:26-349` — the composition root: state, render,
  routing trigger.
- `features/routing/astar.ts` — A\* runs **on the phone**, no server.

**Trust boundaries.** There is no server, so there is no server/client trust
boundary. The only trust boundaries are the three third-party HTTP APIs
(Overpass, Open-Meteo, Nominatim) — all untrusted external sources, all
read-only, all consumed with injectable `fetchImpl` so tests never hit them
(`pipeline/overpass.ts:24`, `pipeline/geocode.ts:11`). No auth anywhere: there
are no accounts (spec §13 lists accounts as out of scope).

The defining boundary — build vs runtime — is the subject of
`01-build-time-runtime-split.md`. The surprising finding that the runtime
*crosses back* into build territory is `03-on-device-pipeline.md`.

`not yet exercised`: a server tier, an API gateway, Netlify Blobs as the artifact
store, any inter-service boundary. Spec §5 / §8 propose them; the repo has none.

---

## 2. request-response-and-data-flow

There is no request/response in the HTTP-server sense — no backend receives
requests. The meaningful flows are **on-device data flows**. Three matter:

**Flow A — cold start → first render.**
`MapScreen` mounts → `loadGraph()` (`MapScreen.tsx:28-34`) imports the bundled
graph → `prefixGraph(.., "base")` namespaces its ids → `useTileGraph(baseGraph)`
holds it → `graphToGeoJSON` (`MapScreen.tsx:116-119`) colors every edge by
`absGradePct` → MapLibre renders the heatmap. No network needed; the bundled
bbox is on screen instantly.

**Flow B — route request (the core flow).**
User sets From/To (geocode, tap, or "current location") → endpoints stored as
**coordinates not node ids** (`MapScreen.tsx:55-56`) → an effect
(`MapScreen.tsx:131-140`) calls `ensureBbox` to load the corridor spanning both
endpoints → `nearestNode` re-snaps each coordinate to the current graph
(`MapScreen.tsx:125-126`) → `directedAstar(graph, startId, endId, userMax)`
(`MapScreen.tsx:147`) → `routeToGeoJSON` + `routeSummary` → route line + honesty
card. The endpoints-as-coordinates choice is load-bearing: it lets the ids
re-derive as corridor tiles stream in, so a route doesn't break when a closer
node appears mid-load. → `04-tile-merge-stitch.md`, `05-honest-fallback-routing.md`

**Flow C — pan → load more coverage (the leak).**
`onRegionDidChange` (`useTileGraph.ts:131-151`) debounces 600 ms, checks whether
the base graph or current viewport already covers the bounds, and if not,
**runs the build pipeline for the padded viewport bbox** —
`fetchOverpass → buildGraph → openMeteoProvider` (`useTileGraph.ts:106-120`).
This is build-time work happening at runtime. → `03-on-device-pipeline.md`

**Parallelism / serialization.** Flows B and C compete for the network, and the
code **serializes them deliberately**: a single `busyRef` + a `pump()`
(`useTileGraph.ts:89-129`) runs **one build at a time**, with the route corridor
prioritized over the viewport so panning can't starve a pending route. Geocoding
is sequential too (`MapScreen.tsx:181`) — Nominatim allows ~1 req/sec.

---

## 3. state-ownership-and-source-of-truth

The cleanest part of the architecture. Hold one question — *who owns this, and
can it change?* — across the layers:

| State | Owner | Mutable? | Source of truth |
|---|---|---|---|
| The base graph | `mobile/assets/graph.json` (build artifact) | **No** — immutable at runtime | the offline pipeline |
| Viewport / corridor graphs | `useTileGraph` refs + React state (`useTileGraph.ts:61-70`) | derived, ephemeral | re-fetched from Overpass/Open-Meteo on demand |
| The merged routable graph | `useMemo` (`useTileGraph.ts:72-85`) | derived | `stitch(merge[...])` of the above |
| Route endpoints | `MapScreen` state, as **coordinates** (`MapScreen.tsx:55-56`) | yes | user input (geocode/tap/GPS) |
| Snapped node ids | `useMemo` over graph + coords (`MapScreen.tsx:125-126`) | derived | re-derived every graph change |
| `userMax` (the one knob) | `MapScreen` state (`MapScreen.tsx:52`) | yes | user slider/preset |
| The route + summary | `useMemo` (`MapScreen.tsx:143-154`) | derived | a single `directedAstar` call |

The discipline worth naming: **the graph is the source of truth and it is
immutable** — `loadGraph` returns it, nothing writes it back. Everything
downstream (heatmap, zones, route, snapped ids) is **derived state** recomputed
via `useMemo`, never separately stored. Endpoints are kept as raw coordinates
precisely so the *derived* node ids can re-snap as the graph grows. There is no
persisted user state at all — no accounts, no saved routes (spec §13, §10
Phase 4 defer these). Refresh the app and you're back to the bundled bbox.

`not yet exercised`: URL state, form state beyond the address inputs, any
server-owned or synced state, any cache that survives a process restart.

---

## 4. caching-and-invalidation

There is no formal cache layer — no Blobs, no Redis, no HTTP cache headers
honored, no persisted store. What exists is **in-memory coverage tracking that
behaves like a cache**:

- `covers()` (`useTileGraph.ts:45-49`) and `bboxContains()` (`:51-53`) are the
  cache-hit test: before fetching a viewport/corridor, check whether the bundled
  base graph or the current region already contains the requested bbox. If so,
  skip the fetch entirely (`useTileGraph.ts:141-142`, `:160`). That's a hit.
- The "cache" holds exactly **one viewport region and one corridor region** at a
  time (`useTileGraph.ts:61-62`). A new viewport build **replaces** the old one
  (`:117-119`) — there's no multi-tile LRU, no eviction policy, just last-write.
- **Invalidation is by replacement, and it's coarse.** Pan away and back and the
  region is refetched from Overpass/Open-Meteo. There's no staleness model
  because the underlying data (OSM streets, terrain) effectively never changes
  on the timescale of a session.
- The cell-dedup in `sampleElevations` (`pipeline/elevation.ts:42-59`) is a
  *within-build* cache: nodes in the same ~90 m DEM cell share one elevation
  query. That's a request-coalescing cache keyed by rounded lat/lng.

`not yet exercised`: any durable cache, CDN caching of the artifact, cache
invalidation on data change, stale-while-revalidate. The spec's Netlify Blobs
tier (§8) would be the cache/store; it isn't built.

---

## 5. storage-choice-and-durability-boundaries

**There is no database.** This is a deliberate, spec-level decision
(`docs/flattr-spec.md` §5: "no live DB, no server state"). Storage is two flat
files and the app bundle:

- **`data/graph.json`** — the build output. Written once by
  `run-build.ts:11-13` (`writeFileSync`, the *only* `node:fs` write in the
  system). Plain JSON, no schema migration, no versioning.
- **`mobile/assets/graph.json`** — a manual copy of the above, bundled into the
  app at build time. The durability guarantee is "whatever the app store package
  guarantees" — it ships with the binary.
- **`mobile/assets/graph.sample.json`** — an offline synthetic fallback graph
  (`loadGraph.ts:4-5`), not imported unless explicitly swapped in.

The durability boundary is trivial because the data is **immutable and
regenerable**: lose `graph.json` and you re-run `npm run build:graph`. There's
nothing to back up, no write path to make durable, no consistency to maintain.
That's the whole point of the build/runtime split — → `02-bundled-graph-artifact.md`.

Schema shape (Node / Edge / Graph, signed vs absolute grade) belongs to
**`.aipe/study-data-modeling/`**. Storage-engine internals (there is no engine)
belong to **`.aipe/study-database-systems/`** — `not yet exercised` there.

`not yet exercised`: Netlify Blobs (spec §8), per-city tiled storage on a server
(spec §5 `tiles/`), any transactional or durable write path.

---

## 6. failure-handling-and-reliability

This is unusually well-considered for a solo project, and it's worth studying.
The system is built to **degrade rather than fail**, in three layered ways:

**Retry at the transport edge.** `fetchOverpass` retries 429/502/503/504 with
linear backoff (`overpass.ts:18`, `:42-46`). `openMeteoProvider` retries 429
with *exponential* backoff (`elevation.ts:114-117`). The build-time CLI uses the
default patient retry; the runtime uses fail-fast settings
(`useTileGraph.ts:111`: `retries: 1`) so a throttled on-device build degrades
quickly instead of stalling the screen on doomed backoffs.

**Degrade to flat instead of failing the build.** `bestEffortElevation`
(`useTileGraph.ts:18-28`) wraps the elevation provider so that if sampling
throws, it returns **0 m for every point** rather than aborting. The streets
still render and routing still connects; grades fill in on a later load when the
API recovers. Coverage over fidelity, stated explicitly in the comment. →
`06-elevation-provider-fallback.md`

**Keep the last good state on failure.** If an on-device build throws entirely
(Overpass down/offline), `pump()` swallows it and **keeps the last region**
(`useTileGraph.ts:121-122`); a later pan retries. The screen never goes blank.

**The honest-fallback graph distinction.** The router separates "no flat route"
from "no route at all" by making `BLOCKED` a **large finite constant, not
`Infinity`** (`cost.ts:5-6`). A steep-only path is still returned and flagged
(`steepEdges`, `astar.ts:126-128`); `null` is reserved for a genuinely
disconnected graph. The UI surfaces all three states (`RouteSummaryCard.tsx`).
→ `05-honest-fallback-routing.md`

**Offline behavior.** The bundled bbox works fully offline (graph + A\* are
local). Panning/routing beyond it needs network and degrades as above.

Coordination mechanics under partial failure (there are none — single process,
single device) belong to **`.aipe/study-distributed-systems/`** —
`not yet exercised`.

---

## 7. scale-bottlenecks-and-evolution

The system is honestly scoped to **one small bbox**: `BBOX` in
`pipeline/config.ts:10` is `[-122.3284, 47.6181, -122.3214, 47.6241]` — roughly
0.7 km × 0.7 km of Capitol Hill, yielding a 544 KB `graph.json`. What breaks as
that grows:

**What breaks first (10×).** The bundled artifact size. A full-city walk graph
at 12 m segment granularity (`config.ts:13`) is large; 10× the area is roughly
10× the 544 KB and it's all loaded into memory and turned into GeoJSON on a
phone. `nearestNode` (`nearest.ts:5-18`) is **O(nodes) linear scan** per snap —
fine at a few thousand nodes, a problem at a million. `edgeById`
(`graph.ts:3-7`) is `edges.find` — O(E) — though `astar.ts:12-16` already builds
an id→edge index to avoid that in the hot loop.

**What breaks at 100×.** The on-device pipeline. Every pan beyond coverage runs
Overpass + elevation + build on the phone (`useTileGraph.ts:106-120`); at city
scale you'd hammer free-tier APIs and stall. This is exactly where the spec's
**fork D (server-side A\*)** and **Netlify Blobs tiled storage** were meant to
take over — neither is built.

**What stays stable.** The `Graph` contract and the router. A\* doesn't care how
big the graph is for *correctness*; it's the same `(cost, heuristic)` engine
(`astar.ts:22-78`). The merge/stitch composition (`tiles.ts`) already handles
multiple graph regions, so the data model survives the scale jump — it's the
*delivery* (bundle vs server) and the *index structures* (linear scans) that
force a rearchitecture.

**The one change that forces rearchitecture:** moving off the bundled artifact
to a served, tiled, possibly server-routed graph (spec §11 D/E). The router code
survives it; the loading/coverage layer (`loadGraph` + `useTileGraph`) is what
gets replaced. → `01-build-time-runtime-split.md` Move 2.5 walks this migration.

---

## 8. system-design-red-flags-audit

Ranked by architectural impact, each grounded in evidence. These are *findings*,
not condemnations — most are correct calls for the current scope, named so a
reviewer hears them from you first.

1. **The build/runtime split leaks: the runtime imports and runs the pipeline.**
   `useTileGraph.ts:11-13` imports `pipeline/overpass`, `pipeline/build-graph`,
   `pipeline/elevation`. The "thin runtime that only reads the artifact" (spec
   §5) is, as built, a runtime that *also builds*. This is the single most
   important architectural fact in the repo. It's a reasonable expedient (it
   gives pan-to-extend coverage without a server), but it collapses the clean
   boundary the whole design is organized around, and it puts free-tier API
   calls on the phone's critical path. → `03-on-device-pipeline.md`.

2. **The artifact is copied by hand, byte-for-byte, with no version stamp.**
   `data/graph.json` and `mobile/assets/graph.json` are identical 544 KB files
   kept in sync manually (`loadGraph.ts:2-3` comment: "regenerate ... then copy
   ... here"). No content hash, no schema version, no check that the bundled
   graph matches the engine that reads it. Drift is silent.

3. **`nearestNode` and `edgeById` are linear scans.** `nearest.ts:5-18` is
   O(nodes) per endpoint snap; `graph.ts:3-7` is O(E). Fine at 544 KB, a wall at
   city scale. A spatial index (grid/kd-tree) and a persistent edge map are the
   fixes; neither is needed yet. Note the hot-loop case is already handled
   (`astar.ts` indexes edges once).

4. **Heatmap + zones recompute over the *entire* merged graph on every change.**
   `MapScreen.tsx:116-121`: `graphToGeoJSON` and `computeZones` run over all
   edges whenever `graph` or `userMax` changes. As coverage grows this is
   repeated full-graph work on the JS thread. Memoized by dependency, but not
   incremental.

5. **`mergeGraphs` last-write-wins on id collision is silent.**
   `tiles.ts:94-97` uses `Object.assign` for nodes/adjacency. Id namespacing via
   `prefixGraph` (`tiles.ts:21-38`) is what prevents collisions — so the safety
   depends entirely on every region being prefixed before merge. Miss a prefix
   and regions silently clobber each other. → `04-tile-merge-stitch.md`.

6. **No tests on the mobile/runtime layer.** The engine (`features/`,
   `pipeline/`) is Vitest-covered; `mobile/src/*` (the composition, the leak, the
   pump) has no test seam visible. The riskiest, most stateful code is the least
   tested. (Coverage detail belongs to `.aipe/study-testing/`.)

None of these are blocking for a single-bbox portfolio MVP. #1 and #2 are the
two a senior reviewer will probe first — own them.
