# Missing indexes and scans

**Industry name:** missing index on a hot path; the per-edge `edgeById` case is the
N+1 query pattern (a scan inside a per-row loop). **Type label:** Industry standard
(both anti-patterns), Language-agnostic.

---

## Zoom out, then zoom in

A database gives you an index for free: declare a primary key, and lookups by it are
O(log n), not O(n). flattr has no database, so it only has the indexes it built by
hand — and it built one (adjacency) and skipped two. Here's where the scans live:

```
  Zoom out — the read paths and their cost

  ┌─ UI: tap to route ────────────────────────────────────────┐
  │  tap point → nearestNode() → snap to a graph node          │ ← O(N) scan
  └───────────────────────────┬────────────────────────────────┘
                              │  startId, goalId
  ┌─ Routing: A* ─────────────▼────────────────────────────────┐
  │  search() — uses adjacency (O(1)) + indexEdges Map (O(1))   │ ← INDEXED, good
  └───────────────────────────┬────────────────────────────────┘
                              │  Path (node + edge ids)
  ┌─ Render: summary + GeoJSON ▼───────────────────────────────┐
  │  for each path edge: edgeById() = edges.find()              │ ← O(path × E)
  └────────────────────────────────────────────────────────────┘
```

Zoom in: two of these three paths scan when they shouldn't. `nearestNode` has no
spatial index; `summary`/`geojson` use `edgeById` (an O(E) `find`) inside a per-edge
loop — and the codebase *already knows the fix*, because A\* itself builds an edge
index (`indexEdges`) and just doesn't share it. The question: **which reads have an
index, which don't, and which missing one bites first?**

## Structure pass

**Layers — the model's indexes, by what they support:**

```
  What's indexed vs what scans

  ┌─ node lookup by id ────────┐  graph.nodes[id]     → O(1)  ✓ free (map key)
  ┌─ neighbor edges of a node ─┐  graph.adjacency[id] → O(1)  ✓ built (02)
  ┌─ edge lookup by id ────────┐  edges.find(...)     → O(E)  ✗ missing
  ┌─ nearest node to a coord ──┐  scan all nodes      → O(N)  ✗ missing (spatial)
```

**Axis traced — "is the access by a key the structure indexes, or does it scan?"**
Hold it across the four reads. Node-by-id and neighbors-of-node both hit a structure
keyed exactly the way they ask → O(1). Edge-by-id asks for a key (`id`) that the
`edges` *array* isn't keyed by → O(E) scan. Nearest-node-to-coordinate asks a
*spatial* question (proximity) that no structure indexes → O(N) scan. The axis-answer
flips at the boundary between "keyed lookup the structure supports" and "lookup the
structure can't answer without walking everything."

**Seams:** two. (1) `edges` array vs the id-keyed access it receives — a missing
hash index. (2) coordinate-space proximity vs the flat node map — a missing spatial
index. Both are places the model's container doesn't match its access. Those two
mismatches are this whole file.

## How it works

### Move 1 — the mental model

You've felt both of these in frontend. The `edgeById` one: you've got an array of
items and a component that, for each row, calls `.find()` on that array to resolve a
related item — and the list janks because it's O(rows × items). The fix you reach for
is a `Map` built once. The `nearestNode` one: you've got a list of points and you
need the closest to the cursor, so you loop them all computing distance — fine for 50
points, a problem for 50,000, and the real fix is a spatial structure (a grid bucket,
a quadtree). flattr has the array-find problem and the closest-point problem, and has
solved neither on the shipped graph.

```
  the two anti-patterns, shaped

  N+1 / scan-per-row:                 missing spatial index:
  for each path edge:                 for each of N nodes:
    edges.find(id)  ◄─ O(E) each        haversine(point, node)  ◄─ all of them
  total: O(path × E)                  total: O(N) every tap
```

The strategy both want: **build the index the access pattern asks for, once, and
reuse it — instead of re-deriving the answer on every call.**

### Move 2 — the walkthrough

#### `nearestNode` — O(N) scan, no spatial index

Every route starts by snapping the tapped start and goal coordinates to graph nodes.
That snap walks every node:

```ts
// features/routing/nearest.ts:5-18
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {   // ALL 1621 nodes, every call
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });  // a haversine each
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  ...
}
```

At 1621 nodes this is sub-millisecond — invisible. But it's O(N) and runs twice per
route (start + goal), and the node count grows with coverage: the moment
`useTileGraph` merges a viewport-plus-corridor of central Seattle, N is tens of
thousands, and the scan is the most expensive part of issuing a route. There's no
spatial index — no grid bucketing, no k-d tree — even though the model already has a
natural spatial key it uses elsewhere: `tiles.ts` floors coordinates into a grid
(`tileKeyOf`, `tiles.ts:10-12`), and `zones.ts` buckets edges into grid cells. The
same grid would turn `nearestNode` into "find the point's cell, search that cell and
its 8 neighbors" — O(1) expected.

```
  nearestNode: now vs with a grid index

  NOW:   point ──► scan all N nodes, haversine each ──► min     O(N)
  GRID:  point ──► tileKeyOf(point) ──► search 9 cells ──► min  O(1) expected
                   (the grid already exists in tiles.ts)
```

#### `edgeById` — O(E) find, called once per path edge

This is the sharper one because it's an N+1 in shape. `edgeById` is a linear scan:

```ts
// features/routing/graph.ts:3-7
export function edgeById(graph: Graph, edgeId: string): Edge {
  const edge = graph.edges.find((e) => e.id === edgeId);  // O(E) — full array scan
  if (!edge) throw new Error(`edgeById: no edge with id "${edgeId}"`);
  return edge;
}
```

And it's called *inside a per-edge loop* in both render paths:

```ts
// features/routing/summary.ts:13-14  — once per edge in the route
for (let i = 0; i < path.edges.length; i++) {
  const edge = edgeById(graph, path.edges[i]);   // O(E) inside an O(path) loop
  ...
}
```

```ts
// features/map/geojson.ts:53  — same shape, rebuilding the route's GeoJSON
const edge = edgeById(graph, edgeId);            // O(E) per edge again
```

So summarizing a 40-edge route over a 1879-edge graph is ~75,000 comparisons; doing
it again for GeoJSON doubles it. That's the N+1: one full scan per row of the result
set. The total is O(path × E) where it could be O(path).

**The codebase already has the fix — it just doesn't reuse it.** A\* builds exactly
the index these paths need:

```ts
// features/routing/astar.ts:11-16
/** Build an id->edge index once, so expansions are O(1) per edge, not O(E). */
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);
  return m;
}
```

The comment even names the exact lesson. A\* builds this `Map` once per search and
does O(1) `byId.get(edgeId)` in the hot loop (`astar.ts:65`). `summary.ts` and
`geojson.ts` import `edgeById` instead and pay O(E) per edge. The fix is to thread
the same `Map` into them — or, better, ship the graph with an id→edge index so no
consumer rebuilds it.

```
  edgeById: the inconsistency in the codebase

  astar.ts    ──► indexEdges() Map once ──► byId.get(id)  O(1)   ✓
  summary.ts  ──► edgeById() per edge   ──► edges.find()  O(E)   ✗  same need,
  geojson.ts  ──► edgeById() per edge   ──► edges.find()  O(E)   ✗  different choice
```

#### Why the shipped artifact has no edge index at all

The deeper data-modeling point: `graph.json` stores edges as a plain array
(`edges: Edge[]`), with *no* id→edge map. So every consumer that needs edge-by-id has
to build the index itself (A\* does) or scan (summary/geojson do). A database would
have a primary-key index on the edge table and nobody would think about it. Here the
index is a runtime artifact each caller rebuilds — or skips. Shipping the graph with
the index (or building it once at load in `loadGraph`) would make the whole question
disappear.

### Move 2 variant — the load-bearing skeleton

The kernel of "index a hot read" has three parts. What breaks without each:

1. **A key the reads actually use.** Edge-by-id uses `id`; nearest-node uses spatial
   proximity. Drop this (index by the wrong key) and the index is dead weight —
   present but never hit.
2. **A structure keyed by that key.** A `Map<id, Edge>` for edge-by-id; a grid bucket
   for proximity. Drop this and you scan — exactly today's state.
3. **Build-once, reuse-many.** The index must outlive a single call. A\* builds the
   Map once per *search* (reused across hundreds of expansions). Drop this (rebuild
   per call) and you've moved the cost, not removed it — `edgeById` rebuilds nothing
   and scans every call, which is the worst of both.

Optional hardening: ship the index in the artifact (or build at load) so it's
amortized across the whole app session, not per-search. flattr doesn't — A\* rebuilds
the edge Map every search. Cheap relative to the search, but it's the hardening that's
missing.

### Move 3 — the principle

An index is a denormalization (02) aimed at a *lookup*: you store a second
representation of the data keyed the way a hot read asks, trading build cost and
space for read speed. The failure mode is asymmetric — a missing index is invisible
at demo scale and quadratic at city scale, so it never shows up in the test that
ships and always shows up in the one that matters. The transfer: **for every hot
read, name the key it accesses by and confirm a structure is keyed that way; if it
scans, that's a missing index, even when the scan is currently fast.** And when one
part of the codebase already built the index (A\*'s `indexEdges`) and another scans
(`edgeById`), that's not two problems — it's one fix not propagated.

## Primary diagram

The three reads, their indexes (or lack), and the fix already sitting in the repo.

```
  flattr's reads vs indexes — full picture

  READ                  STRUCTURE IT HITS          COST      INDEX?
  ──────────────────────────────────────────────────────────────────────
  node by id            graph.nodes[id] (map)      O(1)      ✓ free (key)
  neighbors of node     graph.adjacency[id]        O(1)      ✓ built (02)
  ──────────────────────────────────────────────────────────────────────
  edge by id (A*)       indexEdges() Map           O(1)      ✓ built per search
  edge by id (summary)  edges.find()  ◄─────┐      O(E)      ✗ scans
  edge by id (geojson)  edges.find()  ◄─────┤      O(E)      ✗ scans
                                            │
                        same need ──────────┘  fix: reuse the A* Map,
                                               or ship an id→edge index
  ──────────────────────────────────────────────────────────────────────
  nearest node to coord scan all nodes           O(N)      ✗ no spatial index
                        (haversine each)                    fix: tileKeyOf grid
                                                            (already in tiles.ts)
```

## Elaborate

The N+1 pattern got its name in ORMs: one query to fetch N rows, then N more to
fetch each row's relation, because the developer didn't ask for a join. `edgeById`
in a loop is the same shape without an ORM — one "query" (the path) yields N rows
(edges), and each row triggers a full "table scan" to resolve. The spatial-index gap
is the geo equivalent: nearest-neighbor over raw points is O(N), and the standard
fixes (grid hashing, k-d tree, R-tree — what PostGIS's GiST index does) all bucket
space so you only check nearby candidates. flattr already buckets space for two other
features (`tiles.ts`, `zones.ts`), so the grid is sitting right there; `nearestNode`
just doesn't use it.

Read next: `04` — the integrity gaps, including what happens when `edgeById`'s scan
finds nothing and throws.

## Interview defense

**Q: Where's the missing index in this codebase, and how bad is it?**

Two. `nearestNode` (`nearest.ts:5`) is an O(N) scan over all nodes on every route —
no spatial index, even though a coordinate grid already exists in `tiles.ts`. And
`edgeById` (`graph.ts:3`) is an O(E) `edges.find` called *per path edge* in
`summary.ts` and `geojson.ts` — an N+1, O(path × E) total. The sharp part:
`astar.ts` already builds the exact index these need (`indexEdges`, a `Map<id,Edge>`),
uses it for O(1) expansion, and the render paths just don't reuse it. So it's not a
missing capability — it's an existing fix not propagated.

```
  same need, two choices in one repo

  A*:       indexEdges Map  → O(1)   ◄─ the fix
  summary:  edges.find()    → O(E)   ◄─ scans anyway
```

Anchor: *"Two missing indexes — O(N) nearestNode and an O(path×E) edgeById N+1 — and
the edgeById fix already exists in astar.ts's indexEdges, just not reused."*

**Q: It's fast now at 1621 nodes. Why does it matter?**

Because the cost is invisible at demo scale and quadratic at city scale, and the app
grows the graph at runtime — `useTileGraph` merges viewport + corridor regions, so N
goes from 1.6k to tens of thousands. A missing index never shows up in the test that
ships and always shows up in the route that takes a second to snap. The right time to
add the index is before the data grows into it, and the grid to do `nearestNode` is
already in the repo.

Anchor: *"Linear at 1.6k is sub-millisecond; the same code at 40k, twice per route,
is the slow part — and tile-merge grows N at runtime."*

## See also

- `02-adjacency-as-denormalized-index.md` — the index the model *did* build.
- `04-integrity-without-a-database.md` — what `edgeById`'s throw means for integrity.
- `study-performance-engineering` — these as latency findings with budgets.
- `study-dsa-foundations` — your `PriorityQueue.ts` (value→index lookup) is the same
  build-once-reuse-many index move; k-d tree / grid as the spatial structure.
