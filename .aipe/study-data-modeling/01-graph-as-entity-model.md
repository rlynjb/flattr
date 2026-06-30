# The Graph as Entity Model

**Industry name(s):** adjacency-list graph schema / node-edge data model.
**Type:** Industry standard (graph data modeling), with a project-specific
serialization (`graph.json`).

---

## Zoom out, then zoom in

You already know what a relational schema looks like — tables, primary keys,
foreign keys between them. flattr has exactly that, except the "tables" are an
object and an array living inside one JSON file, and there's no engine
enforcing the keys. Here's where the model sits.

```
  Zoom out — where the model lives

  ┌─ Build layer (pipeline/, your laptop) ─────────────────────────┐
  │  OSM ways → splitWays → sampleElevations → computeGrades       │
  │                                  │ buildAdjacency               │
  │                                  ▼                              │
  │                        ★ Graph (the model) ★ → graph.json      │ ← we are here
  └──────────────────────────────────┬─────────────────────────────┘
                                      │ bundled as a static asset
  ┌─ Storage layer ────────────────────▼────────────────────────────┐
  │  mobile/assets/graph.json   (544 KB, read-only, 1621 nodes)     │
  └──────────────────────────────────┬─────────────────────────────┘
                                      │ loadGraph()
  ┌─ Runtime layer (mobile/) ──────────▼────────────────────────────┐
  │  A* search · nearestNode · GeoJSON heatmap (all read-only)      │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: the model is a **directed-capable street graph** with two entities —
`Node` (a point with elevation) and `Edge` (a street segment between two nodes,
annotated with its grade) — plus a materialized `adjacency` index. The question
this file answers: *what is the schema as-built, and why is a graph the right
shape for it?*

---

## The structure pass

**Layers.** Three altitudes, one model passing through each:
the *type* (`features/routing/types.ts`), the *artifact* (`graph.json`), the
*in-memory object* (`loadGraph()` result).

**Axis — "who owns the schema, and is it enforced?"** Trace it down:

```
  One question down the layers: who guarantees the shape?

  ┌─ type (types.ts) ──────────────┐  TypeScript — compile-time only
  └────────────────┬───────────────┘
  ┌─ artifact (graph.json) ────────┐  nobody — plain JSON, no schema tag
  └────────────────┬───────────────┘
  ┌─ in-memory (loadGraph) ────────┐  `as unknown as Graph` — a blind cast
  └────────────────────────────────┘

  the guarantee EVAPORATES as you descend — that's the seam
```

**Seam.** The load-bearing boundary is `loadGraph()` (`mobile/src/loadGraph.ts`):
above it, TypeScript believes the shape; below it, raw JSON. The type contract
flips from "checked" to "assumed" right there. Integrity lives at that seam —
and today nothing guards it (that's file `04`). This file maps the model; `04`
walks the unguarded seam.

---

## How it works

### Move 1 — the mental model

A node-edge graph is the same shape as a normalized two-table relational
schema you've built before: one table of things (`Node`), one table of
relationships-with-attributes (`Edge`), and foreign keys joining them. The only
twist is the join direction — a *street* edge carries data (length, grade,
geometry), so it's a first-class entity, not a pure join row.

```
  The entity model — two entities, FK-shaped relations

         fromNode (FK)
   ┌──────────┐◄───────────────┌──────────────────────┐
   │  Node    │                │  Edge                │
   │  id  PK  │                │  id  PK              │
   │  lat     │   toNode (FK)  │  fromNode  → Node.id │
   │  lng     │◄───────────────│  toNode    → Node.id │
   │ elevation│                │  geometry, lengthM,  │
   └──────────┘                │  riseM, gradePct,    │
        ▲                      │  absGradePct, kind?  │
        │ keyed by id          └──────────────────────┘
   nodes: Record<id, Node>     edges: Edge[]  (flat array)
```

### Move 2 — the walkthrough

**The `Node` entity — a keyed point.** This is your "things" table.

```ts
// features/routing/types.ts:1-6
export type Node = {
  id: string;        // primary key — stable across the artifact
  lat: number;
  lng: number;
  elevationM: number; // sampled from the DEM at build time
};
```

Nodes live in `nodes: Record<string, Node>` (`types.ts:24`). That `Record` is a
**hash index on `id`** — `graph.nodes[goalId]` is O(1) (`astar.ts:39`). Drop
the keying and make it an array, and every node lookup becomes a scan; the
`Record` is the one place the model gives you free indexing.

```
  Node access — the Record IS a hash index

  graph.nodes  ─── "n0" ──► {id:"n0", lat:47.62…, lng:-122.32…, elev:53}
               ─── "n1" ──► {…}            O(1) by id
               ─── "n2" ──► {…}
```

**The `Edge` entity — a relationship that carries data.** This is where flattr
diverges from a plain join table: an edge isn't just `(from, to)`, it's a
street segment with a shape and a grade.

```ts
// features/routing/types.ts:10-20
export type Edge = {
  id: string;                  // primary key
  fromNode: string;            // FK → Node.id  (the "from" endpoint)
  toNode: string;              // FK → Node.id  (the "to" endpoint)
  geometry: [number, number][];// [lat,lng] polyline — the drawn shape
  lengthM: number;             // real distance along the polyline
  riseM: number;               // signed elevation delta, from → to
  gradePct: number;            // signed grade %, from → to
  absGradePct: number;         // |gradePct| — derived, stored (see 02)
  kind?: EdgeKind;             // sidewalk | footway | residential | path | crossing
};
```

Two things to notice. First, **the FKs are strings naming `Node.id`** — that's
the relation, and nothing checks it resolves (file `04`). Second, **the grade is
signed by direction** (`from → to`): `gradePct` is positive uphill that way,
negative downhill. The routing code re-signs it per travel direction with
`directedGrade` (`graph.ts:17-19`) — the edge stores one canonical direction,
the query flips the sign. That's a modeling choice: store once (forward),
derive the reverse, instead of storing both directions.

```
  Edge stores ONE direction; the query derives the other

  edge:  fromNode = A,  toNode = B,  gradePct = +8   (A→B is 8% up)

  directedGrade(edge, A) = +8     ← traveling A→B: uphill
  directedGrade(edge, B) = −8     ← traveling B→A: downhill
                                    (graph.ts:17-19)
```

**The `Graph` container — entities plus a materialized index.**

```ts
// features/routing/types.ts:22-28
export type Graph = {
  city: string;                          // "seattle-mvp" in the shipped artifact
  bbox: [number, number, number, number];// minLng, minLat, maxLng, maxLat
  nodes: Record<string, Node>;           // keyed entity store
  edges: Edge[];                         // flat entity array (no key index)
  adjacency: Record<string, string[]>;   // nodeId → incident edgeIds (the index)
};
```

`adjacency` is the materialized inverse of the FK relation — for each node, the
list of edges touching it. It's built by `buildAdjacency` (`graph.ts:22-29`),
which walks every edge once and pushes its id into both endpoints' lists. That's
what makes A*'s neighbor expansion O(1) instead of an O(E) scan — covered in
depth in `02` (why it's denormalized) and `03` (why it's the right index).

```
  buildAdjacency — materialize the inverse relation once

  edges:  e0(A→B)  e1(B→C)  e2(A→C)
                       │
                       ▼  graph.ts:22-29
  adjacency:  A → [e0, e2]
              B → [e0, e1]
              C → [e1, e2]
  now "edges touching A" is O(1), not a scan of all edges
```

**The artifact — one file, the whole model.** The shipped `graph.json`
(`mobile/assets/graph.json`) is this exact shape serialized:
`{"city":"seattle-mvp","bbox":[...],"nodes":{"n0":{...}},"edges":[...],
"adjacency":{...}}`. 1621 nodes, 1879 edges, adjacency over all 1621 nodes.
`loadGraph()` reads it whole and casts (`loadGraph.ts:9-11`).

### Move 3 — the principle

Model the data as the shape you traverse. flattr's access pattern is graph
traversal, so the persisted form is a graph — entities for the nouns, an edge
type for the data-carrying relationship, and a materialized index for the one
lookup the hot path needs. The relational-vs-graph question isn't religious;
it's "does the stored shape match the read shape." Here it does.

---

## Primary diagram

The full model, all three relations, the derived field marked.

```
  flattr data model — entities, relations, the materialized index

  ┌─ Graph (graph.json — city "seattle-mvp", bbox) ────────────────┐
  │                                                                │
  │  nodes: Record<id,Node>            edges: Edge[]               │
  │  ┌─────────────┐   fromNode (FK)   ┌────────────────────────┐  │
  │  │ Node        │◄──────────────────│ Edge                   │  │
  │  │  id (PK)    │   toNode  (FK)    │  id (PK)               │  │
  │  │  lat,lng    │◄──────────────────│  fromNode, toNode      │  │
  │  │  elevationM │                   │  geometry (polyline)   │  │
  │  └─────────────┘                   │  lengthM, riseM        │  │
  │        ▲                           │  gradePct (signed)     │  │
  │        │ keyed (hash index)        │  absGradePct =|grade|  │──┼─ derived,
  │        │                           │  kind?                 │  │  stored (02)
  │  adjacency: Record<nodeId,         └────────────────────────┘  │
  │    edgeId[]>  ─── materialized inverse of fromNode/toNode ──────┼─ index (03)
  └────────────────────────────────────────────────────────────────┘
       built by pipeline/build-graph.ts, read by mobile/loadGraph.ts
```

---

## Elaborate

The node-edge-with-attributes model is the standard shape for routing graphs
(OSRM, Valhalla, GraphHopper all use it internally) — flattr hand-rolls it
because the grade-annotation *is* the product (`docs/flattr-spec.md` §14: no
external router). The choice to store grade signed in one canonical direction,
then derive the reverse at query time, is the same move a DB makes when it
stores a value once and computes its inverse on read rather than storing both.

What to read next: `02` (which fields are derived vs primitive, and why
`adjacency` and `absGradePct` are stored anyway), then `03` (how `adjacency`
serves the hot query and which queries have no index).

---

## Interview defense

**Q: Why a graph blob and not a relational schema with `nodes` and `edges`
tables?**
The access pattern is read-only whole-graph traversal — load once, run A* over
everything, never write back. A relational store adds query latency, connection
setup, and a server, and buys nothing for an access shape that wants the entire
object in memory at once. The shipped artifact is 544 KB; it fits in memory
trivially.

```
  Access shape decides storage shape

  whole-graph traversal, read-only ──► static JSON blob (zero query latency)
  row-at-a-time, concurrent writes ──► relational DB
  flattr is the first one.
```
Anchor: "the storage shape matches the access shape — whole-graph read wants a
whole-graph blob."

**Q: Is `Edge` a join table or an entity?**
An entity. A pure join table is just `(from, to)`; flattr's edge carries
`geometry`, `lengthM`, `riseM`, `gradePct` — the relationship has attributes,
so it's first-class. That's why `edges` is its own array with its own primary
key, not an embedded list on `Node`.

```
  ┌ Node ┐  ──edge carries data──►  ┌ Edge ┐ ── ►  ┌ Node ┐
  not a bare (from,to): geometry+grade live ON the edge
```
Anchor: "the edge carries its own attributes — it's an entity, not a join row."

---

## See also

- `02-derived-and-denormalized-fields.md` — `absGradePct` and `adjacency` as stored derivations
- `03-indexes-vs-query-patterns.md` — `adjacency` as the index; the queries with none
- `04-integrity-without-a-database.md` — the unguarded `loadGraph` seam named here
- `study-dsa-foundations` — the adjacency list as an algorithms primitive
- `study-software-design` — single source of truth (the normalization principle)
