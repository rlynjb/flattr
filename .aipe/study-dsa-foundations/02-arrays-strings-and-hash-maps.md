# Arrays, Strings & Hash Maps

**Industry names:** hash table, hash map, hash set, associative array,
adjacency list, dynamic array. **Type:** Industry standard.

---

## Zoom out — where this concept lives

Hash maps are the unglamorous layer that makes A* fast. The search
algorithm gets the glory; the `Map`s and `Set` are what turn every lookup
inside the loop from `O(V)` into `O(1)`. Without them, A* is just an
expensive Dijkstra.

```
  Zoom out — the bookkeeping layer inside search()

  ┌─ Search engine (astar.ts) ──────────────────────────────────┐
  │                                                              │
  │   open: PQueue ──────► the frontier (file 03)               │
  │                                                              │
  │   ★ g:       Map<id, number>      best cost so far ★        │ ← we are here
  │   ★ came:    Map<id, {edge,prev}> back-pointers   ★        │
  │   ★ closed:  Set<id>              finalized nodes  ★        │
  │   ★ byId:    Map<id, Edge>        edge index       ★        │
  │   ★ adjacency: Record<id, id[]>   the graph itself ★        │
  │                                                              │
  │   loop: pop → check closed → relax → update g/came → push   │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Five hash structures and one array-of-edges carry the entire
state of the search. This file walks each one by *what it answers in O(1)*
— and what would break if you swapped it for a linear scan.

---

## Structure pass — one axis across the structures

These aren't layers; they're co-equal state. The right axis is **what
question does each answer, and how fast?**

```
  Axis: "what O(1) question does this structure answer?"

  g          → "what's the cheapest cost to node X I've found?"
  came       → "how did I get to X?"            (reconstruction)
  closed     → "is X already finalized?"        (skip stale)
  byId       → "give me the Edge for this id"   (O(1), not O(E) scan)
  adjacency  → "which edges touch node X?"      (the graph shape)
```

The seam is the one place flattr *doesn't* use O(1): `graph.edges` is a
plain array, and `edgeById()` in `graph.ts:3-7` does a linear `.find()`.
The search engine refuses to pay that cost in its hot loop — so it builds
`byId` once up front (`indexEdges`). That contrast — array scan vs
pre-built index — is the lesson of this file.

---

## How it works

### Move 1 — the mental model

You reach for a `Map` over an array the moment you need lookup-by-key
instead of lookup-by-position. A todo app keying tasks by id, a form
keying inputs by field name — same primitive. A hash map trades a little
memory for `O(1)` average access by running the key through a hash
function to compute a slot.

```
  The hash map shape

  key "11,5" ──hash──► slot 3 ──► { cost: 880 }
  key "0,0"  ──hash──► slot 7 ──► { cost: 0   }
  key "4,9"  ──hash──► slot 3 ──► collision! chain or probe
                          │
                          ▼
              O(1) average, O(N) worst (all collide)
```

In the search loop, every one of those lookups happens *per edge*. If
they were `O(V)` array scans, the search would be `O(E·V)` instead of
`O(E log V)`. The hash maps are why the log is a log.

### Move 2 — the five structures, one at a time

#### `g` — the distance map (best-known cost)

This is the array you'd call `dist[]` in a textbook Dijkstra, but keyed by
string id instead of integer index — because flattr's nodes are
`"row,col"` strings, not 0..N integers.

```ts
// features/routing/astar.ts:31, 44, 68-69
const g = new Map<string, number>();
g.set(startId, 0);
// inside the loop, per edge:
const tentative = g.get(current)! + costFn(edge, current, userMax);
if (tentative < (g.get(next) ?? Infinity)) { ... }
```

```
  Relaxation reads and writes g in O(1)

  g.get(current)  ── O(1) ──► 200      current best cost to `current`
       + cost(edge)             80      this edge's cost
       = tentative             280
  g.get(next) ?? Infinity ─────► 999    old best to `next`
  280 < 999  → g.set(next, 280)  O(1)   found a cheaper way
```

**The `?? Infinity` is load-bearing.** A node never seen has no entry;
`?? Infinity` makes "unvisited" compare as "infinitely expensive," so the
first path to it always wins. Drop it and `g.get(next)` is `undefined`,
and `tentative < undefined` is `false` — the node would never be relaxed.

#### `came` — the back-pointer map (how reconstruction works)

`came` stores, for each node, the edge and previous node that gave it its
current best cost. It's a linked list threaded through a hash map.

```ts
// features/routing/astar.ts:32, 71
const came = new Map<string, { edge: Edge; prev: string }>();
came.set(next, { edge, prev: current });
```

```
  came forms a reverse linked list to the start

  goal ──prev──► N3 ──prev──► N2 ──prev──► N1 ──prev──► start
   ▲                                                      │
   └──────────── walk this backward to rebuild path ──────┘
```

It stores the **exact edge**, not just the previous node — that's the
detail file 07 (reconstruction) hangs on. Two parallel edges between the
same pair of nodes would be indistinguishable by node-pair alone, so
storing the edge is what keeps `steepEdges` correct.

#### `closed` — the visited set

A `Set` answering one question: "have I already finalized this node?"

```ts
// features/routing/astar.ts:33, 51, 61, 67
const closed = new Set<string>();
if (closed.has(current)) continue;   // stale duplicate, skip
closed.add(current);
if (closed.has(next)) continue;      // don't re-expand
```

```
  closed-set skip — the lazy-deletion partner

  pop "X" (priority 280)
     closed.has("X")? ── yes ──► continue (this is a stale copy)
                      └─ no  ──► closed.add("X"), expand it
```

**What breaks without it:** on a cyclic graph (every street graph), the
search revisits nodes forever. `closed` is BFS/DFS's visited set wearing
an A* hat. It's also half of the lazy-deletion scheme — the heap can hold
several stale copies of a node; `closed` is how the search ignores all but
the first pop. (File 03 walks the heap side.)

#### `byId` — the edge index (the anti-pattern fix)

This is the structure that exists *specifically to avoid* the `O(E)` scan
in `edgeById`.

```ts
// features/routing/astar.ts:11-16
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);
  return m;
}
```

```
  Build-once index vs per-lookup scan

  graph.edges (array)        byId (Map, built once: O(E))
  ┌──────────────────┐       ┌─────────────────────────┐
  │ [e0, e1, ... eE] │  ──►  │ "e0"→e0  "e1"→e1  ...   │
  └──────────────────┘       └─────────────────────────┘
  edgeById: O(E) find         byId.get(id): O(1)
  (graph.ts:3-7)              (used in the hot loop)
```

The comment on `indexEdges` says it plainly: *"so expansions are O(1) per
edge, not O(E)."* Pay `O(E)` once before the loop to make every in-loop
lookup `O(1)`. This is the same move as `g` and `came` — trade setup cost
for hot-path speed.

#### `adjacency` — the graph as a hash map of arrays

The graph itself is an adjacency list: a `Record` mapping each node id to
an **array** of incident edge ids. This is where arrays and hash maps meet.

```ts
// features/routing/graph.ts:22-29
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);   // undirected: both ends
    (adj[e.toNode] ??= []).push(e.id);
  }
  return adj;
}
```

```
  Adjacency list — hash map of arrays (undirected)

  "0,0" ──► [ "e0", "e1" ]        node → its incident edge ids
  "0,1" ──► [ "e0", "e2", "e3" ]
  "1,0" ──► [ "e1", "e4" ]
            └──────┬──────┘
            iterate these to expand a node (astar.ts:64)
```

**The undirected choice is deliberate.** Each edge is stored once but
listed under *both* endpoints. Direction isn't baked into storage — it's
*derived at traversal* by `directedGrade(edge, fromNodeId)` (`graph.ts:17`)
and `otherEnd(edge, nodeId)` (`graph.ts:10`). One edge serves both
directions; the cost function decides which way you're going. That's why
the same graph can answer both "S→G" and "G→S" without storing reversed
edges. (File 05 walks this in full.)

#### Strings as composite keys

flattr's node ids are strings like `"11,5"` (`fixtures.ts:111`) and
`zones.ts` builds bucket keys as `"col,row"` (`zones.ts:38`). This is the
one string technique in the repo: **encode a 2D coordinate as a string to
use it as a hash key**, then `key.split(",").map(Number)` to decode
(`zones.ts:46`).

```
  Composite string key — 2D coord → hashable key → back

  (col=3, row=5) ──`${col},${row}`──► "3,5" ──map key──► [grades]
                                        │
                  "3,5".split(",").map(Number) ──► [3, 5]
```

It works, but it's the slow path: string hashing and `split` per access.
A typed `Map<number, ...>` with a `row*N+col` integer key would be
faster. For a build-time heatmap (`zones.ts` runs in the pipeline, not
the hot route loop) the readability wins. Naming that tradeoff is the
point.

### Move 3 — the principle

Hash maps are how you buy `O(1)` lookups in an algorithm whose whole
speed claim rests on not scanning. The pattern repeats five times in one
function: any time the search needs to ask a question about a node — its
cost, its parent, whether it's done, its edges — there's a hash structure
standing by to answer in constant time. The one array scan that survives
(`edgeById`) is the exception that proves the rule: the search refuses to
use it in the loop and builds `byId` instead.

---

## Primary diagram

Every hash structure in `search()` and the question it answers, in one
frame.

```
  search() — the hash-map bookkeeping (astar.ts:30-78)

  ┌─ built once, before the loop ───────────────────────────────┐
  │  byId = indexEdges(graph)   Map<edgeId, Edge>      O(E)     │
  │  adjacency (from graph)     Record<nodeId, edgeId[]>        │
  └───────────────────────────┬──────────────────────────────────┘
                              │  the loop, per popped node:
  ┌─ per-node state (O(1) each) ────────────────────────────────┐
  │  closed.has(current)?  ──► skip if stale                    │
  │  for edgeId in adjacency[current]:                          │
  │      edge = byId.get(edgeId)        O(1) (not O(E) scan)    │
  │      next = otherEnd(edge, current)                         │
  │      tentative = g.get(current)! + cost                     │
  │      if tentative < (g.get(next) ?? Infinity):              │
  │          g.set(next, tentative)     O(1)                    │
  │          came.set(next, {edge, prev: current})  O(1)        │
  │          open.push(...)             O(log V)                │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Adjacency-list-as-hash-map is the standard sparse-graph representation —
street graphs are sparse (each intersection touches 2-4 streets), so the
alternative (adjacency *matrix*, `O(V²)` space) would be mostly zeros.
You've built this exact structure in reincodes (`Graph.ts`, adjacency
list with BFS/DFS). flattr's twist is the undirected storage with
derived direction — most textbook graphs store directed edges explicitly.
The `?? Infinity` default-on-miss idiom is worth internalizing; it's the
JS-idiomatic way to express "unvisited = infinitely far" without
pre-filling the map. Read file 03 next — the one structure here that
*isn't* a hash map is the heap.

---

## Interview defense

**Q: Why a `Map<string, number>` for `g` instead of an array?**

```
  array dist[]      requires integer indices 0..V-1
  Map<string,n>     keys are "row,col" strings → no index remap
```

*Model answer:* "The nodes are string ids (`'11,5'`), not dense integers,
so an array would need a separate id→index mapping. A `Map` keys directly
on the id, still `O(1)` average. The cost is hashing strings instead of
indexing an array — fine here because the ids are short and the lookup
count is bounded by the edge count."

*Anchor:* string-keyed maps because nodes aren't integer-indexed.

**Q: Why build `byId` when there's already `graph.edges`?**

*Model answer:* "`graph.edges` is an array; `edgeById` does an `O(E)`
`.find()`. Inside the search loop you look up an edge per neighbor — that
would make expansion `O(E)` per node, `O(V·E)` overall. `indexEdges`
pays `O(E)` once to build a `Map`, making every in-loop lookup `O(1)`.
The comment literally says 'so expansions are O(1) per edge, not O(E).'"

*Anchor:* build-once index to keep the hot loop `O(1)`.

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the one structure here that's
  a tree, not a hash: the PQueue.
- `05-graphs-and-traversals.md` — how `adjacency` + `closed` + `g` drive
  the traversal.
- `07-recursion-backtracking-and-dynamic-programming.md` — how `came`
  reconstructs the path.
- sibling **data-modeling** — owns the `Graph`/`Node`/`Edge` schema.
