# 00 — Overview

One page to orient before the audit. The map, the seams, the verdict.

## The whole repo in one layer diagram

flattr splits cleanly into build-time and runtime, with a static
`graph.json` artifact as the hinge between them. The design work lives
in the routing core (bottom-left) and the mobile graph-pump (right).

```
  flattr — layers, build-time vs runtime

  ┌─ BUILD-TIME (pipeline/, run once) ───────────────────────────┐
  │  osm.ts → split.ts → elevation.ts → grade.ts → build-graph.ts│
  │  Overpass + elevation API  ──►  graph.json (static artifact) │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  graph.json (read-only)
  ┌─ RUNTIME CORE (features/, pure TS, no framework) ─────────────┐
  │                                                               │
  │  ┌─ routing ──────────────────────────────────────────────┐  │
  │  │  search()  ◄── costFn ── cost.ts (penalty)  ★SEAMS★    │  │
  │  │     │         heuristicFn                               │  │
  │  │     ▼                                                   │  │
  │  │  pqueue.ts (lazy-deletion heap)   graph.ts (directed)   │  │
  │  └─────────────────────────────────────────────────────────┘  │
  │  ┌─ grade ──────┐  ┌─ map ───────────────────────────────┐    │
  │  │ classify.ts  │  │ geojson.ts  tiles.ts                 │    │
  │  └──────────────┘  └─────────────────────────────────────┘    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  imported via sync-engine.mjs
  ┌─ MOBILE (mobile/, Expo + RN + MapLibre) ──────────────────────┐
  │  MapScreen  ◄──  useTileGraph (single-flight pump)            │
  │                  re-runs pipeline live for viewport+corridor  │
  └───────────────────────────────────────────────────────────────┘
```

The surprise in that diagram: `useTileGraph` (mobile, runtime) imports
`pipeline/` (build-time) and runs the *same build* live for the visible
area. The "build-time vs runtime" split is a default, not a wall — the
provider interface (`07`) is what lets the pipeline run in both places.

## The five seams worth studying

A seam matters when an **axis flips** across it. Here are flattr's, with
the axis that flips named:

```
  seam                          axis that flips        pattern file
  ────────────────────────────  ─────────────────────  ────────────
  search() │ costFn             "who knows about        01, 02
                                 grade?"  no → yes
  costFn │ directedGrade        "is grade a stored      03
                                 field or derived?"
  search() │ pqueue             "who decides expansion   04
                                 order?"  graph → heap
  cost.ts BLOCKED │ Infinity    "is this no-flat-route   05
                                 or no-route?"
  pipeline │ ElevationProvider  "where do meters         07
                                 come from?"  real → fixture
```

## The verdict

flattr's routing core is genuinely well-designed — deep modules, one
fact in one place, clean seams. The audit finds **two real defects**,
both in the *peripheral* (non-search) code that didn't inherit the
core's discipline:

1. `edgeById` O(E) scan in a loop (`graph.ts:3`, called in `summary.ts`
   + `geojson.ts`). The fix is the `Map` that `astar.ts` already built.
2. The DEM cell-key formula duplicated across `elevation.ts:42` and
   `useTileGraph.ts:36` — one fact, two edit sites.

Everything else is praise-as-finding: the parametric search, the
penalty seam, the directed-grade derivation, and the large-finite
`BLOCKED` are all the right call. The audit names where each lives.

Start with `audit.md`.
