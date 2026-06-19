# Indexing vs query patterns

**Industry names:** index-to-query fit · adjacency index · the missing spatial
index (full-scan query). **Type:** language-agnostic principle; the two
concrete queries are project-specific.

---

## Zoom out, then zoom in

An index exists to serve a query. The discipline is to list the queries you
actually run, then check each one has an index that fits — and flag the ones
that don't. flattr runs exactly **two** lookup queries against the graph, and
they have opposite stories: one is perfectly indexed, the other has no index at
all. Here's where both fire.

```
  Zoom out — where the two queries run

  ┌─ Runtime (Expo app) ─────────────────────────────────────────┐
  │  user taps map                                                │
  │     │                                                         │
  │     ▼                                                         │
  │  nearestNode()  ── QUERY A: "closest node to this point?"     │ ← we are here
  │     │             (O(N) full scan — NO index)                 │
  │     ▼                                                         │
  │  A* search                                                    │
  │     │  per expansion:                                         │
  │     ▼                                                         │
  │  adjacency[nodeId]  ── QUERY B: "neighbors of this node?"     │
  │                      (O(1) hash lookup — INDEXED)             │
  └───────────────────────────────────────────────────────────────┘
```

Verdict up front: **Query B (neighbor lookup) is the model's whole reason for
having an `adjacency` index, and it's a perfect fit. Query A (nearest node) is
the one un-indexed query in the app — a full linear scan with a haversine per
node, run on every tap.** Query A is the single biggest data-modeling weakness
in the repo's query layer. It's tolerable today only because the graph is small.

---

## Structure pass

Two queries, two layers (the index that exists, the query that runs). I'll trace
the axis **"what does this query cost as the graph grows?"** — because that's
the axis where the indexed and un-indexed queries diverge, and growth is exactly
what `tiles.ts` makes happen (it merges more tiles into the graph as you pan).

```
  Axis — "cost as graph grows (N nodes, E edges)?" — two queries

  ┌─ Query B: neighbor lookup (A* hot path) ───────────────────┐
  │  adjacency[nodeId]  →  O(1) regardless of N or E           │
  │  growth: FLAT. indexed.                                    │
  └────────────────────────────────────────────────────────────┘
                    seam: index present vs absent
  ┌─ Query A: nearest node (every tap) ────────────────────────┐
  │  scan all nodes, haversine each  →  O(N)                   │
  │  growth: LINEAR. un-indexed.                                │
  └────────────────────────────────────────────────────────────┘
```

**The seam is the presence of an index.** Above it, cost is flat as the graph
grows; below it, cost rises linearly. That's the load-bearing distinction in any
query layer: an index turns a scan into a lookup. flattr made that turn for the
graph-traversal query and didn't for the spatial query — and as `tiles.ts`
pushes N up by merging viewport tiles, Query A is the one that degrades.

---

## How it works

### Move 1 — the mental model

You've felt this in the frontend: a `.find()` over an array is O(N), but a
`Map.get()` is O(1). If you're calling `.find()` once, who cares — but call it
inside a loop that runs thousands of times and you've built an accidental
O(N²). An index is just the `Map` you build *once* so the repeated lookup is
cheap. The whole topic is: which of your repeated lookups is still a `.find()`?

```
  The pattern — index = build a lookup once, query it many times

  WITHOUT index (Query A):           WITH index (Query B):
  ┌──────────────────────┐          ┌──────────────────────┐
  │ for each of N nodes:  │          │ adjacency[nodeId]     │
  │   compute haversine   │          │   → direct hash hit   │
  │   track min           │          └──────────────────────┘
  └──────────────────────┘                 O(1)
        O(N) every call            built once at build time
```

### Move 2 — the parts, one at a time

#### Query B — neighbor lookup, and the index that serves it

Inside A*, every time a node is finalized, the search asks "which edges touch
this node?" That's the inner loop of the whole algorithm — it runs once per
expanded node, and a city graph has thousands of nodes. `adjacency` answers it
in one hash lookup: `adjacency[current]` returns the edge-id list directly.

```
  Query B — adjacency serves the A* inner loop

  A* pops node `current`
       │
       ▼
  adjacency[current]  ──►  [e0, e1, e2]   ← O(1) hash hit
       │
       ▼  for each edgeId
  byId.get(edgeId)    ──►  the Edge       ← O(1) (a SECOND index, built
                                             per search in indexEdges())
```

Note the second index: `astar.ts` builds an id→Edge `Map` (`indexEdges`) at the
start of each search, because `edges` is a flat array with no id index — looking
an edge up by id otherwise would be an O(E) `.find()`. So A* actually relies on
*two* indexes: the stored `adjacency` (nodeId→edgeIds) and the per-search
`byId` (edgeId→Edge). The boundary condition: drop `byId` and resolve edges with
`graph.edges.find()` and A* goes from near-linear to quadratic — the comment on
`indexEdges` says exactly this ("so expansions are O(1) per edge, not O(E)").

#### Query A — nearest node, the un-indexed scan

When you tap the map to set a start or end, the tapped lat/lng isn't a graph
node — it's an arbitrary point. `nearestNode` has to find the closest actual
node, and it does it by scanning **every** node and computing a haversine
distance to each, tracking the minimum.

```
  Query A — nearestNode: full scan, haversine per node

  tap (lat,lng)
       │
       ▼
  for id in graph.nodes:        ← ALL N nodes
       d = haversine(tap, node)  ← trig per node
       if d < best: best = id
       │
       ▼
  return best                    ← O(N), one tap = N haversines
```

This is the red flag: **a frequent query with no supporting index.** It fires on
every route request (twice — start and end). A spatial index — a k-d tree, an
R-tree, or even a coarse grid bucketing nodes by `tileKeyOf`-style cells — would
turn it into roughly O(log N) or O(1)-per-cell. The reason it's survivable
*right now*: the bbox is one small neighborhood (Capitol Hill MVP), so N is in
the low thousands and a scan is sub-millisecond. The reason it's a real
liability: `tiles.ts` exists specifically to *grow* the graph by merging
viewport and corridor tiles, so N climbs exactly as the app gets used — and the
scan cost climbs with it, on the main thread, on a phone.

#### The fix, named (so the criticism is constructive)

The minimal fix that fits the existing code: flattr already computes grid cells
for tiling (`tiles.ts:tileKeyOf`) and for the heatmap (`zones.ts`). Bucket nodes
into the same kind of grid once at load, then `nearestNode` only scans the
tapped cell plus its 8 neighbors — O(nodes-per-cell) instead of O(N). A k-d tree
is the "proper" answer; the grid is the one that reuses machinery already here.

```
  the fix — grid-bucket the nodes, scan one cell not all N

  build once:  nodeGrid["col,row"] = [nodeIds in that cell]
  query:       cell = cellOf(tap); scan cell + 8 neighbors only
               → O(nodes in ~9 cells), independent of total N
```

### Move 3 — the principle

Indexes aren't free — each one costs space and a maintenance obligation — so you
build them *to fit the queries you actually run*, not speculatively. The
discipline that catches bugs is the inverse: enumerate the real queries and
prove each frequent one has a fitting index. flattr passes that test for graph
traversal (the query the project is *about*) and fails it for spatial nearest-
neighbor (a query that snuck in at the UI edge). That's a common shape: the
core path gets indexed because you think hard about it; the supporting query at
the boundary gets a scan because it "looked like a one-liner."

---

## Primary diagram

Both queries, their indexes (or lack of), and their growth curves, in one frame.

```
  flattr's two graph queries — index-to-query fit

  QUERY                 INDEX                 COST     GROWTH    VERDICT
  ─────                 ─────                 ────     ──────    ───────
  B: neighbors of node  adjacency (stored)    O(1)     flat      ✓ fits
     (A* inner loop)    + byId (per-search)   O(1)     flat      ✓ fits

  A: nearest node to    — none —              O(N)     linear    ✗ MISSING
     tapped point       (full scan +                             every tap,
     (every route req)   haversine per node)                     main thread

  ┌─ runtime flow ────────────────────────────────────────────────┐
  │  tap ─► nearestNode [O(N) scan] ─► A* [adjacency O(1) per hop] │
  │         └─ the un-indexed step ─┘   └─ the indexed step ──────┘ │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

- **Set a route start/end by tapping** → `nearestNode` (Query A), the scan.
- **A* expands a node** → `adjacency[current]` (Query B), the index.
- **A* resolves an edge id to an Edge** → `indexEdges`/`byId`, the per-search
  index that exists because `edges` has no id index.

### Code, line by line

The index that serves the hot query — built once, read every expansion.

```
  features/routing/graph.ts (lines 22–29)  — building the adjacency index

  export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const e of edges) {
      (adj[e.fromNode] ??= []).push(e.id);   ← bucket edge under its from-node
      (adj[e.toNode]   ??= []).push(e.id);   ← AND its to-node (undirected)
    }
    return adj;                               ← one O(E) pass at build time
  }
       │
       └─ this is the index. Built once in build-graph.ts:29, frozen into
          the artifact, then O(1) per A* expansion forever after.

  features/routing/astar.ts (line 64)  — the hot query using it
    for (const edgeId of graph.adjacency[current] ?? []) { ... }
                                  │
                                  └─ O(1) hash lookup; the whole reason
                                     adjacency is denormalized (file 02)
```

The second index, built per search because `edges` is an unindexed array.

```
  features/routing/astar.ts (lines 11–16)

  export function indexEdges(graph: Graph): Map<string, Edge> {
    const m = new Map<string, Edge>();
    for (const e of graph.edges) m.set(e.id, e);   ← edgeId → Edge
    return m;
  }
       │
       └─ comment says it: "so expansions are O(1) per edge, not O(E)."
          Without this, byId.get(edgeId) would be graph.edges.find() — an
          O(E) scan inside the A* inner loop → overall O(N·E).
```

The un-indexed query — the weakness.

```
  features/routing/nearest.ts (lines 5–18)

  export function nearestNode(graph: Graph, point: LatLng): string {
    let bestId; let bestDist = Infinity;
    for (const id of Object.keys(graph.nodes)) {   ← scans ALL N nodes
      const n = graph.nodes[id];
      const d = haversine(point, {lat:n.lat, lng:n.lng});  ← trig per node
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    ...
  }
       │
       └─ no spatial index. O(N) per call, called twice per route (start+end),
          on the JS thread on a phone. Fine at N≈thousands (Capitol Hill MVP);
          degrades exactly as tiles.ts merges more tiles to grow the graph.
```

---

## Elaborate

The index-to-query discipline is the heart of practical database performance:
`EXPLAIN ANALYZE` in Postgres exists to tell you whether a query hit an index or
fell back to a sequential scan. A "Seq Scan on a 10M-row table" in a hot path is
the exact thing `nearestNode` is, just hand-rolled. The fix categories are the
same too: B-tree for ordered/range lookups, hash for equality, and for spatial
nearest-neighbor specifically, a **spatial index** — R-tree (PostGIS `GIST`),
k-d tree, or geohash/grid bucketing.

flattr's `adjacency` is a hash index by another name; its absence of a spatial
index is the same gap PostGIS solves with `CREATE INDEX ... USING GIST (geom)`.
The grid-bucket fix proposed above is essentially a hand-rolled geohash — and
flattr already has the cell-keying primitive in `tiles.ts:tileKeyOf`, so the fix
is mostly wiring, not new machinery.

This connects to your DSA work directly: you built priority queues and graph
traversals in `reincodes`, and you know an adjacency list makes BFS/Dijkstra
cheap. The nearest-node problem is the one that wants a *different* structure —
a k-d tree — which is the union-find/segment-tree corner of DSA you've noted as
less-exercised. So it's a genuinely new structure to reach for, not a variant of
what's already built.

Read next: file 04 (the integrity guards — or absence — around the FK-like
references these queries traverse).

---

## Interview defense

**Q: What queries does your data model serve, and does each have an index?**

Two. Neighbor-of-node, the A* inner loop, served by the stored `adjacency` hash
index — O(1), perfect fit. And nearest-node-to-a-tap, served by nothing — an
O(N) full scan with a haversine per node in `nearest.ts`. That second one is the
model's weakest query: frequent (every route request, twice), un-indexed, on the
main thread.

```
  index-to-query fit

  neighbors  ─► adjacency[id]   O(1)  ✓ indexed (the query the project is about)
  nearest    ─► scan all N      O(N)  ✗ no spatial index (the boundary query)
```

**Anchor:** "Core traversal is indexed; the spatial nearest-node query is a full
scan — a grid bucket or k-d tree fixes it, and `tiles.ts` already has the cell
key to reuse."

**Q: Why is it fine today, and when does it stop being fine?**

Fine because the MVP bbox is one neighborhood — N is low thousands, so the scan
is sub-millisecond. It stops being fine because `tiles.ts` grows the graph by
merging viewport and corridor tiles as you pan, so N climbs with usage, and the
scan climbs linearly with it — on a phone's JS thread.

**Anchor:** "It's O(N) on a graph that's designed to grow — the cost rises
exactly as the feature gets used."

---

## Validate

1. **Reconstruct.** Name flattr's two graph queries and the index (if any) each
   uses. Check `features/routing/astar.ts:64` (adjacency) and
   `features/routing/nearest.ts:8` (the scan).
2. **Explain.** Why does `astar.ts` build `byId` at the start of every search
   instead of using `graph.edges.find()`? (Avoids an O(E) scan inside the inner
   loop — `astar.ts:11–16`, comment on line 11.)
3. **Apply.** The graph grows to all of Seattle (N → ~10⁵+). Which query breaks
   first, and what index fixes it? (`nearestNode`; a spatial grid or k-d tree.)
4. **Defend.** A reviewer says "just `.find()` the edge by id, it's one line."
   Defend `indexEdges`. (Inside the A* loop that's O(N·E); the index makes it
   near-linear — `astar.ts:11`.)

---

## See also

- `02-normalization-and-duplication.md` — `adjacency` is the denormalization
  that *is* this file's index.
- `04-transactions-and-integrity.md` — the FK refs these queries traverse.
- `.aipe/study-database-systems/` — adjacency-as-hash-index, scan vs index.
- `.aipe/study-dsa-foundations/` — k-d tree, the structure the spatial query wants.
