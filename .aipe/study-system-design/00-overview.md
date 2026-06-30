# Overview — the whole system in one map

flattr is two systems sharing one library. A **build-time pipeline** turns the
world into a graph; a **runtime app** reads that graph and routes over it. The
clever part: the runtime re-runs the same pipeline on-device whenever you pan or
route past the bundled area. There is no backend and no database — the graph
*is* the storage layer, shipped as a 544 KB JSON file inside the app bundle.

```
  flattr — full system map (build-time band + runtime band, one shared engine)

  ┌─ BUILD TIME (Node, npm run build:graph) ───────────────────────────────────┐
  │                                                                            │
  │  config.BBOX ─► overpass.ts ─► osm.ts ─► split.ts ─► elevation.ts          │
  │  (Capitol Hill)  fetch OSM     parse    densify     sample DEM             │
  │                  ways          ways     ≤12m segs   (Google│Open-Meteo│flat)│
  │                                              │                            │
  │                                              ▼                            │
  │                          grade.ts ─► build-graph.ts ─► run-build.ts        │
  │                          signed %     assemble Graph    JSON.stringify     │
  │                                                              │            │
  └──────────────────────────────────────────────────────────────┼────────────┘
                                                                 │ writes
                                              data/graph.json ───┘  (then copied to
                                                     │               mobile/assets/)
   ════════════════════ ARTIFACT BOUNDARY (static file) ════════════════════════
                                                     │ bundled
  ┌─ RUNTIME (Expo / React Native app) ───────────────▼────────────────────────┐
  │                                                                            │
  │  loadGraph.ts ──► baseGraph ──┐                                            │
  │  (read bundle)                │                                            │
  │                               ▼                                            │
  │  useTileGraph.ts:  mergeGraphs([ base, corridor?, view? ]) ─► stitchGraph  │
  │     │  pan / route past base re-runs the SAME pipeline on-device:          │
  │     │      fetchOverpass ─► buildGraph ─► prefixGraph                       │
  │     │  (elevation via cached+bestEffort Open-Meteo; elevCache.ts persists) │
  │     ▼                                                                      │
  │  MapScreen.tsx ──► directedAstar(graph, start, end, userMax)               │
  │     │                  (one parametric search engine, astar.ts)            │
  │     ▼                                                                      │
  │  RouteSummaryCard / heatmap / zones  ◄── honest status (flat / steep / none)│
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘

         THIRD-PARTY (stateless, best-effort, rate-limited):
         Overpass API · Open-Meteo / Google Elevation · Nominatim geocode
```

## Legend — what each component is, owns, and talks to

**Build-time pipeline** (`pipeline/`, Node only, runs on `npm run build:graph`)

- `config.ts` — the build's only knobs: `BBOX` (the Capitol Hill slice,
  `pipeline/config.ts:10`), `MAX_SEGMENT_M = 12`, and the `WALKABLE` OSM-tag map.
- `overpass.ts` — fetches raw OSM `highway` ways for the bbox; POST + retry on
  429/502/503/504 (`pipeline/overpass.ts:21`).
- `osm.ts` / `split.ts` — parse ways, densify so no segment exceeds the limit,
  snap shared vertices to one node id (`pipeline/split.ts:8`).
- `elevation.ts` — the `ElevationProvider` interface and three adapters
  (Google / Open-Meteo / fixture-flat); dedups samples to a ~90m grid
  (`pipeline/elevation.ts:7`, `:22`).
- `grade.ts` — fills `lengthM`/`riseM`/`gradePct`/`absGradePct` per edge; clamps
  physically-impossible grades from coarse-DEM noise (`pipeline/grade.ts:11`).
- `build-graph.ts` — orchestrates the stages into a `Graph`; **deliberately
  imports no `node:fs`** so it bundles for the app (`pipeline/build-graph.ts:2`).
- `run-build.ts` — the CLI: picks the elevation provider from env, fetches, builds,
  `JSON.stringify` to `data/graph.json` (`pipeline/run-build.ts:40`).

**The artifact** (the storage layer)

- `data/graph.json` → copied to `mobile/assets/graph.json` (544 KB) — the entire
  persisted state of the system. Owns: the base Capitol Hill graph. Talks to: the
  app via `loadGraph.ts`.

**Shared engine** (`features/`, `lib/` — used by *both* bands)

- `features/routing/graph.ts` — adjacency, `otherEnd`, `directedGrade`.
- `features/routing/astar.ts` — one parametric `search()`; `directedAstar` is the
  production wrapper (`features/routing/astar.ts:22`).
- `features/routing/cost.ts` — the signed grade penalty + `BLOCKED = 1e9`
  (large-finite, not Infinity — the load-bearing honesty choice, `cost.ts:5`).
- `features/map/tiles.ts` — `prefixGraph` / `mergeGraphs` / `stitchGraph`, the
  glue that makes independently-built regions one routable graph.

**Runtime app** (`mobile/src/`, Expo / React Native)

- `loadGraph.ts` — reads the bundled `graph.json`.
- `useTileGraph.ts` — the on-device coverage engine: viewport + route-corridor
  single-flight builds, debounce, merge/stitch, self-heal retries
  (`mobile/src/useTileGraph.ts:96`).
- `elevCache.ts` — AsyncStorage-backed elevation cache; revisited areas cost zero
  requests (`mobile/src/elevCache.ts:1`).
- `MapScreen.tsx` — the UI: tap-to-route, grade slider (`userMax`), heatmap/zones
  toggle, honest status card.
- `RouteSummaryCard.tsx` — three honest states: flat / flattest-but-steep / no
  route (`mobile/src/RouteSummaryCard.tsx`).

**Third-party** (stateless, best-effort, rate-limited): Overpass (OSM), Open-Meteo
or Google (elevation), Nominatim (geocode). None hold flattr state; all can fail
and the system degrades rather than breaks.

## The one sentence

> The build pipeline and the runtime share one engine across an artifact boundary,
> and that same pipeline runs again on the phone for anything the bundled artifact
> doesn't cover — so the architecture has exactly one way to turn the world into a
> routable graph, used at two different lifecycles.
</content>
