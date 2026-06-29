# Graph as the schema

**Industry name:** adjacency-list graph model / property graph (a node-and-edge
schema with attributes on both). **Type label:** Industry standard (the graph data
model), Project-specific in how it's serialized to a static file.

---

## Zoom out, then zoom in

flattr has no database. Where most apps put a Postgres or a SQLite, flattr puts a
544 KB JSON file — and that file *is* the entire persistence layer. Here's the whole
stack, with the data model marked:

```
  Zoom out — where the schema lives

  ┌─ UI layer (Expo / RN) ──────────────────────────────────────┐
  │  MapScreen → tap start/goal → run A* → draw route + heatmap  │
  └───────────────────────────┬──────────────────────────────────┘
                              │  in-memory Graph object
  ┌─ Data-access layer ───────▼──────────────────────────────────┐
  │  loadGraph()  ←  graph.json (bundled, read-only)             │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  produced once, offline
  ┌─ Build pipeline (build-time only) ───────────────────────────┐
  │  OSM + elevation  →  parse → split → grade → adjacency        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the thing in the middle band — the shape of `graph.json` — is what this
file is about. It's declared as a TypeScript type at `features/routing/types.ts:1-28`
and serialized verbatim to JSON. There's no ORM, no schema migration, no DDL. The
type *is* the schema, and a graph is the right schema because the domain *is* a
graph: a street network is nodes (intersections, vertices) joined by edges (road
segments). The question this answers: **what's the smallest faithful shape for a
grade-annotated street network that a hand-rolled A\* can traverse fast?**

## Structure pass

Before the mechanics, read the skeleton. Three layers, one axis traced across them.

**Layers (by altitude of the data):**

```
  Three layers of the model — outer to inner

  ┌─ Graph (the artifact) ──────────────────────┐
  │  city, bbox, + three collections             │
  └───────────────┬──────────────────────────────┘
      ┌───────────▼───────────┐  ┌──────────────────┐
      │ nodes: Record<id,Node>│  │ adjacency:        │
      │ edges: Edge[]         │  │  Record<id,id[]>  │
      └───────────┬───────────┘  └──────────────────┘
          ┌───────▼───────┐
          │ Node / Edge    │  the leaf records
          │ (the rows)     │
          └────────────────┘
```

**Axis traced — "who is the source of truth for this fact?"** Hold that one
question constant as you descend:

- At the **Graph** level: the whole object is the source of truth for "the
  network." Nothing outside it is authoritative.
- At the **collections** level: `nodes` and `edges` are *primary* — they hold the
  facts. `adjacency` is *derived* — it's a rebuilt index over `edges`, never an
  independent source (the answer flips here: edges own the relationship, adjacency
  copies it).
- At the **record** level: on an `Edge`, `gradePct` is primary (the signed measured
  fact); `absGradePct` is derived (`|gradePct|`). The answer flips again inside a
  single row.

**Seams (where the axis-answer flips):** the `edges` → `adjacency` boundary
(primary vs derived index) and the `gradePct` → `absGradePct` boundary (primary vs
derived field). Those two seams are the entire normalization story of this model —
they're the deep dive in `02`. This file establishes the skeleton they sit on.

## How it works

### Move 1 — the mental model

You already know this shape. You built it twice in reincodes: `Graph.ts` (adjacency
list) and `Graph2.ts` (node + edge, weighted, for Dijkstra). flattr's model is
`Graph2.ts` grown up and frozen to disk — node records, edge records with weights
(here the weight is grade), plus a precomputed adjacency list. If you can picture
your river-crossing BFS walking an adjacency list, you can picture this.

The literal shape of the schema:

```
  The property-graph shape

   nodes (keyed by id)              edges (array)
   ┌──────────────────┐            ┌─────────────────────────────┐
   │ n0 → {lat,lng,    │            │ e0 {from:n0, to:n1,         │
   │       elevationM} │◄───────────┤      gradePct, geometry...} │
   │ n1 → {...}        │◄───────────┤ e1 {from:n1, to:n2, ...}    │
   │ n2 → {...}        │            │ ...                         │
   └──────────────────┘            └─────────────────────────────┘
            ▲                                  │
            │      adjacency (the index)       │
            │   ┌──────────────────────────┐   │
            └───┤ n0 → [e0]                 │◄──┘  built from edges:
                │ n1 → [e0, e1]            │      each edge appended
                │ n2 → [e1, ...]           │      to BOTH endpoints
                └──────────────────────────┘
```

The strategy in one sentence: **store nodes and edges as the primary facts, then
precompute a node→edges index so traversal never scans the edge array.**

### Move 2 — the walkthrough

#### The Node record — the vertices

Reach for what you know: this is a row in a table. Primary key `id`, three
columns. Here's the real type:

```ts
// features/routing/types.ts:1-6
export type Node = {
  id: string;        // PK — also the key in the nodes map (see 02: stored twice)
  lat: number;       // latitude
  lng: number;       // longitude
  elevationM: number;// the fact that makes grade computable
};
```

`elevationM` is the load-bearing column — it's why this is a *grade-aware* router
and not just a shortest-path one. Without it, edges have no rise, and the whole
product (flat routing) collapses. It's filled in a separate pipeline stage
(`sampleElevations`, `pipeline/elevation.ts:22`) *after* the nodes exist with
`elevationM: 0` (`split.ts:53`). The boundary condition: if elevation sampling
fails (API throttled), the node keeps `0` and grades come out flat — handled as a
"degraded" region in `useTileGraph.ts`, not a crash.

#### The Edge record — the relationships, with attributes

This is the join row, but a *property* join: it carries attributes, not just two
foreign keys.

```ts
// features/routing/types.ts:10-20
export type Edge = {
  id: string;
  fromNode: string;       // FK → nodes (UNCHECKED — see 04)
  toNode: string;         // FK → nodes (UNCHECKED)
  geometry: [number, number][]; // the polyline, stored per edge
  lengthM: number;        // real distance (filled by grade.ts)
  riseM: number;          // signed elevation delta from→to
  gradePct: number;       // PRIMARY: signed grade in from→to direction
  absGradePct: number;    // DERIVED: |gradePct| (see 02)
  kind?: EdgeKind;        // optional: sidewalk/footway/residential/path/crossing
};
```

The thing to notice: `gradePct` is **signed and directional** — positive means
uphill going from→to, negative downhill. That single design decision is why the
router can charge for uphill and reward downhill (`cost.ts:32`,
`directedGrade` in `graph.ts:17`), and why `absGradePct` has to exist separately
for the direction-agnostic heatmap (`zones.ts:38`). The geometry is stored
*per edge* (not normalized into a shared point table) — denormalized for the same
reason the spec ships a static file: it's read whole, never partially.

#### The three collections — keyed map, array, index

```
  Why each collection has the container it has

  ┌─ nodes ─────────────┐  Record<id,Node>  → O(1) lookup by id
  │  the "primary key    │                     (the JSON key IS the PK)
  │  index" comes free   │
  └─────────────────────┘
  ┌─ edges ─────────────┐  Edge[]           → iterated whole (heatmap),
  │  no id index — a     │                     looked-up by id via O(E) find
  │  known cost (see 03) │                     (the model's one missing index)
  └─────────────────────┘
  ┌─ adjacency ─────────┐  Record<id,id[]>  → O(degree) expansion in A*
  │  the access index    │                     (the whole point — see 02)
  └─────────────────────┘
```

Walk it once: `nodes` gets a keyed map because the dominant lookup is "give me the
node with this id" (the heuristic, expansion, `nearestNode` all do it).
`edges` gets a plain array because the dominant access is "iterate them all" (the
heatmap zones in `zones.ts:31` walk every edge). `adjacency` exists *only* to make
A\* expansion fast — it's the index the array can't provide.

#### Where the schema gets filled — the build stages

The schema isn't born complete; it's assembled left-to-right by the pipeline.
`buildGraph` is the assembler:

```ts
// pipeline/build-graph.ts:24-29
const ways = parseOsm(osm);                                   // raw geometry
const { nodes, edges } = splitWays(ways, maxSegM);            // skeleton: grade=0
const nodesWithElev = await sampleElevations(nodes, elevation); // fill elevationM
const gradedEdges = computeGrades(nodesWithElev, edges);      // fill grade fields
return { city, bbox, nodes: nodesWithElev, edges: gradedEdges,
         adjacency: buildAdjacency(gradedEdges) };            // build the index last
```

Each stage owns one part of the schema. `split.ts` makes node/edge shells with
`elevationM: 0` and grade fields at 0. `sampleElevations` fills `elevationM`.
`computeGrades` fills `lengthM/riseM/gradePct/absGradePct`. `buildAdjacency` builds
the index *last*, after edges are final — because the index is derived, it can only
be built once its source is done. That ordering is the data-modeling discipline made
literal: **derived data is computed after primary data, never before.**

### Move 3 — the principle

The data model is the most expensive thing to get wrong, because code is cheap to
change and a schema with data in it is not. flattr sidesteps the *cost* of that
(rebuild-from-source, no live data) but still pays the *design* tax: it picked the
graph shape because the domain is a graph, made nodes/edges primary and adjacency
derived, and assembles the schema in dependency order so derived fields can never be
stale at build time. The lesson that transfers: **choose the container per access
pattern (map for keyed lookup, array for full scans, index for traversal), and let
the build order encode which facts are primary and which are derived.**

## Primary diagram

The full model in one frame — every collection, every relationship, every
primary-vs-derived seam labelled.

```
  flattr's data model — complete

  ┌─ Graph (graph.json, 544KB) ─────────────────────────────────────┐
  │  city: "seattle-mvp"   bbox: [minLng,minLat,maxLng,maxLat]       │
  │                                                                  │
  │  ┌─ nodes: Record<id,Node> ──── PRIMARY ──── PK index ─────────┐ │
  │  │  n0 {lat, lng, elevationM}   ◄── elevationM = grade source  │ │
  │  └──────────────────────────────────────────────────────────────┘ │
  │           ▲                    ▲                                  │
  │      fromNode (FK)        toNode (FK)   ── unchecked (04) ──      │
  │           │                    │                                  │
  │  ┌─ edges: Edge[] ──────────── PRIMARY ──── no id index (03) ──┐ │
  │  │  e0 {from,to, geometry, lengthM, riseM,                      │ │
  │  │      gradePct ── PRIMARY (signed),                           │ │
  │  │      absGradePct ── DERIVED = |gradePct| (02), kind?}        │ │
  │  └──────────────────────────────────────────────────────────────┘ │
  │           │ buildAdjacency (derived, built last)                  │
  │  ┌─ adjacency: Record<id, id[]> ── DERIVED ── access index (02) ┐ │
  │  │  n0 → [e0]   n1 → [e0,e1]   ...                              │ │
  │  └──────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────┘
        │  loadGraph() casts JSON → Graph (no validation — 04)
        ▼
   in-memory traversal: A* (astar.ts) · heatmap (zones.ts)
```

## Elaborate

The property-graph model (nodes + edges, attributes on both) is the same shape
behind Neo4j, the same shape behind every routing engine flattr deliberately
*doesn't* use (Valhalla, OSRM — banned by the spec because the graph work is the
point). The choice to serialize it as one denormalized JSON blob rather than a
normalized relational schema (a `points` table, an `edges` table with FKs, a
`segment_geometry` table) is the read-whole-or-nothing access pattern asserting
itself: when you never query a slice, normalization buys you only integrity, not
performance — and flattr trades that integrity away (04) for the simplicity of a
single file.

What to read next: `02` for the two normalization seams this file set up (adjacency
and absGradePct), then `03` for the index that the `edges` array doesn't have.

## Interview defense

**Q: Why a graph model and not a relational schema with a points table and an edges
table?**

The access pattern is whole-graph, read-only, in-memory traversal — A\* expands
nodes and the heatmap iterates every edge. You never query a slice. A relational
schema's payoff (indexed partial queries, FK integrity) is wasted when you `SELECT *`
on startup anyway; you'd pay serialization and join cost for data you always read in
full. A graph object you load once and traverse in memory is the shape that matches.

```
  access pattern decides the model

  query a slice, often?  ──no──► load whole, traverse ──► graph object
        │ yes                                              (flattr)
        ▼
   relational + indexes
```

Anchor: *"The model follows the access pattern — whole-graph read-only traversal, so
a single denormalized graph object beats a normalized DB."*

**Q: What's primary and what's derived in this model, and why does that matter?**

`nodes` and `edges` are primary — they hold the measured facts. `adjacency` is
derived (an index over edges, built by `buildAdjacency`), and `absGradePct` is
derived (`|gradePct|`). It matters because derived data must be computed *after*
its source and never independently edited — `buildGraph` builds adjacency last, after
edges are final, so the index can't be stale. The hazard a database would guard and
this model doesn't: nothing stops `absGradePct` from drifting out of sync with
`gradePct` if anything ever wrote one without the other.

Anchor: *"Nodes and edges are the truth; adjacency and absGradePct are derived and
built after — derived-after-primary is the whole discipline."*

## See also

- `02-adjacency-as-denormalized-index.md` — the two derived-data seams in depth.
- `03-missing-indexes-and-scans.md` — why the `edges` array has no id index.
- `04-integrity-without-a-database.md` — the unchecked FKs marked above.
- `study-dsa-foundations` — your `Graph2.ts` / `Graph.ts`; this is that shape shipped.
- `study-system-design` — static-artifact-vs-DB as an architecture call.
