# Access patterns and storage choice

**Industry names:** storage-shape-to-access-pattern fit · document store vs
relational vs graph DB · in-memory working set · load-once-read-many. **Type:**
language-agnostic principle; flattr's storage choice is project-specific. (This
is the seam to system-design — kept to *shape*, not architecture.)

---

## Zoom out, then zoom in

The question here is whether the *storage shape* matches the *access pattern*: do
you read this data the way the storage is organized to be read? flattr stores a
graph as one JSON document, loads it whole into memory, and reads it as an
in-memory object graph. Here's where that whole-document load sits.

```
  Zoom out — the storage shape vs how it's accessed

  ┌─ Storage layer ─────────────────────────────────────────────┐
  │  graph.json  ── ONE document, ~all-or-nothing                │ ← we are here
  │  (bundled asset, no query engine, no partial read)           │
  └───────────────────────────────┬─────────────────────────────┘
                                   │  loadGraph(): parse the WHOLE file
  ┌─ Working set (in memory) ──────▼────────────────────────────┐
  │  Graph object: nodes map + edges array + adjacency index    │
  │  accessed as: adjacency[id], nodes[id], byId.get(id)        │
  │  → random pointer-chasing over an in-memory object graph    │
  └──────────────────────────────────────────────────────────────┘
```

Verdict up front: **the storage shape fits the access pattern well.** The access
is "load a bounded region once, then traverse it densely with random in-memory
lookups" — and a JSON document loaded into a JS object graph is exactly the
right shape for that. A relational store would force you to either round-trip
per neighbor (catastrophic for A*) or load it all anyway; a graph DB's
machinery is overkill for read-only in-memory traversal. The one tension is
*boundedness*: the whole-document model assumes the graph fits in memory, and
`useTileGraph` exists precisely because the "whole city" version wouldn't — so
flattr already pays the access-pattern tax at the edges.

---

## Structure pass

Two layers — the on-disk/bundled shape and the in-memory working set. I'll trace
the axis **"what's the unit of access?"** — how much data you touch per
operation — because storage-shape fit is entirely about whether the storage's
natural unit matches the query's natural unit.

```
  Axis — "unit of access" — disk shape vs query need

  ┌─ Storage unit (what the shape gives you) ──────────────────┐
  │  graph.json: the WHOLE graph is the unit. You parse it all  │
  │  or none. No row, no range, no partial read.                │
  └────────────────────────────┬───────────────────────────────┘
              seam: parse the whole document into memory ONCE
              (after this, the unit of access changes completely)
  ┌─ Query unit (what A* actually needs) ──────────▼───────────┐
  │  one node's neighbors at a time — tiny, random, repeated   │
  │  millions of times. NOT a scan, NOT a range — pointer hops.│
  └──────────────────────────────────────────────────────────────┘
```

**The seam is the one-time whole-document load.** Before it, the unit is "the
entire graph" (coarse, all-or-nothing). After it, the unit is "one node's edge
list" (fine, random, hot). The fit works because flattr pays the coarse cost
*once* (parse the whole file) to convert it into a structure where the fine,
hot, random access is O(1). That's the classic load-once-read-many trade, and
it's the right call when the working set fits in memory and is read far more than
it changes — both true here.

---

## How it works

### Move 1 — the mental model

You've fetched a JSON blob and held it in component state, then read fields off
it a thousand times without re-fetching. That's the whole pattern: pay one I/O
to materialize the data in memory, then make every subsequent read a cheap
in-memory property access. The storage choice question is just: *is one whole-
blob fetch the right unit, or do you need to page/range/query the store
incrementally?* For a bounded graph you traverse densely, one blob wins.

```
  The pattern — load-once-read-many

  disk/bundle           memory (working set)         query
  ───────────           ────────────────────         ─────
  graph.json  ──parse── ► Graph object  ──────────►  adjacency[id]  (O(1))
  (one I/O)     once       (lives for the             nodes[id]      (O(1))
                            app session)              — millions of
                                                        random hops
```

### Move 2 — the parts, one at a time

#### The storage shape — one JSON document, no query engine

`graph.json` is a single document with no internal query capability. You can't
ask it for "edges in this bbox" or "the node nearest X" — it has no index you
can query without first loading it whole. That sounds like a limitation, but
it's aligned with the access pattern: flattr doesn't *want* to query the store
incrementally, it wants the whole bounded region in memory so traversal is
pointer-chasing, not I/O.

```
  storage shape — document, not queryable store

  graph.json  =  { nodes, edges, adjacency }   ← opaque until parsed whole
       │
       ▼  no "SELECT … WHERE bbox" — the bbox bounding happens at
          BUILD time (you only put one region in the file), not at
          query time. boundedness is baked into what you store.
```

The boundary condition: this only works because the *build* bounds the data —
`run-build.ts` builds one bbox. The store has no paging because the producer
already decided the region. Push the region to "all of Seattle" and the
whole-document load breaks (parse time, memory) — which is the next part.

#### The in-memory working set — object graph, random access

After `loadGraph`, the data is a JS object graph: a `nodes` map, an `edges`
array, an `adjacency` map. A* accesses it by random key lookup —
`adjacency[current]`, then `byId.get(edgeId)`, then `otherEnd`. This is
pointer-chasing, and JS maps/objects make it O(1). The storage shape
(maps + arrays serialized to JSON) deserializes *directly* into the structure A*
needs — no transformation, no index rebuild at load (the index was stored, file
02/03).

```
  working set — JSON deserializes straight into the query structure

  JSON {nodes:{...}, adjacency:{...}}  ──parse──►  same shape in memory
       │                                                │
       └─ no ETL, no index build at load ───────────────┘
          (adjacency was precomputed at build → ready to query immediately)
```

#### The boundedness tension — why `useTileGraph` exists

The whole-document model assumes the graph fits in memory and parses fast
enough. For one neighborhood (the MVP bbox), it does. For a city, it wouldn't —
parsing a multi-megabyte JSON on app start and holding it all would blow the
budget. flattr's answer is `useTileGraph`: instead of one giant artifact, build
graphs for the *visible viewport* and the *route corridor* on demand, prefixing
and stitching them (file 01's `tiles.ts`). That's the access pattern adapting
the storage shape — from "one bounded document" toward "load the region you're
looking at."

```
  the tension — fixed document vs growing region

  bundled graph.json     →  one bounded region, loaded whole (works for MVP)
       │
       ▼  but the map can pan anywhere…
  useTileGraph           →  fetch + build the viewport/corridor on demand,
                            prefix ids, stitch into the merged graph
       │
       └─ this is load-once-read-many applied PER REGION instead of once
          globally — the same access pattern, re-scoped so it stays bounded
```

The honest read: `useTileGraph` is a partial reinvention of what a spatial store
gives you for free (give me the data in this bbox). flattr builds it by hand
because the data is derived (it can build any region from OSM+elevation on
demand) and there's no server. The boundary condition: tiles built independently
don't share boundary nodes, so they're stitched with zero-length connector edges
(file 02) — the seam handling that a single bounded document never needed.

#### Why not relational, why not a graph DB

Worth naming the alternatives the verdict rejects, because the *fit* argument is
strongest by contrast.

```
  storage choices vs flattr's access pattern (dense in-memory traversal)

  relational (Postgres)  → neighbor query = a JOIN per hop. Either round-trip
                           per A* expansion (death by latency) or SELECT * and
                           load it all anyway → same as the document, minus the
                           free in-memory shape. FIGHTS the pattern.
  graph DB (Neo4j)       → built for traversal, but adds a server, a query
                           language, transactions, concurrency — all overkill
                           for read-only, in-memory, bounded data. OVER-BUILT.
  JSON document (chosen) → deserializes into the exact in-memory structure A*
                           needs, zero query engine, zero server. FITS.
```

### Move 3 — the principle

Pick the storage shape whose *natural unit of access* matches your query's
natural unit. flattr's queries want a whole bounded region resident in memory
for dense random traversal — so a document you load once and read as an object
graph is the right shape, and a row-oriented or server-based store would fight
it. The general rule: when the working set fits in memory, is read far more than
written, and is accessed by pointer-chasing rather than by range/filter queries,
the database *is* "parse a file into a map." The interesting failure mode isn't
the shape — it's boundedness, and `useTileGraph` is flattr already managing it.

---

## Primary diagram

The storage shape, the load seam, the working set, and the boundedness escape
hatch, in one frame.

```
  flattr's storage-to-access fit

  ┌─ Storage (bundled / built) ───────────────────────────────────┐
  │  graph.json  — one bounded-region JSON document                │
  │  unit of access: the WHOLE graph (no partial read, no query)   │
  └───────────────────────────────┬───────────────────────────────┘
                                   │  loadGraph(): parse whole, ONCE
  ┌─ Working set (memory, session) ▼───────────────────────────────┐
  │  Graph object — nodes map · edges array · adjacency index      │
  │  unit of access: one node's neighbors (O(1), random, millions) │
  │  fit: JSON deserializes straight into the query structure      │
  └───────────────────────────────┬───────────────────────────────┘
                                   │  pan past the bounded region?
  ┌─ Boundedness escape (useTileGraph) ▼───────────────────────────┐
  │  build viewport/corridor graphs on demand → prefix → stitch    │
  │  = load-once-read-many re-scoped per region (hand-rolled bbox  │
  │    query, because the data is derivable from OSM on demand)     │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

- **App start** → `loadGraph` parses the whole bundled document once.
- **A* traversal** → dense random in-memory access (`adjacency`, `nodes`,
  `byId`).
- **Panning the map / routing far** → `useTileGraph` builds and stitches
  region graphs on demand.

### Code, line by line

The whole-document load — the one-time coarse-unit read.

```
  mobile/src/loadGraph.ts (lines 7–11)

  import graph from "../assets/graph.json";   ← the WHOLE document, bundled
  export function loadGraph(): Graph {
    return graph as unknown as Graph;          ← no partial read, no query;
  }                                              parse all, hold all in memory
       │
       └─ storage unit = the entire graph. This is the load-once half of
          load-once-read-many.
```

The dense in-memory access — the hot fine-grained read the shape enables.

```
  features/routing/astar.ts (lines 64–65)

  for (const edgeId of graph.adjacency[current] ?? []) {  ← O(1) map read
    const edge = byId.get(edgeId)!;                        ← O(1) map read
  }                                                          random, millions
       │                                                       of times
       └─ query unit = one node's neighbors. The JSON's nested maps/arrays
          deserialize into exactly these structures — no ETL at load.
```

The boundedness escape — access pattern re-scoping the storage.

```
  mobile/src/useTileGraph.ts (lines 1–6, header)

  // fetch the WHOLE visible viewport in ONE graph build, and likewise the
  // WHOLE corridor between two route endpoints. Both are stitched into the
  // merged graph so routing and display cross seams.
       │
       └─ this is the hand-rolled "give me the data in this bbox" that a
          spatial store would provide — built on demand because the data is
          derivable from OSM+elevation, with no server to query.
```

The on-demand region build — proving the data is reproducible per region.

```
  mobile/src/useTileGraph.ts (imports, lines 11–13)

  import { buildGraph } from "pipeline/build-graph";
  import { openMeteoProvider } from "pipeline/elevation";
       │
       └─ the SAME pipeline that writes graph.json runs at RUNTIME to build
          a region's graph. Storage shape is "build the region you need" —
          the document is just a precomputed default region.
```

---

## Elaborate

Storage-shape-to-access-pattern fit is the decision behind every "should this be
SQL or NoSQL" debate, and the honest framing is always about the *access unit*,
not the buzzword. Row stores win for filtered/range queries over large sets you
don't hold in memory; document stores win when you read a whole aggregate at
once; graph databases win for deep traversal over data too big to materialize;
KV stores win for point lookups. flattr's access — bounded region, resident in
memory, dense random traversal — is the document-store-into-memory sweet spot,
which is why "a JSON file parsed into a map" beats all of them here.

This is the seam to system-design (`.aipe/study-system-design/`): *which*
datastore, server vs client, how to scale to all-of-Seattle, and the build-time-
artifact pattern itself are architecture questions that live there. What lives
*here* is the shape question — and the shape is right. The boundedness tension is
where the two studies meet: `useTileGraph`'s on-demand region building is a
data-shape adaptation (re-scope the working set) that's driven by an
architecture constraint (no server, derivable data). Spatial databases
(PostGIS, with R-tree/GIST indexes) are the off-the-shelf answer to the same
boundedness problem; flattr hand-rolls it because the data is regenerable and
there's no backend.

Your portfolio has the contrast built in: AdvntrCue colocates vector + relational
data in one Postgres (a server-side store queried per request), while contrl runs
a fully on-device pipeline with no network in the hot path. flattr is closer to
contrl — the data is local and resident, and the "query" is in-memory traversal,
not a network round-trip. Recognizing which of those shapes a problem wants is
the whole skill.

Read next: file 07 (the consolidated red-flag audit — where this fit verdict
joins the indexing and integrity findings).

---

## Interview defense

**Q: Why store a graph as a JSON file instead of in a database?**

Because the access pattern is "load a bounded region once, then traverse it
densely with random in-memory lookups" — and a JSON document deserializing into
a JS object graph is exactly that shape. A relational store would force a JOIN
or round-trip per neighbor, which is fatal for A*'s inner loop; a graph DB adds a
server and transactions I don't need for read-only in-memory data. The document
fits; the alternatives fight the pattern.

```
  access unit = one node's neighbors, O(1), millions of times, in memory
       │
       ▼  the store must make THAT cheap
  JSON → parse once → object graph → adjacency[id]   ✓ (no per-hop I/O)
  SQL  → JOIN/round-trip per hop                     ✗ (I/O in the inner loop)
```

**Anchor:** "Match the storage unit to the query unit — mine is in-memory
pointer-chasing, so the database is a parsed file."

**Q: That can't scale to a whole city. What breaks, and what did you do?**

The whole-document load assumes the graph fits in memory and parses fast — true
for the MVP neighborhood, false for a city. So `useTileGraph` re-scopes it: build
the viewport and route-corridor graphs on demand, stitch them, instead of one
giant artifact. It's a hand-rolled "data in this bbox" query — cheap to build
because the data's derivable from OSM with no server.

**Anchor:** "The shape's right; boundedness is the real constraint, and
`useTileGraph` re-scopes load-once-read-many per region."

---

## Validate

1. **Reconstruct.** Name flattr's storage unit and its query unit, and say why
   they fit. (Whole document vs one node's neighbors; parse-once converts coarse
   to fine — `loadGraph.ts`, `astar.ts:64`.)
2. **Explain.** Why would a relational store fight A*'s access pattern? (Neighbor
   query = JOIN/round-trip per hop, in the inner loop.)
3. **Apply.** The product wants all of Seattle routable. Does the storage shape
   change, and how does `useTileGraph` already address it? (Whole-document load
   breaks on memory/parse; tile-on-demand re-scopes it —
   `useTileGraph.ts:1–6`.)
4. **Defend.** A reviewer says "use PostGIS, it does spatial queries for free."
   Name what that buys (bbox/nearest indexes) and why flattr hand-rolls instead
   (derivable data, no server, in-memory traversal). (Seam to system-design.)

---

## See also

- `03-indexing-vs-query-patterns.md` — the nearest-node query a spatial store
  would index for free.
- `05-migrations-and-evolution.md` — the derived-artifact property that lets
  `useTileGraph` build regions on demand.
- `01-the-data-model-and-its-shape.md` — the object-graph structure the JSON
  deserializes into.
- `.aipe/study-system-design/` — datastore choice, build-time artifact, scaling
  (the architecture half of this seam).
