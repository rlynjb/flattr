# B-tree, hash, and secondary indexes

**Industry name(s):** secondary index / hash index / adjacency list as index ·
**Type:** Industry standard (the concept) realized as a Project-specific
hand-built index

## Zoom out, then zoom in

This is the most interesting database concept in the repo, because flattr
*actually has* an index — `adjacency` — even though it has no database. It's a
hand-built, materialized-at-build secondary index, and it's the single most
load-bearing data structure in the routing engine.

```
  Zoom out — indexes sit between the records and the readers

  ┌─ Storage layer (graph.json) ─────────────────────────────────────┐
  │  nodes: Record<id,Node>   ← PK hash index (built into the map)    │
  │  edges: Edge[]            ← heap file, no built-in index          │
  │  ★ adjacency: Record<id,edgeIds[]> ← THE secondary index ★ ←here  │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ Runtime readers ─────────▼──────────────────────────────────────┐
  │  A* expansion:  adjacency[current] ─► edgeIds ─► byId.get(edgeId) │
  │  indexEdges():  Map<edgeId, Edge>  ← a SECOND index, built per    │
  │                                       search to fix edges' O(E)   │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"given a node, how do you find its neighbors without
scanning all 1879 edges?"* The answer is the same one a DBA gives for "find all
orders for a customer without scanning the orders table" — **build a secondary
index**. flattr builds two: `adjacency` (node → incident edges, materialized in
the artifact) and `indexEdges()` (edge id → edge object, built fresh per search).

## The structure pass

**Layers.** Three index-like structures, at three lifecycles: the PK hash index
(`nodes` map, exists because the map exists), the persistent secondary index
(`adjacency`, built once at build time, shipped in the file), and the transient
hash index (`indexEdges()`, built at the start of each search, thrown away
after).

**The axis: lifecycle — when does the index get built, and how long does it
live?** Trace it:

```
  Axis = "when is this index built / how long does it live?"

  ┌─ nodes map (PK index) ─────────────────────────┐
  │  built: at build time, IS the storage           │  lives: forever (the file)
  └───────────────────────────┬─────────────────────┘
  ┌─ adjacency (secondary) ───▼─────────────────────┐
  │  built: buildAdjacency() at build time           │  lives: forever (the file)
  └───────────────────────────┬─────────────────────┘
        seam: persistent → transient  ═══════╪═══
  ┌─ indexEdges() (transient) ▼─────────────────────┐
  │  built: indexEdges() at start of EACH search     │  lives: one search call
  └───────────────────────────────────────────────────┘
```

**Seams.** The load-bearing seam is *between the persistent indexes and the
transient one*. `adjacency` is materialized once and amortized across every
read forever; `indexEdges()` is rebuilt on every `search()` call, re-paying its
O(E) build cost each time. That's a real (small) inefficiency — finding #5 in
the audit. The reason it's tolerable: at 1879 edges the rebuild is sub-millisecond,
and keeping the index out of the shared `Graph` keeps `search()` pure (no shared
mutable state across calls).

## How it works

### Move 1 — the mental model

You know a secondary index as "a lookup table from a non-PK column to the rows
that have it" — `CREATE INDEX ON orders(customer_id)` so `WHERE customer_id = X`
doesn't scan. `adjacency` is exactly that: a lookup from `nodeId` (not the
edge's PK) to the edge ids touching that node, so "give me this node's edges"
doesn't scan all edges.

```
  The pattern — secondary index = key → list of matching record ids

  WITHOUT index:  for each of 1879 edges: is fromNode==X or toNode==X?  O(E)
  WITH adjacency: adjacency["nX"]  ─►  ["e3","e7","e12"]                O(1)

  adjacency (the index)              edges (the heap file it points into)
  ┌──────┬───────────────┐           ┌──────┬─────────────────────────┐
  │ "n0" │ ["e0","e5"]    │ ────┐     │ "e0" │ {from:n0, to:n1, ...}    │
  │ "n1" │ ["e0","e1"]    │     └────►│ "e5" │ {from:n0, to:n3, ...}    │
  │ "n2" │ ["e1","e2","e9"]│          │ ...                            │
  └──────┴───────────────┘           └──────┴─────────────────────────┘
```

### Move 2 — the load-bearing skeleton

`adjacency` has a kernel. Here's the smallest thing that's still the index:

```
  Build the adjacency index (the kernel)

  index = empty map                          // nodeId → edgeId[]
  for each edge in edges:
    append edge.id to index[edge.fromNode]   // edge touches its from-node
    append edge.id to index[edge.toNode]     // AND its to-node (undirected store)
  return index
```

#### Part 1 — both endpoints get the edge (the undirected-storage trick)

Each edge is appended to **both** `fromNode`'s list and `toNode`'s list. That's
what makes the index serve traversal in either direction over an undirected
store. The edge is stored once (in `edges`), but indexed twice (once per
endpoint).

What breaks if you only index `fromNode`: A* can walk forward along edges but
never backward, so it can't find paths that traverse an edge from its `toNode`
side. The two-sided indexing is the load-bearing part — it's why the engine can
store edges undirected and still route directionally (the *cost* is directional,
file `06` of the data-modeling guide; the *index* is symmetric).

#### Part 2 — it's materialized at build, not at runtime

`buildAdjacency()` runs inside the pipeline and its output is serialized into
`graph.json`. The runtime never builds it — it reads it. This is the difference
between a persistent index (shipped, amortized forever) and an on-the-fly one.

What breaks if you forget this: you might think the index build is a runtime
cost. It isn't — it's paid once, offline, and every app install inherits the
result for free.

#### Part 3 — `indexEdges()` is the *transient* second index

The adjacency index gives you edge *ids*. A* needs edge *objects* (to read
`lengthM`, `gradePct`). Going from id to object via `edgeById` is O(E) (file
`02`). So `search()` builds a hash index — `Map<edgeId, Edge>` — once at the
start, turning every id→object lookup into O(1).

```
  Two indexes chain to make one O(1) neighbor expansion

  adjacency[current]  ──►  ["e3","e7"]   (node → edge ids,   persistent)
       then for each id:
  byId.get("e3")      ──►  Edge object   (edge id → object,  transient)
       │
       └─ without indexEdges(), this second hop would be edges.find() = O(E),
          making each node expansion O(E·degree) instead of O(degree).
```

This is the **optional hardening** layer: `adjacency` is the skeleton (without
it, no fast neighbor lookup at all); `indexEdges()` is an optimization on top
(without it, the engine still works, just slowly).

#### Part 4 — the index flattr *doesn't* have: spatial

`nearestNode` (file `04`) answers "which node is closest to this lat/lng?" by
scanning all 1621 nodes. There is **no spatial index** — no k-d tree, no R-tree,
no geohash grid. At 1621 nodes the O(N) scan is fine. The moment the graph grows
to a whole city, this is the first index you'd add, and it's `not yet exercised`.

### Move 3 — the principle

**An index is a precomputed access path you trade space and write-cost for.**
`adjacency` costs ~2 entries per edge in the file (space) and a rebuild on every
graph change (write cost) — both cheap here because the store is immutable and
small. The general lesson: indexes aren't free; they're a bet that you'll read a
given access pattern far more often than you write the data. flattr's bet is
extreme and correct — writes happen once at build, reads happen millions of times
during routing.

## Primary diagram

The full index picture: three structures, two lifecycles, the chain that makes
A* fast.

```
  flattr indexes — full picture

  PERSISTENT (in graph.json, built once at build time)
  ┌──────────────────────────────────────────────────────────────────┐
  │  nodes: Record<id,Node>     PK HASH INDEX   → nodes[id]      O(1)  │
  │  adjacency: Record<id,id[]> SECONDARY INDEX → adjacency[id]  O(1)  │
  │      built by buildAdjacency(): each edge → both endpoints' lists  │
  └───────────────────────────┬────────────────────────────────────────┘
            ═══ lifecycle seam ┼═══ (persistent → transient)
  TRANSIENT (built per search() call, discarded after)
  ┌───────────────────────────▼────────────────────────────────────────┐
  │  byId: Map<edgeId,Edge>     HASH INDEX      → byId.get(id)   O(1)   │
  │      built by indexEdges(): turns edge ids into edge objects        │
  └───────────────────────────┬────────────────────────────────────────┘
                              ▼
  A* expansion = adjacency[current] (O(1)) → byId.get(edgeId) (O(1)) → neighbor

  MISSING (not yet exercised): spatial index for nearestNode → O(N) scan today
```

## Implementation in codebase

**Use cases.** `adjacency` is read on *every node expansion* of *every route* —
it's the hottest index in the app. `indexEdges()` is built at the top of every
`search()` call. The missing spatial index shows up as the O(N) loop in
`nearestNode`, hit twice per route request (snap start, snap goal).

**Building the secondary index — `features/routing/graph.ts` (lines 22-29):**

```
  export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const e of edges) {
      (adj[e.fromNode] ??= []).push(e.id);   ← index the edge under its FROM node
      (adj[e.toNode]   ??= []).push(e.id);   ← AND under its TO node (the trick)
    }                                          ??= creates the list on first hit
    return adj;
  }
       │
       └─ pushing to BOTH endpoints is what makes one undirected edge traversable
          in either direction. Drop the toNode push and A* can never enter an edge
          from its to-side — routes that need to go "backward" along an edge fail.
          This runs at BUILD time (called in build-graph.ts:29), so the runtime
          inherits the finished index.
```

**Using it + the transient index — `features/routing/astar.ts` (lines 12-16, 64-65):**

```
  export function indexEdges(graph: Graph): Map<string, Edge> {
    const m = new Map<string, Edge>();
    for (const e of graph.edges) m.set(e.id, e);   ← build edgeId→Edge, O(E) once
    return m;                                         per search call (transient)
  }
  ...
  for (const edgeId of graph.adjacency[current] ?? []) {  ← O(1) index lookup:
    const edge = byId.get(edgeId)!;                         node's edge ids
       │                                                  ← O(1) id→object via
       │                                                    the transient index
       └─ this two-index chain is the hot path. adjacency gives ids, byId gives
          objects. The `?? []` guards a node with no edges (isolated node) —
          without it, expanding such a node throws on the for-of.
```

**The missing spatial index — `features/routing/nearest.ts` (lines 8-15):**

```
  for (const id of Object.keys(graph.nodes)) {     ← FULL SCAN: every node
    const n = graph.nodes[id];
    const d = haversine(point, {lat:n.lat, lng:n.lng});  ← distance to each
    if (d < bestDist) { bestDist = d; bestId = id; }     ← keep the closest
  }
       │
       └─ O(N) over 1621 nodes, run twice per route (start + goal snap). No
          spatial index exists. A k-d tree would make this O(log N) — the single
          highest-leverage index this repo doesn't have (audit finding #3).
```

## Elaborate

The adjacency-list-as-index framing connects the database world and the graph
world, which is exactly the bridge this repo lives on. In DB terms `adjacency`
is a secondary index on a many-to-many relationship (nodes ↔ edges); in graph-
algorithm terms it's the standard adjacency-list representation. They're the
same structure seen through two vocabularies — and you've built the graph-algorithm
version before (`Graph.ts` in your reincodes repo, per the DSA portfolio). The
DB lens adds one insight the graph lens glosses: an index is a *write-cost-for-
read-speed trade*, and flattr can take the extreme version of that trade only
because its writes are confined to build time.

The two index types map cleanly to real DB index types: `nodes`/`byId` are
**hash indexes** (O(1) point lookup, no range queries), and a real DB's default
**B-tree** index would add ordered range scans flattr never needs (it never asks
"all nodes with id between X and Y"). The spatial index it lacks (k-d tree /
R-tree) is its own family — file `04` and the DSA-foundations guide pick that up.

What to read next: `04`, where these indexes become "access paths" because
there's no query planner choosing between them.

## Interview defense

**Q: "Does this codebase have any indexes? Walk me through them."**

> Yes — `adjacency` is a hand-built secondary index, the most load-bearing
> structure in the engine. It maps each node id to the ids of edges touching it,
> built once at build time by `buildAdjacency` and shipped in `graph.json`. The
> trick is each edge is indexed under *both* its endpoints, which is what lets an
> undirected store be traversed in either direction. At runtime A* chains it with
> a transient hash index, `indexEdges()`, that turns edge ids into edge objects,
> so a neighbor expansion is two O(1) hops instead of an O(E) scan.

```
  adjacency[node] → edge ids (persistent)  →  byId.get(id) → Edge (transient)
       O(1)                                        O(1)
```

Anchor: *each edge indexed under both endpoints — that's what makes undirected
storage directionally traversable.*

**Q: "What index is missing, and when would it bite?"**

> A spatial index. `nearestNode` scans all 1621 nodes to snap a tapped point —
> O(N), run twice per route. Fine at neighborhood scale; the first thing to fix
> if the graph grew to a whole city. A k-d tree takes it to O(log N).

```
  nearestNode: scan all nodes O(N)  ──[whole-city graph]──►  add k-d tree O(log N)
```

Anchor: *no spatial index — the highest-leverage index this repo doesn't have.*

## Validate

1. **Reconstruct:** write the `buildAdjacency` kernel from memory (the two-line
   loop). Why are there two pushes per edge?
2. **Explain:** why does `search()` build `indexEdges()` fresh every call instead
   of storing it on the `Graph` (`astar.ts:12` vs `astar.ts:34`)? What's the
   trade? (Purity / no shared mutable state vs. re-paying O(E) build per call.)
3. **Apply:** you add a "find all parks within 500 m" feature. Which index helps,
   which is missing? (None of the existing ones; you'd need the spatial index
   `nearestNode` also wants — `nearest.ts:8`.)
4. **Defend:** someone says "just use `edges.find()` in A*, it's simpler."
   Quantify the cost using `astar.ts:64-65` and the 1879-edge count.

## See also

- `02-records-pages-and-storage-layout.md` — why the array layout *needs* these
  indexes
- `04-query-planning-and-execution.md` — these indexes as access paths, with no
  planner to choose between them
- `.aipe/study-dsa-foundations/` — `adjacency` as an adjacency list, the k-d tree
  flattr lacks
- `.aipe/study-data-modeling/` — the node↔edge relationship the index spans
