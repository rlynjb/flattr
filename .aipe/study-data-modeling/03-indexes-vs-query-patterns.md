# Indexes vs Query Patterns

**Industry name(s):** access-path indexing / covering index vs full scan / the
N+1 query pattern. **Type:** Industry standard (the core data-modeling tradeoff).

---

## Zoom out, then zoom in

The whole game of indexing is matching the index to the query. A `WHERE
user_id = ?` with an index on `user_id` is a seek; without it, a full table
scan. flattr has three distinct queries against the graph, and exactly one of
them has a matching index. Here's where the queries fire.

```
  Zoom out — three queries, one matching index

  ┌─ Read layer (mobile/, runs on every interaction) ──────────────┐
  │                                                                │
  │  tap a coordinate ──► nearestNode  ── O(N) scan, NO index      │ ← miss
  │  run a route      ──► A* expansion ── O(1) via adjacency       │ ← HIT (★)
  │  show the summary ──► edgeById ×path ── O(E) find, N+1 shape    │ ← miss
  │                                                                │
  └─────────────────────────────────────┬──────────────────────────┘
                                         │ all against the same Graph
  ┌─ Storage ─────────────────────────────▼────────────────────────┐
  │  nodes: Record (hash idx)  ·  edges: Edge[] (no idx)  ·         │
  │  adjacency: Record (the ★ index that fits A*)                  │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *which queries does the schema's indexing serve, and
which fall back to a scan?* `adjacency` is purpose-built for A* and nails it.
`nearestNode` and `edgeById` have no index and pay for it — one O(N) per tap,
one O(E) per route edge.

---

## The structure pass

**Layers.** Two altitudes of access: the *index* the schema provides
(`adjacency`, `nodes` Record) and the *query* the code runs against it.

**Axis — "is this query O(1)/O(log) or O(N)/O(E)?"** Trace the cost class
across the three queries:

```
  One question across the queries: does an index serve it?

  ┌─ A* neighbor expansion ────────┐  adjacency[current] → O(1)   ✓ indexed
  └────────────────┬───────────────┘
  ┌─ nearestNode(point) ───────────┐  scan all 1621 nodes → O(N)  ✗ no spatial index
  └────────────────┬───────────────┘
  ┌─ edgeById(id) ×path ───────────┐  edges.find() → O(E), looped → N+1  ✗ no id index reused
  └────────────────────────────────┘

  the cost class FLIPS from O(1) to O(N)/O(E) at the un-indexed queries
```

**Seam.** The load-bearing boundary is **the read path vs A***. A* built itself
an id→edge `Map` (`indexEdges`, `astar.ts:12`) so its own lookups are O(1) — but
that `Map` is local to one search and never reused, so the *display* read path
(`summary.ts`, `geojson.ts`) falls back to O(E) `edgeById`. The same index
exists on one side of this seam and not the other. That asymmetry is the
finding.

---

## How it works

### Move 1 — the mental model

An index is a question you've pre-answered. `nodes: Record<id, Node>` pre-answers
"give me the node with id X" — O(1). `adjacency: Record<nodeId, edgeId[]>`
pre-answers "give me the edges touching node X" — O(1). The queries that *have* a
pre-answered question fly; the queries that don't (`nearestNode`'s "which node is
closest to this point", `edgeById`'s "which edge has this id" against the flat
array) scan.

```
  The kernel: a query is fast iff its question is pre-answered by an index

  query                         pre-answered by          cost
  ─────                         ───────────────          ────
  node by id                    nodes Record             O(1)  ✓
  edges touching node           adjacency Record         O(1)  ✓
  node nearest a point          — nothing —              O(N)  ✗
  edge by id (against edges[])  — nothing reused —        O(E)  ✗
```

### Move 2 — the walkthrough

**The HIT: `adjacency` serves A* expansion.** This is the query the schema was
shaped for. A*'s inner loop asks "what are `current`'s neighbors?" once per
expanded node:

```ts
// features/routing/astar.ts:62-75 (inner loop, trimmed)
for (const edgeId of graph.adjacency[current] ?? []) {  // ← O(1) index lookup
  const edge = byId.get(edgeId)!;                        // ← O(1) via indexEdges Map
  const next = otherEnd(edge, current);
  if (closed.has(next)) continue;
  const tentative = g.get(current)! + costFn(edge, current, userMax);
  if (tentative < (g.get(next) ?? Infinity)) { /* relax */ }
}
```

Two indexes stacked: `graph.adjacency[current]` (O(1), get the edge-ids) then
`byId.get(edgeId)` (O(1), resolve each id to its `Edge`). `byId` comes from
`indexEdges`:

```ts
// features/routing/astar.ts:11-16
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);  // build id→edge ONCE per search
  return m;
}
```

The comment on line 11 says it outright: *"Build an id→edge index once, so
expansions are O(1) per edge, not O(E)."* This is exactly right — without it,
each of the thousands of edge resolutions during a search would be an
`edges.find()` scan. A* is the place the data model's indexing earns its design.

```
  A* expansion — two O(1) index hits per neighbor

  current ──► adjacency[current] ──► ["e7","e12","e30"]   (O(1))
                                          │ for each
                                          ▼
                                     byId.get("e7") ──► Edge   (O(1))
  drop indexEdges and this inner resolve becomes O(E) — A* falls a complexity class
```

**The MISS: `nearestNode` is an O(N) full scan.** Every time you tap the map to
set a start or goal, the coordinate has to snap to a graph node — and that's a
linear scan of all 1621 nodes:

```ts
// features/routing/nearest.ts:5-18
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {     // ← visits EVERY node
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });  // haversine per node
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

This is a `WHERE` with no index — a spatial nearest-neighbor query answered by
visiting every row. At 1621 nodes it's fine (sub-millisecond), but it's the one
query the schema has no answer for. The missing index is **spatial** — a grid
bucket keyed by `tileKeyOf(lng,lat)` (which already exists in `tiles.ts:10-12`!)
or a k-d tree over `(lat,lng)` would turn this into an O(1)/O(log N) seek over a
handful of candidate nodes. As the merged graph grows (the tiling in
`useTileGraph` can stack many regions), this O(N) is the first thing that bites.

```
  nearestNode — the un-indexed spatial query

  tap (lat,lng) ──► scan ALL nodes, haversine each ──► argmin   O(N)
                         │ N grows with every merged tile
                         ▼
  with a grid index (tileKeyOf already exists):
  tap ──► bucket = tileKeyOf(lng,lat) ──► check ~9 cells' nodes  O(1)
```

**The MISS: `edgeById` is O(E) and called in a loop (N+1 shape).** The display
read path resolves each route edge by id — but against the flat `edges` array,
with `find`:

```ts
// features/routing/graph.ts:3-7
export function edgeById(graph: Graph, edgeId: string): Edge {
  const edge = graph.edges.find((e) => e.id === edgeId);  // ← O(E) linear scan
  if (!edge) throw new Error(`edgeById: no edge with id "${edgeId}"`);
  return edge;
}
```

On its own, one O(E) lookup is cheap. The problem is *where it's called* — once
per edge of a route, inside a loop:

```ts
// features/routing/summary.ts:13-14 — once per path edge
for (let i = 0; i < path.edges.length; i++) {
  const edge = edgeById(graph, path.edges[i]);  // ← O(E) inside an O(path) loop
// features/map/geojson.ts:52-54 — same shape, route coloring
const features = path.edges.map((edgeId, i) => {
  const edge = edgeById(graph, edgeId);         // ← O(E) per edge
```

That's the N+1 pattern: a loop over `path.edges` (N) each issuing an O(E)
lookup. Total cost O(path · E). The fix already exists in the codebase — A*'s
`indexEdges` builds exactly the `Map<id, Edge>` that would make this O(1) — it's
just not reused by the read path. Build the index once, pass it in (or memoize
it on the graph), and `summarizePath`/`routeToGeoJSON` go from O(path·E) to
O(path).

```
  edgeById — the N+1 in the read path

  routeSummary / routeToGeoJSON:
    for each of path.edges (N):  edgeById → edges.find → O(E)
                                              ▲
                                              └ A* already solved this with
                                                indexEdges (Map<id,Edge>),
                                                but the read path doesn't reuse it
    → O(path · E)   should be O(path)
```

### Move 2 variant — the load-bearing skeleton

The kernel of "indexing vs query" here: **for each query, name the index that
serves it or name the scan that doesn't.**

- *Remove `adjacency`* → A* expansion becomes an O(E) edge filter per node →
  A* drops from near-linear to quadratic-ish; routing on the merged graph
  stalls. Load-bearing.
- *Remove `indexEdges`* → A*'s inner edge-resolve becomes O(E) → same blowup,
  inside the search loop. Load-bearing.
- *Add a spatial index* → `nearestNode` goes O(N) → O(1). Hardening (not yet
  present; the hot tap path silently pays O(N) today).
- *Reuse `indexEdges` in the read path* → `edgeById` loops go O(path·E) →
  O(path). Hardening (the N+1 is real but currently cheap at 1879 edges).

The skeleton is "adjacency + indexEdges = the two indexes A* needs." The
hardening that's *missing* is "a spatial index for nearestNode and a reused
id-index for the display path."

### Move 3 — the principle

Index the queries you actually run, and reuse the index you already built. A*'s
two indexes are textbook-correct. The two misses are both about an index that's
*absent* (spatial) or *present-but-not-reused* (`indexEdges` vs `edgeById`).
The general lesson: an N+1 isn't a database-only sin — any loop that re-issues
an O(E) lookup per iteration is one, and the fix is always "hoist the index out
of the loop."

---

## Primary diagram

The three queries, their cost classes, and the two available-but-unused fixes.

```
  Queries vs indexes — hits, misses, and the fixes already in the repo

  QUERY                    INDEX USED              COST       FIX
  ─────                    ──────────              ────       ───
  node by id               nodes Record (hash)     O(1)  ✓    —
  A* neighbor expansion    adjacency Record        O(1)  ✓    —
  A* edge resolve          indexEdges Map          O(1)  ✓    —  (astar.ts:12)
  ──────────────────────────────────────────────────────────────────
  nearestNode(point)       — none —                O(N)  ✗    grid via tileKeyOf
                                                              (tiles.ts:10 exists)
  edgeById in a loop       — none reused —          O(E)/iter ✗   reuse indexEdges
   (summary.ts, geojson.ts)                         = N+1         in the read path
```

---

## Elaborate

The N+1 is the most-cited data-access anti-pattern (ORMs ship lazy-loading
guards specifically to catch it), and it shows up here without a database at
all — proof that it's a *query-shape* problem, not an ORM problem. The
`nearestNode` scan is the classic "spatial query with no spatial index"; the
production answer is a grid, R-tree, or k-d tree, and flattr already has the
grid primitive (`tileKeyOf`) sitting unused for this purpose. Both fixes are
small because the indexes either exist (`indexEdges`) or are one helper away
(`tileKeyOf` bucketing).

Cross-link: the *latency* consequence of these scans is `study-performance-
engineering`; the *algorithm* (A* itself, the heap) is `study-dsa-foundations`.

---

## Interview defense

**Q: Where's the N+1 in a codebase with no database?**
`edgeById` (`graph.ts:3`) is an O(E) `edges.find()`, and the route read path
calls it once per path edge — `summary.ts:14` and `geojson.ts:54` both loop
`path.edges` issuing one O(E) lookup each. That's O(path·E). It's an N+1 in
shape even though it's a flat array, not a SQL table. The fix is in the repo
already: A*'s `indexEdges` (`astar.ts:12`) builds the `Map<id,Edge>` that makes
it O(1) — the read path just doesn't reuse it.

```
  loop over path.edges (N) × edges.find() (O(E)) = N+1
  fix: hoist a Map<id,Edge> out of the loop → O(path)
```
Anchor: "an N+1 is any per-row re-issued O(E) lookup — and A* already built the
index that fixes it."

**Q: What's the missing index, and why hasn't it bitten yet?**
A spatial index for `nearestNode` (`nearest.ts:8`), which scans all 1621 nodes
per tap. It hasn't bitten because 1621 nodes is sub-millisecond. It *will* bite
as `useTileGraph` merges more regions and N climbs — and the grid primitive
(`tileKeyOf`, `tiles.ts:10`) already exists to bucket nodes into ~9 candidate
cells.
Anchor: "the hot tap path is an un-indexed spatial scan; the grid index to fix
it already exists for tiling."

---

## See also

- `02-derived-and-denormalized-fields.md` — why `adjacency` is stored (it's *this* index)
- `01-graph-as-entity-model.md` — `nodes` Record as the hash index that *does* fit
- `05-tile-prefixing-and-id-namespacing.md` — how merging grows N and pressures `nearestNode`
- `study-performance-engineering` — the O(N)/O(E) scans as latency budget
- `study-dsa-foundations` — A*, the binary heap, adjacency as an algorithms primitive
