# The data model and its shape

**Industry names:** grade-annotated property graph · adjacency-list graph
schema · denormalized read-model. **Type:** project-specific (the canonical
artifact for this repo).

---

## Zoom out, then zoom in

flattr has no database. It has one file — `graph.json` — and that file *is* the
data model. Here's where it sits in the whole system, so you can see what reads
it and what writes it before we crack it open.

```
  Zoom out — where the data model lives

  ┌─ Build-time pipeline (offline, run rarely) ─────────────────┐
  │  Overpass OSM  →  split  →  elevation  →  grade  →  ★GRAPH★  │
  │                                            writes graph.json │
  └───────────────────────────────┬─────────────────────────────┘
                                   │  static JSON artifact
  ┌─ Runtime (Expo app, read-only) ▼────────────────────────────┐
  │  loadGraph()  →  ★ Graph in memory ★  →  A* router          │ ← we are here
  │                       │                →  nearest-node snap   │
  │                       │                →  grade heatmap       │
  └───────────────────────┴──────────────────────────────────────┘
```

The thing in the starred box — `Graph` — is the entire persistent model.
Three entities: `Node`, `Edge`, and a derived `adjacency` index, all bundled
into one `Graph` object. The question this file answers: *what's the shape, and
why is it shaped that way and not some other way?* The verdict up front — it's a
**property graph stored as one denormalized JSON document**, with a hash index
(`adjacency`) baked in. That single choice drives everything in files 02–06.

---

## Structure pass

Before the mechanics, read the skeleton. The model has three nested layers, and
I'll trace one axis — **"who computes this value, and when?"** — down all three.
That axis is the right x-ray here because it's what separates the *source*
fields from the *derived* fields, and that split is the whole story of files
02–05.

```
  One axis — "who computes this, and when?" — down the layers

  ┌─ Layer 1: SOURCE fields (from the world) ──────────────────┐
  │  Node.lat, Node.lng          ← OSM, at build time          │
  │  Node.elevationM             ← elevation API, at build time│
  │  Edge.geometry               ← OSM polyline, at build time  │
  └────────────────────────────┬───────────────────────────────┘
                               │  derive
  ┌─ Layer 2: DERIVED fields (computed once, stored) ──────────▼┐
  │  Edge.lengthM   = haversine over geometry   (grade.ts)      │
  │  Edge.riseM     = elev(to) − elev(from)      (grade.ts)      │
  │  Edge.gradePct  = riseM / lengthM * 100      (grade.ts)      │
  │  Edge.absGradePct = |gradePct|               (grade.ts)      │
  │  adjacency      = nodeId → incident edgeIds  (graph.ts)      │
  └────────────────────────────┬───────────────────────────────┘
                               │  read (never recomputed at runtime)
  ┌─ Layer 3: RUNTIME reads (the app, read-only) ──────────────▼┐
  │  directedGrade(edge, from)  ← the ONE value derived live    │
  └──────────────────────────────────────────────────────────────┘
```

**Axis answer flips twice — those are the seams.**

- **Seam 1 (source → derived):** between Layer 1 and Layer 2, the answer flips
  from "the world computes it" to "the build pipeline computes it." Everything
  below this seam is a denormalization decision (file 02): it could be derived
  on read, but it's precomputed and stored.
- **Seam 2 (build → runtime):** between Layer 2 and Layer 3, the answer flips
  from "computed once at build" to "computed live per traversal." Exactly **one**
  value lives below this seam: `directedGrade`. Everything else is frozen into
  the artifact. That single live derivation is the spec's open-decision F call
  (one undirected edge, direction derived at traversal — not two stored directed
  edges), and it's the most load-bearing modeling choice in the repo.

Hold that picture. Files 02–05 each walk one consequence of those two seams.

---

## How it works

### Move 1 — the mental model

You already know the shape, even if you've never seen this repo. It's the
adjacency-list graph you built in `Graph2.ts` for Dijkstra: nodes in a map,
edges carrying weights, and a `nodeId → edges` lookup so you can ask "what's
next to me?" without scanning everything. flattr is that, plus each edge carries
its *grade* (signed steepness) instead of a plain weight.

```
  The pattern — a property graph: entities + a derived index

         nodes (map, keyed by id)        adjacency (derived index)
        ┌──────────────────────┐        ┌────────────────────────┐
        │ n0 → {lat,lng,elev}  │        │ n0 → [e0, e3]          │
        │ n1 → {lat,lng,elev}  │        │ n1 → [e0, e1]          │
        │ n2 → {lat,lng,elev}  │        │ n2 → [e1, e2]          │
        └──────────────────────┘        └────────────────────────┘
                                                  │
        edges (flat array)                        │ each edgeId resolves
        ┌────────────────────────────────┐       │ back into…
        │ e0 {from:n0, to:n1, grade:+3.2} │◄──────┘
        │ e1 {from:n1, to:n2, grade:−5.1} │
        └────────────────────────────────┘
```

The shape is three collections that point at each other: `nodes` keyed by id
(the primary-key map), `edges` as a flat list, and `adjacency` mapping each node
to the edges touching it. The "property" part is that edges carry domain data
(grade, length, rise) — they're not bare connections.

### Move 2 — the parts, one at a time

#### The Node — a vertex with a position and an elevation

A `Node` is the smallest thing: an `id`, a `lat`/`lng` position, and an
`elevationM`. That's it. The id is the primary key — it's how `adjacency` and
every `Edge` refer back to a node. Drop the id and the whole reference graph
collapses; there's nothing to point at.

```
  Node — the keyed vertex

  ┌─ Node ──────────────┐
  │ id: "n0"   ◄── PK   │
  │ lat: 47.6231        │  position (source)
  │ lng: -122.3278      │
  │ elevationM: 53      │  ← the field everything grade-related derives from
  └─────────────────────┘
```

The boundary condition: `elevationM` is the *only* reason grades exist. If
elevation is wrong (coarse DEM, file 02's accuracy crux), every derived grade
downstream is wrong. The node is where truth enters the system.

#### The Edge — an undirected segment carrying signed grade

An `Edge` is the heavy entity. It has two foreign-key-like references —
`fromNode` and `toNode`, both node ids — plus its own geometry and the four
derived grade fields. The critical modeling choice lives here: the edge is
stored **once, undirected**, with a `gradePct` signed in the `from → to`
direction. The reverse direction isn't a second row — it's `directedGrade`
negating the sign at traversal time.

```
  Edge — one undirected row, direction derived

         e0: fromNode=n0, toNode=n1, gradePct=+3.2
                 │
       ┌─────────┴──────────┐
       │  traverse n0 → n1   │  directedGrade = +3.2  (climbing)
       │  traverse n1 → n0   │  directedGrade = −3.2  (descending)
       └─────────────────────┘
              one row, two readings — NOT two rows
```

Why this matters: the alternative (open-decision F option 2) is to materialize
two directed edges per segment — explicit, simpler A* loop, ~2× the artifact
size. flattr picked DRY: one edge, sign flipped on read. The cost is that the A*
loop must know which end it entered from to read the grade correctly. The
boundary condition: forget to negate on reverse traversal and your router thinks
every descent is a climb — it'll route you the long way around to avoid a free
downhill.

#### The adjacency index — the derived neighbor lookup

`adjacency` is a `Record<nodeId, edgeId[]>`: for each node, the list of edge ids
that touch it. It is **100% derivable from `edges`** — you could rebuild it by
scanning every edge and bucketing by endpoint. It's stored anyway, because the
hot query ("neighbors of node X") would otherwise be an O(E) scan per
expansion. That's the denormalization-for-speed call file 03 walks.

```
  adjacency — derived from edges, stored for O(1) lookup

  edges:  e0{n0,n1}  e1{n1,n2}  e2{n2,n3}
            │  │       │  │       │  │
            ▼  ▼       ▼  ▼       ▼  ▼
  adjacency: n0→[e0]  n1→[e0,e1]  n2→[e1,e2]  n3→[e2]
             └─ build once, read millions of times in A* ─┘
```

#### The Graph wrapper — the artifact envelope

`Graph` bundles all three plus `city` and `bbox`. The `bbox` isn't decoration —
the grade heatmap (`zones.ts`) tiles it into a grid, and the runtime uses it to
decide what's already loaded. What's *missing* from the envelope is the thing
file 05 is about: there's no `schemaVersion`. The artifact can't say which shape
it was written in.

### Move 3 — the principle

A data model is the contract between who *writes* the data and who *reads* it.
flattr collapses that contract into one TypeScript type and one JSON file, which
makes every modeling decision unusually legible — the source/derived seam, the
one-undirected-edge call, the missing version field are all right there in 28
lines of `types.ts`. The general lesson: when your "schema" is a type and your
"rows" are a file, you don't get to skip data modeling — you just get to *see*
all of it at once, and the discipline of normalization, indexing, and
versioning applies exactly as it would to Postgres tables.

---

## Primary diagram

The full model, every entity, every reference, every derived field, in one
frame — the picture to return to.

```
  flattr's complete data model (features/routing/types.ts:1–28)

  ┌─ Graph (the artifact envelope) ───────────────────────────────────┐
  │  city: "seattle-mvp"                                               │
  │  bbox: [minLng, minLat, maxLng, maxLat]  ← drives heatmap + load   │
  │  ── NO schemaVersion field ──  (file 05)                           │
  │                                                                    │
  │  nodes ──────────────┐   edges ──────────┐   adjacency ───────┐    │
  │  Record<id,Node>     │   Edge[]          │   Record<id,id[]>  │    │
  │  (PK map)            │   (flat array)    │   (DERIVED index)  │    │
  └──────────┬───────────┴────────┬──────────┴─────────┬──────────┴────┘
             │                    │                    │
             ▼                    ▼                    ▼
  ┌─ Node ──────────┐  ┌─ Edge ──────────────────┐  adjacency[n1]
  │ id      (PK)    │  │ id        (PK)          │  = [e0, e1]
  │ lat,lng (src)   │  │ fromNode ──FK──► Node.id │      │
  │ elevationM(src) │◄─┤ toNode   ──FK──► Node.id │◄─────┘ resolves to
  └─────────────────┘  │ geometry  (src polyline) │        edge ids
        ▲              │ lengthM   (derived)      │
        │              │ riseM     (derived)      │
        │ elevation    │ gradePct  (derived,signed)│  one row;
        │ is the truth │ absGradePct(derived,|·|) │  directedGrade()
        │ source       │ kind?                    │  negates on reverse
        └──────────────│  ── reverse = sign flip ─┤  (the ONE live derive)
                       └──────────────────────────┘
```

---

## Implementation in codebase

### Use cases

- **Every routing request** loads this model via `mobile/src/loadGraph.ts` and
  walks `adjacency` + `edges` in A*.
- **Every grade heatmap render** reads `edges[*].absGradePct` and `bbox`
  through `features/grade/zones.ts`.
- **The build pipeline** materializes the whole thing once
  (`pipeline/build-graph.ts`) and serializes it to disk.

### Code, line by line

The schema itself — the canonical type that every other file imports.

```
  features/routing/types.ts (lines 1–28)

  export type Node = {
    id: string;          ← PK; adjacency keys + edge FKs point here
    lat: number;         ← source (OSM)
    lng: number;
    elevationM: number;  ← source (elevation API); grade's only input
  };

  export type Edge = {
    id: string;          ← PK
    fromNode: string;    ← FK → Node.id  (no DB to enforce it; file 04)
    toNode: string;      ← FK → Node.id
    geometry: [number, number][];  ← source polyline [lat,lng]
    lengthM: number;     ← DERIVED (grade.ts)  ┐
    riseM: number;       ← DERIVED, signed      │ all four precomputed
    gradePct: number;    ← DERIVED, signed      │ at build, stored
    absGradePct: number; ← DERIVED, |gradePct|  ┘ (file 02 denormalization)
    kind?: EdgeKind;     ← optional class (sidewalk/footway/…)
  };

  export type Graph = {
    city: string;
    bbox: [number, number, number, number];  ← minLng,minLat,maxLng,maxLat
    nodes: Record<string, Node>;   ← PK map
    edges: Edge[];                 ← flat array, NO id index here
    adjacency: Record<string, string[]>;  ← DERIVED index (file 03)
  };
        │
        └─ no `schemaVersion` field — the artifact can't declare its own
           shape, so a reader can't detect a stale format (file 05)
```

The `from → to` sign convention is enforced by exactly one function — the live
derivation below the build/runtime seam.

```
  features/routing/graph.ts (lines 16–19)

  export function directedGrade(edge: Edge, fromNodeId: string): number {
    return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
  }                                                          │
       │                                                     └─ reverse
       │                                                        traversal
       │                                                        negates
       └─ the ONLY value derived at runtime; everything else is frozen
          into the artifact. This is open-decision F option 1 (DRY):
          one undirected edge, direction computed on read. Remove the
          negation and every descent reads as a climb.
```

And the build step that materializes the derived grade fields — proving they're
computed, not authored.

```
  pipeline/grade.ts (lines 24–33)

  return edges.map((e) => {
    const lengthM = geometryLength(e.geometry);     ← derive length
    const riseM = nodes[e.toNode].elevationM         ← derive rise from the
               - nodes[e.fromNode].elevationM;          two endpoints' elev
    const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;
    const gradePct = Math.max(-MAX_GRADE_PCT,        ← clamp DEM noise
                     Math.min(MAX_GRADE_PCT, raw));
    return { ...e, lengthM, riseM, gradePct,
             absGradePct: Math.abs(gradePct) };       ← denormalize |grade|
  });
       │
       └─ this map() IS the source→derived seam made concrete: it reads
          source fields (geometry, elevationM) and writes the four derived
          ones into the stored edge
```

---

## Elaborate

This is a **property graph** — vertices and edges that both carry attributes —
which is the same family as Neo4j's model or a road network in OSRM/Valhalla.
flattr hand-rolls it instead of using a graph DB because the graph is tiny
(one bbox, thousands of edges), read-only at runtime, and the routing logic *is*
the project (spec §14, no Valhalla/OSRM allowed). When the dataset fits in
memory and never mutates at runtime, a graph database's transaction and
concurrency machinery is pure overhead — a JSON document is the right call.

The signed-grade-on-one-edge decision is the interesting one. Road-network
models routinely store directed edges (a one-way street is genuinely two
different things). flattr's segments are bidirectional *geometry* with a
*direction-dependent cost*, so storing one row and deriving the sign is both
DRY and correct. The tradeoff it buys back: the A* loop is slightly more
complex (it must track entry direction), which is why `directedGrade` exists as
a named function rather than inline arithmetic.

Read next: file 02 (why the four derived fields are stored, not computed on
read), then file 03 (why `adjacency` is stored as an index while the
nearest-node query has none).

---

## Interview defense

**Q: Walk me through your data model and defend the entity boundaries.**

It's a property graph: `Node` (a positioned, elevation-tagged vertex) and `Edge`
(an undirected segment with a signed grade), bundled with a derived `adjacency`
index into one `Graph` artifact. The load-bearing decision is storing each edge
*once* with a signed `gradePct`, and deriving the travel-direction grade at
traversal via `directedGrade` — rather than materializing two directed edges.

```
  one undirected edge, direction derived on read

  e0 {from:n0, to:n1, gradePct:+3.2}
       │
       ├─ n0→n1 read: +3.2  (climb, penalized)
       └─ n1→n0 read: −3.2  (descent, free)

  vs the rejected option: two rows (e0_fwd, e0_rev), 2× artifact size
```

**Anchor:** "One edge, signed grade, direction derived — DRY over a 2× artifact;
`directedGrade` in `graph.ts:16` is where the sign flips."

**Q: Why isn't `adjacency` redundant — it's all in `edges`?**

It *is* redundant — and deliberately so. It's a precomputed index. The hot query
is "neighbors of node X," run once per A* expansion; without `adjacency` that's
an O(E) scan of the edge array every time. Storing the index trades artifact
size and a rebuild-on-change cost for O(1) neighbor lookup. Since the artifact
is read-only at runtime, the rebuild cost is paid once at build, so it's free in
practice.

**Anchor:** "adjacency is a hash index, not a second source of truth — same role
as a Postgres index on a foreign key."

---

## Validate

1. **Reconstruct.** From memory, draw the three collections in `Graph` and label
   which fields in `Edge` are source vs derived. Check against
   `features/routing/types.ts:10–20` and `pipeline/grade.ts:24–33`.
2. **Explain.** Why is `gradePct` signed but `absGradePct` not? Trace it to the
   two readers: routing (signed, direction matters) vs heatmap (abs, no
   direction). See `features/routing/cost.ts:32` and `features/grade/zones.ts:39`.
3. **Apply.** A teammate wants to add a `surface` field (concrete/gravel) for
   comfort scoring. Where does it go, is it source or derived, and what writes
   it? (Source field on `Edge`, written by the pipeline from OSM tags in
   `pipeline/osm.ts`.)
4. **Defend.** Someone proposes storing two directed edges to "simplify the A*
   loop." Defend keeping one. (2× artifact, two rows to keep in sync, and
   `directedGrade:graph.ts:16` already solves it in one line — DRY wins because
   the artifact is download-size-sensitive on mobile.)

---

## See also

- `02-normalization-and-duplication.md` — the source/derived seam in depth.
- `03-indexing-vs-query-patterns.md` — adjacency-as-index vs the un-indexed scan.
- `04-transactions-and-integrity.md` — the FK-like refs and what guards them.
- `.aipe/study-dsa-foundations/` — adjacency list as an in-memory graph rep.
- `.aipe/study-database-systems/` — adjacency as a hash index, storage layout.
