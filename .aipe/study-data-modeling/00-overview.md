# Overview — flattr's data model in one page

One entity, one artifact, zero databases. flattr persists a single thing: a
grade-annotated street graph, built once at compile-time and shipped as
`mobile/assets/graph.json` (544 KB, 1621 nodes, 1879 edges). The app reads it
whole into memory and never writes it back. So the data-modeling questions
here aren't about tables and joins — they're about how this one graph is
*shaped*, what's *derived vs stored*, what *index* makes the hot query fast,
and what *integrity* (none, currently) protects it.

```
  Where the data model sits in the system

  ┌─ Build time (pipeline/, runs on your laptop) ──────────────────┐
  │  OSM → split → elevation → computeGrades → buildAdjacency      │
  │                                    │  writes                    │
  │                                    ▼                            │
  │                            graph.json (the artifact)            │ ★ the model
  └────────────────────────────────────┬───────────────────────────┘
                                        │  bundled into the app
  ┌─ Runtime (mobile/, Expo RN) ────────▼───────────────────────────┐
  │  loadGraph() → cast to Graph → A* / nearestNode / GeoJSON      │  read-only
  │  (useTileGraph fetches MORE regions, merges them — see          │
  │   study-system-design; the SHAPE of what it merges is here)     │
  └─────────────────────────────────────────────────────────────────┘
```

## The model, named

| Entity | Identity | Fields | Relations |
|--------|----------|--------|-----------|
| `Node` | `id` (string PK) | `lat`, `lng`, `elevationM` | referenced by `Edge.fromNode`/`toNode` and by `adjacency` keys |
| `Edge` | `id` (string PK) | `geometry`, `lengthM`, `riseM`, `gradePct`, `absGradePct`, `kind?` | `fromNode`, `toNode` (FK→`Node.id`); listed in `adjacency` values |
| `adjacency` | — (materialized index) | `Record<nodeId, edgeId[]>` | duplicates the endpoint relation for O(1) lookup |
| `Graph` | `city` | `bbox`, `nodes`, `edges`, `adjacency` | the container artifact |

Canonical schema: `features/routing/types.ts:1-28`. Spec: `docs/flattr-spec.md` §4.

## The five findings, ranked worst-first

1. **No referential integrity, no schema version, blind cast** (`04`). A
   `graph.json` with a dangling `edge.fromNode` doesn't fail at load — it
   crashes mid-A* with a confusing error. `loadGraph()` is
   `graph as unknown as Graph` (`mobile/src/loadGraph.ts:10`). No `version`
   field anywhere, so a shape change silently mis-reads.

2. **`nearestNode` is an O(N) full scan** (`03`). Every tap-to-route snaps a
   coordinate by scanning all 1621 nodes (`nearest.ts:8`). No spatial index
   (grid / k-d tree). The one query that *isn't* served by an index.

3. **`edgeById` is an O(E) linear find, called per path edge** (`03`). The
   read path (`summary.ts`, `geojson.ts`) resolves each route edge with
   `graph.edges.find(...)` — an N+1-shaped pattern. A* already solved this
   internally with `indexEdges()` (`astar.ts:12`); the read path didn't reuse it.

4. **`absGradePct` is derived but stored** (`02`). It's exactly
   `Math.abs(gradePct)` (`grade.ts:31`). A deliberate denormalization for the
   heatmap read path — defensible, but it's a second copy of one fact.

5. **`adjacency` denormalizes the endpoint relation** (`02`, `03`). It stores
   what's already in `edge.fromNode`/`toNode`, re-derivable by `buildAdjacency`.
   This one earns its keep: it's the index that makes A* expansion O(1).

Full lens-by-lens walk: `audit.md`.
