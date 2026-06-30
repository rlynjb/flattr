# Query planning and execution

**Industry names:** query plan · access path · index scan vs. seq scan ·
operator · N+1 — *type label: Industry standard.*

## Zoom out, then zoom in

flattr has no SQL and no query planner, but it absolutely runs *queries* —
A* is a query, `nearestNode` is a query, and each one picks an access path.
The difference from Postgres is that *you* are the planner: there's no
`EXPLAIN`, you chose the access path by hand when you wrote the code. This
file reads flattr's two real queries as execution plans.

```
  Zoom out — the query layer

  ┌─ UI ────────────────────────────────────────────────────────┐
  │  tap start/end          set userMax         request route   │
  └────────┬──────────────────────────────────────┬─────────────┘
           │ QUERY 1                                │ QUERY 2
           ▼                                        ▼
  ┌─ Query execution (you are the planner) ─────────────────────┐
  │  ★ nearestNode → seq scan (no index) ★                      │ ← we are here
  │  ★ search()/A* → indexed traversal (heap + adjacency) ★     │ ← and here
  └────────┬─────────────────────────────────────────────────────┘
           │ reads
           ▼
  ┌─ Storage — in-memory Graph ─────────────────────────────────┐
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. A query plan is a **tree of operators over access paths**: which
index to use, what order to join, where to sort. flattr's plans are
hand-frozen — `nearestNode` is a sequential scan (no choice, no index),
`search()` is a priority-queue-driven graph traversal joining nodes to edges
through the adjacency index. Reading them as plans tells you exactly where
the cost is and where an N+1 would hide.

## The structure pass

**Layers.** Two query operators sit between the UI and the graph: the
nearest-node scan and the A* traversal. A* internally decomposes into
sub-operators: heap pop → relax edges → push.

**Axis — what access path does this query use?** Trace it:

```
  Axis: "sequential scan or index?" per query

  ┌─ nearestNode ───────────────┐  → SEQ SCAN: visits all N nodes,
  │  no access path on lat/lng  │     no early termination
  └─────────────────────────────┘
  ┌─ A* search ─────────────────┐  → INDEX TRAVERSAL: adjacency index
  │  adjacency + heap order     │     + heap prunes the frontier
  └─────────────────────────────┘
      ┌─ A* inner: edge resolve ┐  → INDEX LOOKUP: indexEdges Map,
      │  byId.get(edgeId)       │     O(1), avoids per-edge scan
      └─────────────────────────┘

  one seq scan, one indexed traversal — the planner (you) chose both
```

**Seam.** The boundary is **bounded vs. unbounded work**. A* is bounded — the
heap + closed set guarantee each node is finalized once, so the plan visits
each reachable node a bounded number of times. `nearestNode` is unbounded by
geometry — it *always* visits all N regardless of how close the answer is.
The seam is where "smart frontier" meets "dumb scan." That contrast is the
file.

## How it works

### Move 1 — the mental model

You've written the two shapes already. `array.find(predicate)` is a
sequential scan — no index, walk till you match (or to the end).
Dijkstra/A* with a priority queue is an indexed best-first traversal — you
keep a frontier ordered by cost and always expand the cheapest. flattr's two
queries are exactly these two shapes, and the cost difference is the whole
lesson.

```
  The two query shapes

  SEQ SCAN (nearestNode)            BEST-FIRST TRAVERSAL (A*)
  ┌──────────────────────┐          ┌──────────────────────────┐
  │ visit node 0         │          │ pop cheapest from heap   │
  │ visit node 1         │          │ if goal → reconstruct    │
  │ visit node 2         │          │ relax neighbors (index)  │
  │  … all N …           │          │ push improved into heap  │
  │ return best          │          │ repeat                   │
  └──────────────────────┘          └──────────────────────────┘
   always O(N)                       bounded by heuristic pruning
```

### Move 2 — the plans, one operator at a time

**Query 1: `nearestNode` — the sequential scan.** Its plan is one operator:
scan all nodes, compute distance, keep the min (`nearest.ts:8-15`). There is
no access path to exploit because there's no spatial index (file `03`), so
the plan has no choice — it's a full scan with no early exit. In Postgres
terms this is `Seq Scan on nodes  (cost=0..N)`. It runs at
`MapScreen.tsx:133-134`, twice per route (start + end).

```
  Execution trace — nearestNode over 4 nodes, point P

  step  node  haversine(P,node)  bestDist  bestId
  ────  ────  ─────────────────  ────────  ──────
   1    n0    120 m              120       n0
   2    n1     90 m               90       n1    ← improved
   3    n2    150 m               90       n1
   4    n3     40 m               40       n3    ← improved
  ────────────────────────────────────────────────
  return n3  — but it checked ALL 4 even though n3 was last
```

The trace shows the cost: no matter where the answer is, every node is
visited. That's the unindexed seq scan's signature — work is proportional to
table size, not to result proximity.

**Query 2: `search()` — the indexed best-first plan.** This is the real
query engine (`astar.ts:22-78`). Its plan is a loop over four operators:

1. **Pop** the cheapest frontier node from the heap (`astar.ts:49`,
   `open.pop()`). The heap is the *sort operator* — it keeps the frontier
   ordered by `g + heuristic` so you always expand the most promising node.

2. **Goal test / lazy-delete** (`astar.ts:50-51`). `if (closed.has(current))
   continue` discards stale heap entries — a **lazy-deletion** trick so the
   heap never needs a decrease-key. This is the operator people forget: the
   heap holds duplicates, and the closed set is what makes them harmless.

3. **Relax neighbors via the adjacency index** (`astar.ts:64-75`). For each
   incident edge (one hash lookup into `adjacency`), resolve the edge
   (`byId.get` — the materialized index), compute tentative cost via
   `costFn`, and if it improves `g[next]`, record it and push.

4. **Reconstruct** on goal hit (`astar.ts:53`, `reconstruct`) — walk
   `came-from` backward. This is the result-projection operator.

```ts
// features/routing/astar.ts:48-75 — the query loop, annotated
while (!open.isEmpty()) {
  const current = open.pop()!;                 // SORT: cheapest frontier node
  pops++;
  if (closed.has(current)) continue;           // lazy-delete stale duplicate
  if (current === goalId) { … return … }       // goal → project result
  closed.add(current);                         // finalize: visited once
  nodesExpanded++;
  for (const edgeId of graph.adjacency[current] ?? []) {  // INDEX SCAN of neighbors
    const edge = byId.get(edgeId)!;            // INDEX LOOKUP edge by id (O(1))
    const next = otherEnd(edge, current);
    if (closed.has(next)) continue;
    const tentative = g.get(current)! + costFn(edge, current, userMax);  // cost expr
    if (tentative < (g.get(next) ?? Infinity)) {   // improves? → relax
      g.set(next, tentative);
      came.set(next, { edge, prev: current });
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  // push
      pushes++;
    }
  }
}
```

**Why this isn't N+1.** The classic N+1 anti-pattern is: run one query to get
N rows, then run one more query *per row* to fetch a related thing. flattr's
A* loop reads neighbors via `adjacency[current]` (one hash probe) and
resolves each edge via `byId.get` (one hash probe) — both O(1), both off
pre-built indexes. If instead each expansion called `edgeById`
(`graph.ts:4`, the O(N) scan) once per neighbor, *that* would be the N+1: a
full-table scan nested inside the per-node loop, turning the search
quadratic. `indexEdges` (`astar.ts:12`) exists specifically to kill that
N+1 by materializing the join index once.

```
  N+1 avoided — the join is indexed, not scanned

  per expanded node:
    adjacency[node]      → O(1) hash   (not a scan)
      per neighbor edge:
        byId.get(edgeId) → O(1) hash   (not edgeById's O(E) scan)

  if byId.get were edgeById → O(E) inside the inner loop = N+1
```

**The plan's own EXPLAIN.** flattr instruments its queries:
`SearchResult` carries `nodesExpanded`, `pushes`, `pops`
(`types.ts:46-51`). That's a hand-rolled `EXPLAIN ANALYZE` — the bench
harness (`bench/`) reads these counters to compare access paths across the
Dijkstra → A* → directional → bidirectional progression. `pops` includes
stale duplicates, so `pops - nodesExpanded` is literally the lazy-deletion
overhead, measurable per run.

### Move 3 — the principle

A query plan is a **choice of access path**, and the cost of a query is
decided the moment that choice is made. flattr makes the choice in code
instead of in a planner: A* gets indexes and a heap (bounded, near-linear);
`nearestNode` gets a seq scan (unbounded, O(N)) because no index exists for
it. When you read someone's query in any system, find the access path first
— it predicts the cost before you measure anything.

## Primary diagram

```
  flattr's two query plans, side by side

  ┌─ QUERY 1: nearestNode ──────────┐  ┌─ QUERY 2: A* search() ──────────┐
  │  Seq Scan on nodes              │  │  Best-First Traversal           │
  │   ┌──────────────────────────┐  │  │   ┌──────────────────────────┐  │
  │   │ for each of N nodes:     │  │  │   │ HEAP pop (sort operator) │  │
  │   │   haversine(P, node)     │  │  │   └────────────┬─────────────┘  │
  │   │   track min              │  │  │   ┌────────────▼─────────────┐  │
  │   └──────────────────────────┘  │  │   │ lazy-delete stale (closed)│ │
  │  cost: O(N), no early exit      │  │   └────────────┬─────────────┘  │
  │  access path: NONE (no index)   │  │   ┌────────────▼─────────────┐  │
  └─────────────────────────────────┘  │   │ relax via adjacency idx  │  │
                                        │   │  byId.get (O(1) join)    │  │
  EXPLAIN counters (types.ts:46-51):    │   └────────────┬─────────────┘  │
   nodesExpanded · pushes · pops        │   ┌────────────▼─────────────┐  │
                                        │   │ push improved → heap     │  │
                                        │   └──────────────────────────┘  │
                                        │  cost: bounded by heuristic     │
                                        └─────────────────────────────────┘
```

## Elaborate

A* *is* a query planner's dream operator: the heuristic is an access-path
optimization that prunes the search space the way an index condition prunes
a scan. The signed-grade `costFn` (`cost.ts`) is the equivalent of a
computed-column predicate baked into the cost expression. The one place
flattr leaves performance on the table is `nearestNode` — and notice it's
the *only* query with no index, which is exactly the query a real planner
would flag as a sequential scan in `EXPLAIN`. The discipline transfers: when
you read a slow Postgres query, the first thing you look for is `Seq Scan`
on a big table — flattr's `nearestNode` is that line.

## Interview defense

**Q: A* in flattr — is it doing an N+1?**
No, and the thing that prevents it is `indexEdges`. The inner loop resolves
each neighbor edge with `byId.get(edgeId)` — an O(1) hash probe into a Map
built once per search (`astar.ts:12`). If it instead called `edgeById`
(`graph.ts:4`, an O(N) array scan) per neighbor, that scan nested inside the
per-node loop would be a textbook N+1 and the search would go quadratic. The
materialized index is exactly the fix you'd apply to an N+1 in SQL — fetch
the related rows once, join in memory.
*Anchor: indexEdges kills the N+1 by materializing the join index once per
query.*

**Q: How do you measure flattr's query plans without EXPLAIN?**
`SearchResult` carries `nodesExpanded`, `pushes`, `pops`
(`types.ts:46-51`) — a hand-rolled `EXPLAIN ANALYZE`. The bench harness
reads them to compare access paths across the algorithm progression. `pops -
nodesExpanded` is the lazy-deletion overhead, directly measurable.
*Anchor: the SearchResult counters ARE flattr's EXPLAIN ANALYZE.*

## See also

- `03-btree-hash-and-secondary-indexes.md` — the indexes these plans read.
- `06-locks-mvcc-and-concurrency-control.md` — why these queries never
  contend (single-threaded, read-only).
- `study-dsa-foundations` — A* and the binary heap as algorithms.
