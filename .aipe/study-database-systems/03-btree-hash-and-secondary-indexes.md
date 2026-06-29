# B-tree, hash, and secondary indexes

**Industry name(s):** index structures / primary & secondary indexes / B+tree /
hash index / spatial index · **Type:** Industry standard.

## Zoom out, then zoom in

This is the single richest database lesson flattr actually exercises — and the
one it most visibly *misses*. flattr hand-builds two indexes and conspicuously
lacks a third.

```
  Zoom out — indexes sit between the query and the records

  ┌─ Query layer ───────────────────────────────────────────┐
  │  astar.search()  ·  nearestNode()                       │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Index layer ──────────────▼─────────────────────────────┐
  │  ★ nodes (PK hash)  ·  adjacency (2ndary)  ·  byId (txn) ★│ ← we are here
  │  ✗ NO spatial index over node coordinates  (the gap)     │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  records in graph.json (nodes map, edges array)          │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. An index is a *second data structure whose only job is to find records
fast without scanning all of them.* The cost: every index you add must be kept in
sync on every write, so indexes trade write cost for read speed. flattr's writes
happen offline at build time, so its indexes are "free" to maintain at runtime —
which is exactly why it can afford a hand-built one (`adjacency`) and exactly why
the *missing* one (spatial) hurts so visibly when present in the read path.

## The structure pass

**Layers** (by index role):
1. **Primary index** — `nodes: Record<id,Node>` — the data, addressed by key.
2. **Secondary index** — `adjacency: Record<id, edgeId[]>` — points *into* the
   primary store by a non-key access path (node → its edges).
3. **Transient index** — `byId: Map<id,Edge>` built per search in `astar.ts:11`.
4. **The missing index** — no spatial index over `(lat,lng)`.

**Axis traced — "how do I find a record by this access path: O(1), O(log N), or
O(N)?"**

```
  axis — "lookup cost by access path" — across the indexes

  access path                    structure              cost
  ─────────────────────────────  ─────────────────────  ──────
  node by id                     nodes Record (hash)    O(1)
  edges incident to a node       adjacency (2ndary)     O(1) → list
  edge by id (during search)     byId Map (transient)   O(1)
  edge by id (no index)          edges array scan       O(E)  ← avoided
  node nearest a coordinate      ✗ none — full scan     O(N)  ← the gap
```

The axis-answer flips hard at the last row. Every access path flattr's routing
hot loop needs is O(1) — because someone built the index. The one path with no
index, "nearest node to this tap," is O(N) and runs on every user interaction
(`nearest.ts:8`). That's the load-bearing seam: **the boundary between an indexed
access path and an unindexed one is where your latency cliff lives.**

## How it works

### Move 1 — the mental model

You've built this. `me.md` says you wrote `Graph.ts` with an adjacency list and
`Graph2.ts` (node+edge) for Dijkstra. An adjacency list *is* a secondary index:
it's a side structure mapping "node → its edges" so traversal doesn't scan all
edges. A database index is the same move generalized — a side structure that
turns "scan everything to find matches" into "look it up."

```
  the pattern — an index is a sorted/keyed shortcut into the records

  WITHOUT index (scan):          WITH index (lookup):
  records: [r0 r1 r2 … rN]       index:  key ─► location
            └─ check all ─┘               └─ jump straight there ─┘
  find by key = O(N)             find by key = O(1) hash / O(log N) B-tree
```

Two index shapes matter, and flattr uses (or misses) both:
- **Hash index** — O(1) point lookup, no range queries. flattr's `nodes` and
  `adjacency` are hash indexes (JS objects/Maps).
- **B+tree index** — O(log N) lookup *and* ordered range scans. flattr uses none,
  because it never asks "all nodes with lat between X and Y" — which is precisely
  the query a spatial index would answer for `nearestNode`.

### Move 2 — flattr's indexes, one at a time

**The primary index: `nodes` as a hash map.** `features/routing/types.ts:25`
declares `nodes: Record<string, Node>`. In a real DB this is the *primary key
index* — the clustered structure that *is* the table, addressed by PK. flattr
gets it for free from JavaScript: `graph.nodes[goalId]` (`astar.ts:39`) is a hash
lookup, O(1) average. Every "get node by id" in the codebase rides this.

```
  primary index — nodes keyed by id (hash)

  graph.nodes["n42"]
       │ hash("n42")
       ▼
  ┌──────────────────────────────┐
  │ {id:"n42", lat, lng, elevM}  │  one probe, O(1)
  └──────────────────────────────┘
```

**The secondary index: `adjacency`, hand-built.** This is the one that earns its
keep. It maps a node id to the ids of edges touching it — a non-key access path
("which edges can I leave this node by?"). Built once at build time:

```ts
// features/routing/graph.ts:22-29 — building the secondary index
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {                    // line 24: one pass over all edges, O(E)
    (adj[e.fromNode] ??= []).push(e.id);      // line 25: index the "from" endpoint
    (adj[e.toNode]   ??= []).push(e.id);      // line 26: index the "to" endpoint
  }
  return adj;                                 // line 28: nodeId → incident edgeIds
}
```

Lines 25-26 are the index build: one O(E) pass produces a structure that makes
"edges of node X" O(1). Without it, every A* expansion would scan all 1879 edges
to find the few incident to the current node — turning each of potentially
hundreds of expansions into an O(E) scan. *That's* what the index buys, and you
see it spent at `astar.ts:64`:

```ts
// features/routing/astar.ts:64 — spending the secondary index in the hot loop
for (const edgeId of graph.adjacency[current] ?? []) {  // O(1) lookup → small list
  const edge = byId.get(edgeId)!;                        // O(1) via the transient index
```

Drop `adjacency` and A*'s inner loop goes from O(degree) to O(E) per node. The
secondary index is what makes grade-aware routing tractable.

**The transient index: `byId` per search.** `astar.ts:11-16` builds a
`Map<id,Edge>` at the start of every search:

```ts
// features/routing/astar.ts:11-16 — a covering index over the edge array
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);  // O(E) build, once per search
  return m;
}
```

`adjacency` gives you edge *ids*; the records live in the `edges` *array* (O(E) to
find by id). So `byId` is a second index that resolves id→record in O(1), spent at
`astar.ts:65`. Two indexes compose: `adjacency` (node→edgeIds) then `byId`
(edgeId→Edge). This is the cost of having stored edges as an array (`02`,
Decision 2) — routing pays an O(E) build per search to undo it. **Inference:**
building it per-search rather than once at load is a minor inefficiency (red-flag
#5 territory); for the MVP's edge count it's negligible.

**The missing index: spatial.** Here's the gap. `nearestNode` answers "which node
is closest to this tapped coordinate?" — a *nearest-neighbor* query — by scanning
every node:

```ts
// features/routing/nearest.ts:5-17 — the UNINDEXED full scan
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId; let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {       // line 8: scan ALL 1621 nodes
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });  // distance per node
    if (d < bestDist) { bestDist = d; bestId = id; } // keep the running minimum
  }
  return bestId;
}
```

Line 8 is a **sequential scan** — the database equivalent of a query with no
usable index, forced into `Seq Scan` + a full sort-by-distance. It runs on every
route endpoint tap. At 1621 nodes it's microseconds and totally fine. At a
metro-scale graph (hundreds of thousands of nodes) it's a visible lag on every
tap, and the fix is a **spatial index**: a k-d tree, an R-tree, or a geohash
grid that prunes the search to a small candidate set.

```
  the gap — nearest-neighbor with vs without a spatial index

  WITHOUT (flattr now):                WITH (k-d tree / R-tree):
  ┌──────────────────────────┐         ┌──────────────────────────┐
  │ for every node:          │         │ descend tree to the cell │
  │   compute haversine      │         │ check only nearby nodes  │
  │   keep min               │         │ prune the rest           │
  └──────────────────────────┘         └──────────────────────────┘
       O(N) per tap                          O(log N) per tap
```

This is the same family as the **ANN / vector index** you shipped in `AdvntrCue`
(pgvector) — "find the nearest point in a high-dimensional space" is exactly
nearest-neighbor; pgvector's HNSW index is a spatial index for embeddings. flattr
does the 2-D version by brute force.

### Move 2 variant — the load-bearing skeleton of an index

Strip an index to what can't be removed:

1. **The kernel:** a *key-ordered or key-hashed* structure that maps an access
   path to record locations, kept *consistent with the records*. That's it — a
   shortcut + the promise it stays in sync.
2. **What breaks when each part is missing:**
   - Drop the *consistency* and the index lies — `adjacency` listing an edge that
     no longer exists routes through a ghost edge (flattr avoids this only because
     both are built together at build time; nothing *enforces* it — red-flag #4).
   - Drop the *ordering/hashing* and it's just a copy of the data — no faster.
   - Drop the index entirely and every lookup is a scan — exactly `nearestNode`.
3. **Skeleton vs hardening:** the shortcut + sync is the skeleton. Covering
   indexes, partial indexes, multi-column composite keys, fill factor — all
   hardening. flattr's `adjacency` is pure skeleton; it has none of the hardening
   because it's rebuilt wholesale offline.

### Move 3 — the principle

An index is a bet: you pay write cost and storage to make one access path fast.
The skill is knowing *which* access paths your queries actually use and indexing
exactly those — no more (every extra index taxes writes), no fewer (an unindexed
hot path is a latency cliff). flattr indexed its hot path (node→edges) perfectly
and left its *other* hot path (coordinate→nearest node) unindexed. Reading a
codebase for "which access paths are indexed vs scanned" is how you predict where
it'll fall over under load.

## Primary diagram

```
  flattr's index landscape — built, transient, and missing

  ┌─ QUERIES ─────────────────────────────────────────────────────┐
  │  A* expansion          nearest-to-tap          heatmap render  │
  └──────┬──────────────────────┬──────────────────────┬───────────┘
         │                      │                      │
  ┌──────▼──────┐        ┌──────▼──────┐        ┌──────▼──────┐
  │ adjacency   │        │  ✗ NONE     │        │ edges array │
  │ (2ndary,    │        │  full scan  │        │ (iterate    │
  │  hash)O(1)  │        │  O(N)/tap   │        │  all) O(E)  │
  └──────┬──────┘        └──────┬──────┘        └─────────────┘
         │ edgeIds              │
  ┌──────▼──────┐        ┌──────▼──────┐
  │ byId (txn   │        │ nodes hash  │
  │  index)O(1) │        │  O(1) probe │
  └──────┬──────┘        └─────────────┘
         ▼
  ┌─ RECORDS in graph.json: nodes Record + edges Array ───────────┐
  └───────────────────────────────────────────────────────────────┘
            built index ✓        the gap ✗         primary index ✓
```

## Elaborate

The B+tree is the workhorse of relational databases because it does *both* point
lookups (O(log N)) and ordered range scans (`WHERE x BETWEEN a AND b`) on one
structure — its leaves are linked in key order. Hash indexes are faster for exact
equality but can't range-scan at all. flattr's needs are all exact-match
(`nodes[id]`, `adjacency[id]`) so JS hash maps are the right tool; the moment it
needed a *range* query (nearest-in-a-region) it had no structure for it and fell
back to a scan.

The spatial index family — k-d trees, R-trees, quadtrees, geohashing, and in
Postgres the GiST index that powers PostGIS — exists exactly for the
`nearestNode` query. If flattr migrates to Postgres+PostGIS (the spec's
direction), `nearestNode` becomes `ORDER BY geom <-> point LIMIT 1` backed by a
GiST index, and the O(N) scan turns into an O(log N) index probe for free.

## Interview defense

**Q: "What indexes does flattr have, and what's missing?"**

> Two built, one missing. `nodes` is a hash primary index (O(1) by id).
> `adjacency` is a hand-built secondary index (`graph.ts:22`) mapping node→edges,
> spent in A*'s hot loop (`astar.ts:64`) to keep expansion O(degree) instead of
> O(E). Missing: a spatial index. `nearestNode` (`nearest.ts:8`) does an O(N)
> full scan over all nodes on every tap. Fine at 1621 nodes; a latency cliff at
> metro scale. The fix is a k-d tree or, post-migration, a PostGIS GiST index.

```
  indexed hot path:   node→edges   adjacency  O(1) ✓
  UNindexed hot path: tap→nearest  full scan  O(N) ✗  ← the cliff
```

Anchor: *the boundary between an indexed and an unindexed access path is where
the latency cliff lives — flattr indexed routing and forgot nearest-neighbor.*

**Q: "What's the load-bearing part of an index people forget?"**

> That it must stay *consistent* with the records. An index that drifts from the
> data is worse than no index — it returns wrong answers fast. flattr dodges this
> by building `adjacency` from the same edges at build time, but nothing
> *enforces* the invariant; if a future build emits a graph where adjacency and
> edges disagree, routing silently traverses or drops edges with no error.

Anchor: *an index is a shortcut plus the promise it stays in sync — and the
promise is the part that breaks.*

## See also

- `02-records-pages-and-storage-layout.md` — why edges-as-array forces the byId index
- `04-query-planning-and-execution.md` — Seq Scan vs Index Scan in flattr's reads
- `09-database-systems-red-flags-audit.md` — the O(N) scan and unenforced adjacency
- `../study-dsa-foundations/` — k-d trees, the heap behind A*, graph traversal
- `../study-ai-engineering/` — pgvector ANN as the high-D cousin of spatial indexing
