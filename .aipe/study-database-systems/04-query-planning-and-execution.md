# Query planning and execution

**Industry name(s):** query optimizer / execution plan / EXPLAIN / scan & join
operators / N+1 · **Type:** Industry standard.

## Zoom out, then zoom in

A query in flattr isn't SQL — it's a hand-written algorithm. But it still *does*
everything a query engine does (pick an access path, scan or look up, combine
records), just with the plan hard-coded by a human instead of chosen by an
optimizer. That makes flattr a clean place to see what a planner is *for*.

```
  Zoom out — execution sits above indexes, below the UI

  ┌─ UI layer (mobile/) ─────────────────────────────────────┐
  │  tap endpoints → request a route                         │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Execution layer ──────────▼─────────────────────────────┐
  │  ★ astar.search() — the "query"  ·  nearestNode scan ★    │ ← we are here
  │  ★ mergeGraphs — the "join"  (useTileGraph) ★             │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Index / storage layer ────▼─────────────────────────────┐
  │  adjacency · nodes · edges                               │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. A query engine takes a *declarative* request ("the cheapest path from A
to B") and produces an *execution plan* — a tree of physical operators (scans,
index lookups, joins, sorts) — then runs it. flattr skips the declarative front
end entirely: the "plan" is the code in `astar.ts`. The lesson is to read that
hand-rolled plan *as if it were an EXPLAIN output* — because that's the skill
that lets you read a real one.

## The structure pass

**Layers** (by plan altitude):
1. **The request** — "route A→B under userMax" / "node nearest this tap."
2. **The plan** — hard-coded: A* with a chosen cost+heuristic; or a full scan.
3. **The operators** — index lookup (adjacency), record fetch (byId), priority
   pop (the heap), distance compute.

**Axis traced — "who decides the access path: a planner, or the programmer?"**

```
  axis — "who chose this access path?" — across the layers

  ┌─ Postgres (reference) ──────────────────┐
  │  planner decides at runtime              │  CODE declares WHAT, planner picks HOW
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (no planner in flattr)
  ┌─ flattr routing ───▼─────────────────────┐
  │  programmer decided, compile-time         │  the HOW is written by hand in astar.ts
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (within flattr, two different hand-plans)
  ┌─ flattr nearest ───▼─────────────────────┐
  │  programmer chose a full scan (no index)  │  no plan choice possible — no index exists
  └───────────────────────────────────────────┘
```

The axis-answer flips at the planner seam: a real DB picks the access path *at
runtime* based on statistics (table size, index selectivity); flattr's path is
fixed in source. That's the whole reason flattr has no `EXPLAIN` — there's nothing
to explain, the plan is the code. But you can still *write the EXPLAIN by hand*,
and doing so is the exercise of this file.

## How it works

### Move 1 — the mental model

You know how A* works — `me.md` says you built Dijkstra's animation with your own
priority queue. Here's the reframe: **A* is a query execution plan.** "Find the
cheapest path" is the declarative query; the heap + adjacency walk + closed set
is the physical plan that answers it. Read it that way and every operator maps to
a database operator.

```
  the pattern — flattr's "query plan" for a route (read like EXPLAIN)

  Route(A→B, userMax)
   └─ A* Search                          [cost: f = g + h]
       ├─ Priority Pop      (heap)       → next cheapest frontier node
       ├─ Index Lookup      (adjacency)  → edges of current node      O(1)
       │   └─ Record Fetch  (byId)       → resolve edgeId→Edge        O(1)
       ├─ Cost Eval         (cost.ts)    → grade penalty per edge
       └─ Relax + Push      (heap)       → enqueue improved neighbors
```

Each line is a physical operator. The heap is a *sort/top-N* operator. `adjacency`
is an *index scan*. `byId` is an *index-only fetch*. `cost.ts` is a *projection /
computed column*. The closed set is *deduplication*. That's a complete plan tree.

### Move 2 — reading the plan operators

**Operator 1 — the heap as Top-N / Sort.** A* always expands the cheapest
frontier node next. That "give me the current minimum" is a Top-N operator,
implemented by the binary min-heap (`features/routing/pqueue.ts`). The pop:

```ts
// features/routing/astar.ts:49-51 — the Top-N operator
const current = open.pop()!;            // line 49: pull cheapest frontier node
pops++;
if (closed.has(current)) continue;      // line 51: skip stale entries (dedup)
```

Line 49 is the sort operator producing rows in cost order; line 51 is the
**lazy-deletion** trick — instead of removing stale heap entries (expensive),
push duplicates and skip them on pop. A real engine's sort doesn't do this, but
the closed-set check is the same idea as a `DISTINCT` filter dropping rows already
seen.

**Operator 2 — the index scan + record fetch (the join).** The expansion loop is
a nested-loop join between "the current node" and "its edges," resolved through
two indexes:

```ts
// features/routing/astar.ts:64-65 — index scan then record fetch
for (const edgeId of graph.adjacency[current] ?? []) {  // INDEX SCAN: node→edgeIds, O(1)
  const edge = byId.get(edgeId)!;                        // RECORD FETCH: edgeId→Edge, O(1)
```

This is exactly a planner's `Index Scan → Index Lookup` pair. Because both are
indexed (`03`), this join is O(degree) per node — cheap. If `adjacency` didn't
exist, the planner's only option would be a `Seq Scan` of all edges per node: the
N+1 disaster (below).

**Operator 3 — the projection (computed cost).** `cost.ts`'s `penalty()` is a
computed column evaluated per edge during the scan:

```ts
// features/routing/astar.ts:68 — projection / computed column per row
const tentative = g.get(current)! + costFn(edge, current, userMax);
```

`costFn` (one of `distanceCost` / `gradeCostAbs` / `gradeCostDirected`,
`cost.ts:25-33`) is computed on the fly — flattr never stores routing cost, it
derives it per query from `userMax`. That's a *computed projection*, the reason
the same graph answers different route queries for different `userMax` without
re-indexing. The plan is *parameterized by the query*, just like a prepared
statement with a bind variable.

**Operator 4 — the unplanned full scan.** `nearestNode` is the one query with no
plan choice, because there's no index to plan around:

```
  EXPLAIN (by hand) — nearestNode("tap at lat,lng")

  Limit (1)
   └─ Sort  (by haversine distance)        ← keeps running min, not a full sort
       └─ Seq Scan on nodes  (rows=1621)   ← reads EVERY node, no filter
          (no index available → no Index Scan possible)
```

`nearest.ts:8` is a `Seq Scan` feeding a top-1. A planner facing this query with
no spatial index would emit exactly this plan and you'd see `Seq Scan` in the
output — the universal "you're missing an index" smell. `03` covers the fix.

**The N+1 it avoids.** N+1 is the classic execution anti-pattern: a query per
row instead of one query for all rows (loop over orders, query each order's
items). flattr's *avoided* N+1 is the adjacency index: without it, A* would, for
each of N expanded nodes, scan all E edges to find incident ones — N separate
O(E) scans, the textbook N+1. The adjacency index collapses that to one O(1)
lookup per node. **Inference:** the per-search `indexEdges` rebuild (`astar.ts:11`)
is a *mild* version of the same smell — it does an O(E) pass every query that
could be done once at load; for the MVP it's cheap, but it's the seed of an N+1 if
searches get frequent (red-flag #5).

**The "join" in the data layer — mergeGraphs.** There's a second query-shaped
operation: `useTileGraph.ts:132-145` joins the base graph with viewport and
corridor sub-graphs into one merged `Graph`, then `stitchGraph` unifies coincident
boundary nodes. That's a **union + dedup-merge** executed in RAM on every relevant
state change:

```
  the merge "query" (useTileGraph.ts:132)

  base graph ──┐
  corridor ────┼──► mergeGraphs (UNION) ──► stitchGraph (dedup boundary nodes) ──► merged Graph
  viewport ────┘
       run on EVERY [baseGraph, corridor, view] change — no memo of the result
```

It's recomputed from scratch each time (the `useMemo` deps are the three
sub-graphs, so any change re-runs the whole stitch). That's a *materialized view
with no caching* — flattr re-executes the join rather than incrementally
maintaining it. Fine for three small inputs; the place to watch if tiles
multiply (red-flag #5).

### Move 3 — the principle

A query plan is the *separation of "what you want" from "how to get it."* A real
optimizer makes that choice at runtime from statistics; flattr makes it at
authoring time in code. Either way the operators are the same — scan, index
lookup, join, sort, project — and reading any system's data access *as a plan tree*
is what lets you spot the missing index (a Seq Scan where an Index Scan belongs)
and the N+1 (a query inside a loop). flattr's A* is a hand-written plan with every
operator visible; learn to read it and you can read EXPLAIN.

## Primary diagram

```
  flattr's two "query plans" side by side

  ┌─ ROUTE query (well-planned) ──────────┐  ┌─ NEAREST query (unplanned) ──┐
  │ Route(A→B, userMax)                   │  │ Nearest(tap)                 │
  │  └ A* Search [f=g+h]                  │  │  └ Limit 1                   │
  │     ├ Top-N Pop      heap   O(log V)  │  │     └ Sort by distance       │
  │     ├ Index Scan     adjacency O(1)   │  │        └ Seq Scan nodes      │
  │     ├ Record Fetch   byId    O(1)     │  │           rows=1621  O(N)    │
  │     ├ Projection     cost.ts          │  │  ✗ no index → no Index Scan  │
  │     └ Relax+Push     heap             │  └──────────────────────────────┘
  └───────────────────────────────────────┘
       declarative-equiv: "cheapest path"      declarative-equiv: "ORDER BY
       — every operator indexed                 dist LIMIT 1" — full scan
```

## Elaborate

The reason real databases have a *cost-based* optimizer is that the right plan
depends on data the programmer can't know at authoring time: how big the table is
*today*, how selective a `WHERE` clause is *for these values*, whether an index is
in cache. The planner re-decides per execution using collected statistics
(`ANALYZE`). flattr's data is tiny and fixed, so a hand-chosen plan is optimal and
a planner would be pure overhead — the right call. The skill the planner
automates (pick access path by selectivity) is the same skill you used by hand
when you decided to build `adjacency` instead of scanning edges.

When flattr migrates to Postgres (spec §8), routing likely stays a hand-written
graph algorithm (it's not expressible as cheap SQL), but `nearestNode` becomes a
planned spatial query and you'll read its plan in real `EXPLAIN ANALYZE` output —
where `Seq Scan on nodes` vs `Index Scan using nodes_geom_idx` is the difference
this file is teaching you to see.

## Interview defense

**Q: "flattr has no SQL. So what does 'query execution' even mean here?"**

> The query is the algorithm. A* is an execution plan for "cheapest path": the
> heap is a Top-N/sort operator, `adjacency` is an index scan, `byId` is a record
> fetch, `cost.ts` is a computed projection, the closed set is dedup. Reading it
> as a plan tree is exactly how you'd read an EXPLAIN — and it shows the route
> query is fully indexed while `nearestNode` is a Seq Scan with no index.

```
  A* = plan tree:  Sort(heap) → IndexScan(adj) → Fetch(byId) → Project(cost)
```

Anchor: *every data access is a plan tree whether or not a planner wrote it —
A* is a hand-rolled EXPLAIN.*

**Q: "Is there an N+1 in flattr?"**

> The big one is *avoided* by design: `adjacency` turns "scan all edges per node"
> into one O(1) lookup per node. The mild one that remains is `indexEdges`
> rebuilding the edge index on every search (`astar.ts:11`) — an O(E) pass per
> query that could be hoisted to load time. Negligible now; the first thing to
> fix if routing gets called in a tight loop.

Anchor: *N+1 is a query inside a loop; flattr killed the routing N+1 with the
adjacency index and left a small per-search index rebuild as the residue.*

## See also

- `03-btree-hash-and-secondary-indexes.md` — the indexes these operators ride
- `02-records-pages-and-storage-layout.md` — why byId must be built over the array
- `../study-dsa-foundations/` — A*, the heap, traversal as algorithms
- `../study-performance-engineering/` — measuring the scan and the merge cost
- `../study-system-design/` — the merged-graph materialized view in context
