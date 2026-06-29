# System Design Audit — flattr

Pass 1 of the two-pass study shape. This file walks the 8 system-design lenses
against flattr as it actually stands. Each lens names what the codebase does
with `file:line` grounding, or says `not yet exercised` honestly. Where a
finding is load-bearing enough to deserve a deep walk, it cross-links to a
Pass-2 pattern file.

The one-sentence verdict: flattr is a **build-time/runtime-split, backend-less,
local-first router** whose most interesting move is that the *same pipeline
that builds the artifact offline re-runs on-device* to extend coverage past the
prebuilt slice.

---

## 1. system-map-and-boundaries

Two execution contexts, one shared engine.

**Build-time (Node, `tsx`).** `pipeline/run-build.ts:40-52` is the entrypoint
(`npm run build:graph`). It fetches OSM for a fixed bbox
(`pipeline/config.ts:10`, a Capitol Hill slice of Seattle), runs
`buildGraph(...)` (`pipeline/build-graph.ts:12-30`), and writes a single JSON
file (`pipeline/run-build.ts:11-13`, `JSON.stringify(graph)` to
`data/graph.json`). No server is involved; this runs on a laptop.

**Runtime (Expo / React Native).** `mobile/src/loadGraph.ts:7` statically
imports `../assets/graph.json` — the build artifact, copied in by hand. The app
reads it and routes. There is **no live backend and no database**
(context.md confirms: "No live backend / DB"). State lives in React and in one
AsyncStorage key.

**The shared engine.** `features/`, `lib/`, and `pipeline/` are framework-free
TypeScript modules used by both contexts. Metro (the RN bundler) only watches
files inside the project root, so `mobile/scripts/sync-engine.mjs:15-19` copies
those three directories into `mobile/.engine/` at build time. That copy is the
seam that lets the device run the build-time pipeline.

**Trust boundaries / external dependencies.** Three external HTTP services,
all best-effort:
- Overpass (`pipeline/overpass.ts:4`, `overpass-api.de`) — OSM street geometry.
- Elevation — Google (`pipeline/elevation.ts:72`) or Open-Meteo
  (`pipeline/elevation.ts:106`), selected at `pipeline/run-build.ts:22-38`.
- Nominatim (`pipeline/geocode.ts:5`) — address → coordinates, used by the
  `AddressBar`.

→ The build-time/runtime split is the whole architecture: see
`01-build-time-graph-artifact.md`.
→ The on-device re-run of the pipeline: see `02-on-device-pipeline-rerun.md`.

## 2. request-response-and-data-flow

There is no request/response in the classic web sense — no HTTP handlers, no
API routes. The flows are (a) the build pipeline, run once offline, and (b) two
on-device data-acquisition flows.

**Build flow** (`pipeline/build-graph.ts:21-29`), strictly sequential:
parse OSM → split ways into ≤12m edges → sample elevation → compute signed
grades → build adjacency → serialize. Each stage feeds the next; no parallel
fan-out. The elevation stage is the slow one (network-bound,
`pipeline/elevation.ts:96-115` throttles and backs off).

**Viewport flow** (runtime). A map pan fires `onRegionDidChange`
(`mobile/src/useTileGraph.ts:245-258`), debounced 600ms, which enqueues a
viewport build and calls `pump()`. The pump runs the *same pipeline* for the
panned bbox.

**Corridor flow** (runtime). When both route endpoints are set, an effect in
`mobile/src/MapScreen.tsx:139-148` calls `ensureBbox(...)` over the bounding box
of start+end, which builds the *entire corridor in one fetch* rather than
per-tile. Corridor builds take priority over viewport builds in the pump
(`mobile/src/useTileGraph.ts:170-177`).

The handoff that makes this work: endpoints are stored as **coordinates, not
node ids** (`mobile/src/MapScreen.tsx:57-60`), so `nearestNode` re-derives the
snap target as new tiles load (`mobile/src/MapScreen.tsx:132-134`).

→ Deep walk of the two single-fetch flows and how tiles stitch in:
`03-tile-merge-stitch.md`.

## 3. state-ownership-and-source-of-truth

| State | Owner | Where | Mutability |
|---|---|---|---|
| base coverage graph | the build artifact | `mobile/assets/graph.json` via `loadGraph.ts:7` | immutable at runtime |
| viewport / corridor regions | `useTileGraph` hook | `useState` + refs, `useTileGraph.ts:107-120` | rebuilt on pan/route |
| `userMax` (the one knob) | `MapScreen` | `useState`, `MapScreen.tsx:56` | user-controlled |
| route endpoints | `MapScreen` | coordinates, `MapScreen.tsx:59-60` | user-controlled |
| elevation samples | `elevCache` module | in-memory `Map` + AsyncStorage, `elevCache.ts` | append-only, LRU-capped |

The source of truth for *geometry and grades* is the merged graph computed in
`useTileGraph.ts:132-145` (`mergeGraphs([base, corridor, view])` then
`stitchGraph`). Notice there are **two derived graphs**: a *routing* graph that
includes degraded (flat-fallback) regions because connectivity matters more
than grade fidelity (`useTileGraph.ts:132-145`), and a *display* graph that
excludes degraded regions so fake all-green grades don't paint over real ones
(`useTileGraph.ts:150-162`). That split is a deliberate source-of-truth call.

`userMax` is the single global knob the whole product keys off — it flows into
the cost function (`cost.ts:32-33`), the route summary (`summary.ts`), and the
heatmap bands (`classify.ts:41-43`). One value, three consumers.

## 4. caching-and-invalidation

One real cache: the persistent elevation cache.

`mobile/src/elevCache.ts` keeps an in-memory `Map` keyed by ~90m DEM cell
(`useTileGraph.ts:36`, `cellKey`) and mirrors it to a single AsyncStorage key
`flattr.elevCache.v1` (`elevCache.ts:7`). Writes are debounced 4s
(`elevCache.ts:8,39`) and the store is LRU-capped at 50k entries
(`elevCache.ts:9,47-51`). It loads once on mount (`useTileGraph.ts:126-128`),
so areas fetched in a prior session have instant elevation and cost zero API
calls.

**Invalidation strategy: there isn't one, by design.** Elevation for a fixed
location is effectively constant, so entries are never invalidated — only
LRU-dropped under the 50k cap. The cache is keyed `v1` so a schema bump can
abandon the old blob.

The graph artifact itself is a build-time cache of OSM+elevation with **manual
invalidation**: you re-run `npm run build:graph` and copy the file. There is no
automatic freshness check.

→ Deep walk of the provider fallback + this cache:
`05-elevation-provider-fallback.md`.

In-pipeline (build-time) caching is `not yet exercised` — each
`npm run build:graph` re-fetches Overpass and elevation from scratch
(`pipeline/overpass.ts:21-48` has no cache layer).

## 5. storage-choice-and-durability-boundaries

The defining choice: **no datastore at all.** The "database" is a static JSON
file bundled into the app.

- **Build artifact** — `data/graph.json` (`run-build.ts:48`), copied to
  `mobile/assets/graph.json`. Durability is "it's in the git tree / app
  bundle." No write path at runtime.
- **AsyncStorage** — one key, the elevation cache (`elevCache.ts:7`). This is
  the only persistent runtime write. Durability is best-effort key-value on the
  device; a failed write just retries on the next put (`elevCache.ts:55`).

Why this works: the data is read-mostly, single-user, and small enough to
bundle. There is no multi-user write contention to mediate, so there is nothing
a relational engine would buy. Schema shape (the `Node`/`Edge` records) belongs
to **study-data-modeling**; durability internals of AsyncStorage / SQLite-style
engines belong to **study-database-systems**. Neither is exercised here beyond
the key-value cache.

## 6. failure-handling-and-reliability

This is where flattr is unusually thoughtful for a small app. Three layered
degradations:

**Elevation API down → flat fallback, not failure.**
`useTileGraph.ts:20-31` (`bestEffortElevation`) wraps any provider; on a thrown
error it returns flat (0m) elevations and flags the region `degraded = true`.
A route still builds — connectivity over fidelity.

**Degraded regions self-heal.** When a build comes back degraded, a 12s timer
(`useTileGraph.ts:71` `RETRY_MS`, lines 209-218) silently re-queues the build,
up to 6 times (`useTileGraph.ts:65` `MAX_RETRIES`). The user sees "Grades
approximate — elevation unavailable, retrying" (`MapScreen.tsx:375-376`) and
the grades fill in when the API recovers.

**"No flat route" stays distinct from "no route."** The router's `BLOCKED`
constant is **large-but-finite** (`cost.ts:5`, `1e9`), not `Infinity`. An
over-max edge gets a huge penalty but is still traversable, so a path made
entirely of too-steep edges is still *returned and flagged*
(`astar.ts:126-127` collects `steepEdges`) rather than failing as
disconnected. The card then says "⚠ Flattest available" with a steep-block
count (`RouteSummaryCard.tsx:28-36`).

**Retry/backoff on the network edges.** Overpass retries 3× with 2s spacing
(`overpass.ts:27-28`); Open-Meteo retries with exponential backoff on 429s
(`elevation.ts:108-119`). On-device Overpass failure keeps the last good region
and lets a later pan retry (`useTileGraph.ts:220`).

→ The honest-fallback routing design: `04-honest-fallback-routing.md`.
→ The elevation degradation + cache: `05-elevation-provider-fallback.md`.

Coordination across multiple writers / replicas is `not yet exercised` (single
user, single device) — that's **study-distributed-systems** territory.

## 7. scale-bottlenecks-and-evolution

flattr is single-user and offline-capable, so "scale" means *coverage area* and
*per-device work*, not concurrent traffic.

**What breaks first.** The on-device pipeline re-run is the bottleneck. Every
viewport pan past the base can trigger an Overpass fetch + elevation sampling +
`buildGraph` (`useTileGraph.ts:186-197`). The guards that hold it back:
- viewport builds only when the heatmap is on (`useTileGraph.ts:253`),
- nothing loads when zoomed out past ~2km (`useTileGraph.ts:249`,
  `MAX_LOAD_SPAN_DEG`),
- corridors wider than ~13km are refused (`useTileGraph.ts:272`,
  `MAX_CORRIDOR_SPAN_DEG`),
- ~20% viewport padding (`useTileGraph.ts:236-237`) absorbs small pans.

**At 10×** (a metro-wide route): the corridor build is one big Overpass query
and a large elevation batch; the 13km cap (`useTileGraph.ts:272`) is the wall.
Past it, the architecture would need to go back to *prebuilt tiles* served from
somewhere — which is the build-time pipeline pointed at many bboxes.

**At 100×** (many users): the bottleneck moves to the *external* APIs.
Overpass and Open-Meteo are free public endpoints with rate limits; a popular
app would hammer them. The fix is the same prebuild-and-serve move: turn the
on-device pipeline back into an offline batch and ship tiles, which is exactly
what `pipeline/` already is. The architecture is pre-shaped for that pivot —
the same code runs in both places.

**What stays stable.** The router (`astar.ts`), the cost model (`cost.ts`), and
the tile algebra (`tiles.ts`) are pure and graph-size-bound; they don't care
where the graph came from.

## 8. system-design-red-flags-audit

Ranked by real architectural risk, each grounded:

1. **On-device Overpass dependency in the interactive path.** A pan or a route
   triggers a live call to a free public OSM endpoint (`useTileGraph.ts:186`).
   If `overpass-api.de` is slow or rate-limits, coverage extension stalls. The
   try/catch keeps the last region (`useTileGraph.ts:220`), so it degrades
   rather than crashes, but the UX is "grades just don't load." Mitigation
   exists (debounce, padding, caps) but the hard dependency remains.

2. **Manual artifact invalidation.** `graph.json` is rebuilt and copied by
   hand (`loadGraph.ts:2-5` comment). There is no freshness check; the base
   coverage can silently go stale relative to OSM. Acceptable for an MVP slice,
   a real liability at coverage scale.

3. **No backpressure on concurrent builds beyond a single boolean.** The pump
   serializes builds with `busyRef` (`useTileGraph.ts:167,182`) and a 6-retry
   cap, which is enough for one device — but rapid pan + route can queue a
   corridor behind a viewport (corridor wins, `useTileGraph.ts:170`). Fine
   today; the queueing is a single-slot pending ref, not a real queue.

4. **Clamped grades hide DEM noise but also real cliffs.** Grades are clamped
   to ±40% (`pipeline/grade.ts:10,30`) to reject coarse-DEM spikes. True `riseM`
   is preserved for climb totals (`grade.ts:27`), so the honesty is partial,
   but the displayed grade is a clamped value.

None of these is a correctness bug; they are the deliberate costs of being
backend-less and free-API-fed. Each has a named mitigation already in the code.
