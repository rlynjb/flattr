# flattr — the whole system in one frame

*One-page orientation. The map you return to.*

flattr answers one question — "give me a route that avoids what *I* can't
comfortably climb, and show me where the flat is" — and the entire architecture
bends around one design decision: **do the heavy graph work once, offline, and
ship a static artifact the app only reads.** That's the build-time/runtime
split, and it's the thing to understand before anything else.

Here's the system end to end. Two phases, one artifact between them, and — the
finding that surprises everyone — a *third* path where the runtime quietly
re-runs the build pipeline on the phone.

```
  flattr — full system map (as built, 2026-06)

  ┌─ BUILD TIME · offline Node/tsx · run rarely ──────────────────────────┐
  │                                                                        │
  │  Overpass API ──► overpass.ts ──► osm.ts ──► split.ts ──► elevation.ts │
  │  (OSM streets)    fetch+retry    parse      densify+      Open-Meteo/  │
  │                                  walkable   snap nodes    Google DEM   │
  │                                  ways        │                │        │
  │                                              ▼                ▼        │
  │                                      build-graph.ts ──► grade.ts       │
  │                                      (orchestrate)      rise/length/   │
  │                                              │          signed grade%  │
  │                                              ▼                         │
  │                                   data/graph.json  (544 KB)            │
  │                              run-build.ts · `npm run build:graph`      │
  └───────────────────────────────────┬────────────────────────────────────┘
                                       │  copy artifact into the app bundle
                                       ▼
  ┌─ THE ARTIFACT · immutable, no DB, no server ─────────────────────────┐
  │   mobile/assets/graph.json   { city, bbox, nodes, edges, adjacency } │
  └───────────────────────────────────┬───────────────────────────────────┘
                                       │  import at startup
                                       ▼
  ┌─ RUN TIME · Expo RN · on the phone ──────────────────────────────────┐
  │                                                                       │
  │  loadGraph.ts ──► baseGraph (prefix "base")                           │
  │        │                                                              │
  │        ▼                                                              │
  │  useTileGraph.ts ── stitch(merge[base, corridor?, view?]) ──► graph   │
  │        │                          ▲                                   │
  │        │                          │  ★ THE LEAK ★                      │
  │        │              on pan / on route, the runtime RE-RUNS          │
  │        │              the SAME pipeline (overpass→build-graph→         │
  │        │              elevation) for the viewport / corridor bbox     │
  │        ▼                                                              │
  │  MapScreen.tsx                                                        │
  │    ├─ graphToGeoJSON ──► MapLibre heatmap (color by absGradePct)      │
  │    ├─ tap/geocode ──► startPt/endPt ──► nearestNode ──► startId/endId │
  │    └─ directedAstar(graph, startId, endId, userMax) ──► route line    │
  │         (A* + signed-grade cost + haversine heuristic, ALL on-device) │
  └───────────────────────────────────────────────────────────────────────┘

  External deps (all free-tier, all over HTTP, all from BOTH phases now):
    Overpass (streets) · Open-Meteo (elevation) · Nominatim (geocode)
    OpenFreeMap (basemap tiles, runtime only)
```

## Legend — what each component is, owns, and talks to

| Component | What it is | Owns | Talks to |
|---|---|---|---|
| `pipeline/overpass.ts` | Overpass QL query + fetch | bbox → raw OSM JSON; retry on 429/5xx | Overpass API |
| `pipeline/osm.ts` | OSM parser | walkable-way filtering (`WALKABLE`), coord resolution | — |
| `pipeline/split.ts` | mesh construction | densify long edges to ≤`maxSegM`, snap coincident vertices to shared node ids | — |
| `pipeline/elevation.ts` | pluggable elevation sampler | `ElevationProvider` interface; Open-Meteo / Google / fixture adapters; cell-dedup | Open-Meteo / Google |
| `pipeline/grade.ts` | grade computer | signed `gradePct`, `riseM`, `lengthM`, clamp coarse-DEM noise | — |
| `pipeline/build-graph.ts` | pipeline orchestrator | the stage DAG; **no `node:fs`** so it bundles for the phone | the four stages above |
| `pipeline/run-build.ts` | build-time CLI | pick elevation source, write `data/graph.json` | `build-graph`, `node:fs` |
| `data/graph.json` → `mobile/assets/graph.json` | the artifact | the single source of truth; immutable at runtime | imported by `loadGraph` |
| `mobile/src/loadGraph.ts` | artifact loader | typed import of the bundled graph | — |
| `mobile/src/useTileGraph.ts` | runtime coverage | viewport + corridor expansion; **re-runs the pipeline on-device**; merge/stitch; one-build-at-a-time pump | `pipeline/*`, `features/map/tiles` |
| `features/map/tiles.ts` | graph composition | `prefixGraph` (id namespacing), `mergeGraphs` (union), `stitchGraph` (seam connectors) | — |
| `features/routing/astar.ts` | the search engine | one parametric `search()`; Dijkstra→A\*→grade→directional as `(cost, heuristic)` choices | `pqueue`, `cost`, `graph` |
| `features/routing/cost.ts` | the domain cost | signed directed-grade penalty; `BLOCKED` as large-finite | `graph.directedGrade` |
| `features/routing/pqueue.ts` | priority queue | hand-rolled lazy-deletion binary min-heap | — |
| `mobile/src/MapScreen.tsx` | the runtime composition point | React state, endpoints-as-coords, render orchestration | everything above |

## The three things to take away

1. **The split is the architecture.** Build once, read forever. No live DB, no
   server state, no per-request compute on a backend — because there is no
   backend. The `Graph` object is the entire contract between the two phases.
   → `01-build-time-runtime-split.md`

2. **The split leaks at runtime — on purpose.** To cover more than the bundled
   bbox, `useTileGraph.ts` imports `pipeline/build-graph` and runs the *whole
   offline pipeline on the phone* for the panned viewport and the route
   corridor. The "thin runtime that only reads" is, as built, a runtime that can
   also *build*. → `03-on-device-pipeline.md`

3. **It's scoped to one small bbox today, honestly.** `BBOX` in
   `pipeline/config.ts` is a ~0.7 km × 0.7 km Capitol Hill slice. The spec's
   multi-city, Netlify-Blobs-served, optionally-server-side-A\* target is
   **`not yet exercised`**. The audit names every gap. → `audit.md`
