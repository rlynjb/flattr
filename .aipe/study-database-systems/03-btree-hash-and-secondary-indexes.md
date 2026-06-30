# B-tree, hash, and secondary indexes

**Industry names:** primary index · secondary index · hash index · B-tree ·
spatial index — *type label: Industry standard.*

## Zoom out, then zoom in

flattr has two indexes it built by hand and one it's missing. This is the
single richest database topic in the codebase, because the whole reason A*
is fast and the whole reason `nearestNode` is slow both come down to *which
index exists*. Find them on the map, then we walk each.

```
  Zoom out — the indexes on the read store

  ┌─ Storage layer — the in-memory Graph ───────────────────────┐
  │                                                             │
  │  ★ nodes: Record<id,Node> ★      PRIMARY index (hash)       │ ← have it
  │      graph.nodes[id]   → O(1)                                │
  │                                                             │
  │  ★ adjacency: id→edgeId[] ★      SECONDARY index            │ ← have it
  │      graph.adjacency[node] → O(1) neighbor edges            │
  │                                                             │
  │  ✗ (missing) spatial index       lat/lng → nearest node    │ ← the gap
  │      nearestNode scans ALL nodes → O(N)                     │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. An index is a **secondary data structure that turns a scan into a
lookup**. A real database builds B-trees and hash indexes automatically and
a query planner picks among them. flattr has no planner — every index is a
deliberate hand-built object, and the one query that lacks an index
(spatial nearest-neighbor) is stuck doing the full scan a planner would have
avoided. Naming which index serves which query is the lesson.

## The structure pass

**Layers.** Three access paths over the same graph: by node id (primary), by
node→edges (secondary/adjacency), by coordinate (spatial — absent).

**Axis — does this access path have an index?** Trace it:

```
  Axis: "is this query indexed?" across the three access paths

  ┌─ by node id ────────────────┐  → YES: Record hash → O(1)
  │  graph.nodes["n42"]         │     (primary index)
  └─────────────────────────────┘
  ┌─ by node → its edges ───────┐  → YES: adjacency Record → O(1)
  │  graph.adjacency["n42"]     │     (secondary index, hand-built)
  └─────────────────────────────┘
  ┌─ by lat/lng → nearest node ─┐  → NO: full scan → O(N)
  │  nearestNode(graph, pt)     │     (missing spatial index)
  └─────────────────────────────┘

  two indexed, one not — the seam is at the third path
```

**Seam.** The boundary that flips is **"is this the hot path?"** A* runs
millions of expansions and is fully indexed — every step is O(1).
`nearestNode` runs twice per route (start + end tap) and is *not* indexed.
flattr indexed exactly where the volume is and left the low-volume path
scanning. That's a defensible call today and a latency cliff tomorrow.

## How it works

### Move 1 — the mental model

You know what an index does: you've written
`const byId = new Map(items.map(i => [i.id, i]))` so you could look something
up without `.find()` on every call. That one line *is* a hash index. flattr
does exactly this — twice as persistent structures (`nodes`, `adjacency`),
once as a per-query throwaway (`indexEdges`), and never for coordinates
(the gap).

```
  The index kernel — what every index is

  ┌─ the table (slow path) ──────────────────────┐
  │  edges: Edge[]   → find by scanning  O(N)     │
  └───────────────────────────────────────────────┘
              │  build a lookup structure once
              ▼
  ┌─ the index (fast path) ──────────────────────┐
  │  Map<id, Edge>   → find by key       O(1)     │
  └───────────────────────────────────────────────┘
   trade: extra memory + build cost, for O(N)→O(1) reads
```

### Move 2 — the three indexes, one at a time

**Primary index — `nodes` as a hash on id.** Nodes live in
`Record<string, Node>` (`types.ts:25`). The key is the id; the lookup is one
hash probe. This is a primary (clustered) index in the database sense: the
key is the row's identity *and* its access path. No B-tree needed — there's
no range-scan-by-id requirement, so a hash is strictly better (O(1) vs.
O(log N)). This is why `astar.ts:39` can write `graph.nodes[goalId]` and
trust it's instant.

**Secondary index — `adjacency`, the load-bearing one.** This is the index
that makes the whole router work. It's built once in `buildAdjacency`:

```ts
// features/routing/graph.ts:22-29 — building the secondary index
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);  // ← index entry: node → its edge ids
    (adj[e.toNode] ??= []).push(e.id);    // ← both endpoints (undirected adj)
  }
  return adj;                              // O(E) build, once
}
```

Without it, "what edges touch node X?" would be `edges.filter(e =>
e.fromNode===X || e.toNode===X)` — O(E) per node, run for every node A*
expands, making the search O(V·E). *With* it, A*'s inner loop is:

```ts
// features/routing/astar.ts:64 — the indexed expansion
for (const edgeId of graph.adjacency[current] ?? []) {  // ← O(1) lookup,
  const edge = byId.get(edgeId)!;                        //   then O(deg) edges
```

`graph.adjacency[current]` is one hash probe returning the node's incident
edge ids; the loop body is O(degree). That's the textbook **adjacency-list
secondary index** — a covering index for the one query A* runs constantly.
Strip it out and what breaks: A* degrades from near-linear to quadratic and
the router stalls on a real city graph. It is the most load-bearing index
in the repo.

**Materialized index at query time — `indexEdges`.** A* also needs edge-by-id
fast (to resolve the ids `adjacency` returns). Rather than scan `edges` per
lookup, it builds a throwaway `Map` once per search:

```ts
// features/routing/astar.ts:11-16
/** Build an id->edge index once, so expansions are O(1) per edge, not O(E). */
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);  // O(E) build, amortized over the search
  return m;
}
```

This is a **materialized/temporary index** — built for one query, discarded
after. The comment names the exact tradeoff: pay O(E) once so every
expansion is O(1) instead of O(E). A real planner would build this hash
join structure for you; flattr does it by hand.

**The missing index — spatial.** `nearestNode` answers "which node is
closest to this lat/lng?" by scanning every node:

```ts
// features/routing/nearest.ts:5-18 — the unindexed full scan
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {   // ← O(N) over EVERY node
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

There is no index on `(lat, lng)`. Every start/end tap (`MapScreen.tsx:133-134`)
scans all ~1750 nodes computing haversine each time. This is the
flattr-shaped version of a missing index: a real database would build a
**spatial index** — an R-tree, a k-d tree, or a geohash/quadkey bucket — and
turn this O(N) scan into an O(log N) descent or an O(1) bucket probe.

```
  Comparison — the scan vs. the spatial index it lacks

  TODAY (no index)                  WITH a k-d tree / R-tree
  ┌──────────────────────────┐      ┌──────────────────────────┐
  │ for each of N nodes:     │      │ descend tree by lat/lng  │
  │   compute haversine      │      │ prune half-planes        │
  │   track best             │      │ check O(log N) nodes     │
  │ → O(N) every tap         │      │ → O(log N) every tap     │
  └──────────────────────────┘      └──────────────────────────┘
   1750 haversines per tap           ~11 comparisons per tap
```

### Move 2.5 — current vs. future (why the gap is fine *now*)

```
  Phase A (now)                     Phase B (graph grows)
  ┌─────────────────────────┐       ┌──────────────────────────┐
  │ N ≈ 1750 nodes          │       │ N ≈ 100k+ nodes (a city) │
  │ O(N) scan = ~1750 ops   │       │ O(N) scan = 100k+ ops    │
  │ runs twice per route    │       │ runs on every map tap    │
  │ → sub-millisecond       │       │ → visible UI jank        │
  │ VERDICT: leave it       │       │ VERDICT: build a k-d tree│
  └─────────────────────────┘       └──────────────────────────┘
```

What *doesn't* change: the rest of the router. The spatial index would only
front `nearestNode` — A*, adjacency, cost all stay. You'd build the tree
once at `loadGraph` time from the same `nodes` and swap the scan for a
descent. Small, contained change. That's why shipping the scan now is
correct: the cost to add the index later is one new module, not a rewrite.

### Move 3 — the principle

An index is a **bet that you'll read by this key more than you'll pay to
maintain it.** flattr won the bet on `nodes` and `adjacency` (read
constantly, built once, never invalidated because the graph is immutable)
and *declined* the bet on coordinates (read twice per route — not worth the
structure at 1750 nodes). The immutability is the cheat code: flattr's
indexes never need maintenance because the data never changes. A real
database pays index upkeep on every write; flattr pays it never.

## Primary diagram

```
  flattr's index inventory

  ┌─ the in-memory Graph ───────────────────────────────────────┐
  │                                                             │
  │  PRIMARY (hash on id)     nodes: Record<id,Node>            │
  │    graph.nodes[id]  ──────────────────────────► O(1) ✓      │
  │                                                             │
  │  SECONDARY (adjacency list)  adjacency: id→edgeId[]         │
  │    graph.adjacency[node] ─────────────────────► O(1) ✓      │
  │    built by buildAdjacency() once, never invalidated        │
  │    → THE load-bearing index: makes A* near-linear           │
  │                                                             │
  │  MATERIALIZED (per-query)  indexEdges → Map<id,Edge>        │
  │    built once per search, O(E), then O(1) per edge ✓        │
  │                                                             │
  │  MISSING  spatial (lat/lng → nearest node)                  │
  │    nearestNode scans all nodes ───────────────► O(N) ✗      │
  │    fix: k-d tree / R-tree built at load → O(log N)          │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The **B-tree** doesn't appear in flattr because no query needs ordered/range
access — every lookup is exact-match by id, where a hash wins. B-trees earn
their place when you query *ranges* ("all edges with grade between 4% and
8%") or need sorted iteration; flattr never does. The **spatial index** is
the one flattr genuinely wants. The canonical structures: a k-d tree (binary
space partitioning, simplest to hand-roll given Rein's BST/heap background —
it's a BST that alternates split axes), an R-tree (bounding-box hierarchy,
what PostGIS uses), or geohashing (encode lat/lng to a sortable string, then
it's a prefix scan on a B-tree). For 1750 static nodes, a k-d tree built
once is the natural fit and maps directly onto the BST code already in the
reincodes repo.

## Interview defense

**Q: What makes A* fast in flattr — the heap or something else?**
The heap (`pqueue.ts`) orders the frontier, but the thing that keeps each
expansion O(1) is the **adjacency secondary index**. `graph.adjacency[node]`
is a hash lookup returning the node's incident edge ids; without it, finding
a node's neighbors would be an O(E) filter over all edges, making the search
quadratic. It's the most load-bearing index in the repo, and it's free to
maintain because the graph is immutable.

```
  adjacency[node] → [edgeIds]   O(1)   ← the index that makes A* work
  (built once in buildAdjacency, never invalidated)
```
*Anchor: the adjacency list is a covering secondary index for A*'s one
hot query.*

**Q: Where's flattr missing an index, and what would you build?**
`nearestNode` (`nearest.ts:5-18`) — it scans all nodes computing haversine to
snap a tap to a node, O(N) per tap, no spatial index. At 1750 nodes it's
sub-millisecond, so it's the right call now. At city scale I'd build a k-d
tree once at load time (it's a BST alternating split axes) and turn the scan
into an O(log N) descent. Contained change — only `nearestNode` is touched.
*Anchor: the missing index is spatial; a k-d tree at load time is the fix,
and nothing else moves.*

## See also

- `04-query-planning-and-execution.md` — A* as the query operator that
  *uses* these indexes.
- `02-records-pages-and-storage-layout.md` — why nodes are keyed and edges
  are an array.
- `09-database-systems-red-flags-audit.md` — the spatial-index gap, ranked #1.
