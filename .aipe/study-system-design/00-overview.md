# System Design — Overview

flattr is a grade-aware router for self-powered travel — "optimized for flat,
not fast." The defining architectural decision is a **build-time / runtime
split**: a Node pipeline turns OpenStreetMap geometry plus elevation samples
into a static `graph.json` artifact, and an Expo / React Native app reads that
artifact and routes over it with **no backend and no database**. The same
TypeScript engine (`features/`, `pipeline/`, `lib/`) runs in both places —
build-time on a laptop, and again *on-device* when the user pans past the
prebuilt coverage.

The whole system in one frame:

```
  flattr — the whole system, build-time and runtime

  ┌─ BUILD TIME (laptop, Node via tsx) ──────────────────────────────────┐
  │                                                                       │
  │  Overpass API ──► osm.ts ──► split.ts ──► elevation.ts ──► grade.ts   │
  │  (OSM streets)    parse      densify+     sample DEM       signed %    │
  │                              snap @12m    (3 providers)    per edge    │
  │                                  │                                     │
  │                                  ▼                                     │
  │                         build-graph.ts ──► run-build.ts                │
  │                         (assemble +        (writes data/graph.json)    │
  │                          buildAdjacency)            │                  │
  └────────────────────────────────────────────────────┼─────────────────┘
                                                         │ copied to
                                                         ▼ mobile/assets/graph.json
  ┌─ RUNTIME (device, Expo RN, NO backend / NO DB) ──────────────────────┐
  │                                                                       │
  │  loadGraph.ts ──► baseGraph (static, Capitol Hill slice)              │
  │       │                                                               │
  │       │   pan past base?  route past base?                           │
  │       ▼          │              │                                     │
  │  useTileGraph.ts ◄─────────────┘                                     │
  │   RE-RUNS THE SAME PIPELINE on-device for the viewport / corridor    │
  │   (fetchOverpass → openMeteoProvider → buildGraph → prefix → stitch) │
  │       │                                                               │
  │       ▼                                                               │
  │  mergeGraphs(base, corridor, view) ──► directedAstar(userMax) ──► UI │
  │       │                                  (features/routing/astar.ts)  │
  │       ▼                                                               │
  │  elevCache.ts (AsyncStorage) — survives restarts, kills re-fetches   │
  └───────────────────────────────────────────────────────────────────── ┘

  external deps: Overpass (overpass-api.de), Open-Meteo / Google elevation,
                 Nominatim (geocode). All best-effort, all degradable.
```

## Legend — what each component is, owns, and talks to

| Component | What it is | Owns | Talks to |
|---|---|---|---|
| `pipeline/run-build.ts` | build-time entrypoint (`npm run build:graph`) | the build sequence + serialization to `data/graph.json` | Overpass, elevation providers, `build-graph.ts` |
| `pipeline/build-graph.ts` | the assembly orchestrator | the stage order parse→split→sample→grade→adjacency | `osm`, `split`, `elevation`, `grade`, `features/routing/graph` |
| `pipeline/elevation.ts` | `ElevationProvider` interface + 3 impls | the elevation-sampling contract, batching, dedupe | Google / Open-Meteo HTTP APIs |
| `data/graph.json` → `mobile/assets/graph.json` | the static build artifact | the base coverage (one Capitol Hill bbox) | nobody — it is read-only data |
| `mobile/src/loadGraph.ts` | the static-import loader | turning the bundled JSON into a `Graph` | nobody (synchronous import) |
| `mobile/src/useTileGraph.ts` | the on-device pipeline re-run | viewport + corridor coverage beyond the base | `fetchOverpass`, `openMeteoProvider`, `buildGraph`, `tiles.ts`, `elevCache` |
| `mobile/src/elevCache.ts` | persistent elevation cache | the `cell→meters` map, debounced AsyncStorage writes | AsyncStorage |
| `features/routing/astar.ts` | the router | A* / Dijkstra / directed-grade search | `cost.ts`, `pqueue.ts`, `graph.ts` |
| `features/routing/cost.ts` | the cost model | the signed directed-grade penalty + `BLOCKED` | `graph.ts` |
| `features/map/tiles.ts` | the tile algebra | `prefixGraph` / `mergeGraphs` / `stitchGraph` | nobody (pure functions) |
| `mobile/scripts/sync-engine.mjs` | the build-time copy step | mirroring `features/`+`lib/`+`pipeline/` into `mobile/.engine/` | filesystem |

## How to read this guide

Start with `audit.md` — it walks all 8 system-design lenses and tells you,
honestly, what flattr exercises and what it does not. Then read the five
pattern files in order; each is a deep dive into one architectural decision
that carries real weight. See `README.md` for the reading order and
cross-links to neighboring guides.
