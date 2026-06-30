# Arrays, Strings & Hash Maps

**Industry names:** dynamic array / contiguous sequence · hash map (`Map`) ·
hash set (`Set`) · adjacency list. **Type:** Industry standard.

## Zoom out, then zoom in

`search()` is a graph algorithm, but underneath it's four hash structures and
one array doing all the actual bookkeeping. The frontier is a heap built on an
array. `g`, `came`, and `closed` are a `Map`, a `Map`, and a `Set`. The
adjacency is a `Record` of arrays. The edge index is a `Map`. Strip the graph
vocabulary away and what's left is: *amortized-O(1) lookups everywhere, because
the search touches each of these structures on every single edge relaxation.*

```
  Zoom out — the hash/array structures inside one search() call

  ┌─ Algorithm layer (astar.ts:30-34) ────────────────────────┐
  │  open   : PQueue<string>          ← array-backed heap      │ ★
  │  g      : Map<string, number>     ← best cost to a node    │ ★
  │  came   : Map<string, {edge,prev}>← reconstruction trail   │ ★
  │  closed : Set<string>             ← finalized node ids     │ ★
  │  byId   : Map<string, Edge>       ← O(1) edge resolution   │ ★
  └────────────────────────────┬──────────────────────────────┘
                               │ reads
  ┌─ Structure layer (graph.ts) ──▼───────────────────────────┐
  │  adjacency : Record<string, string[]>  ← node → edge ids   │ ★
  │  nodes     : Record<string, Node>      ← node id → Node    │ ★
  └────────────────────────────────────────────────────────────┘
```

Zoom in: why these and not, say, arrays indexed by integer? Because node ids
are *strings* (`"0,0"`, `"11,11"`, `"S"`, `"meet"`), so you need key→value
lookup, not positional. That's the whole reason this is a hash-map story and
not an array-indexing story.

## The structure pass

Two layers; trace the **state-ownership** axis across them.

```
  Axis: who owns this state, and how is it keyed?

  structure   keyed by        owns                       mutable?
  ─────────   ─────────────   ────────────────────────   ────────
  adjacency   node id (str)   graph topology             no (frozen build)
  nodes       node id (str)   coordinates + elevation    no
  byId        edge id (str)   per-search edge index      no (rebuilt/run)
  g           node id (str)   best-cost-so-far           yes (relaxation)
  came        node id (str)   predecessor edge           yes (relaxation)
  closed      node id (str)   finalized flag             yes (grows only)
```

**The seam:** between the *immutable graph* (`adjacency`, `nodes`, `byId` —
read-only for the whole search) and the *mutable search state* (`g`, `came`,
`closed` — rewritten every relaxation). The graph is shared and never touched;
the search state is born and dies with one `search()` call. That separation is
why you can run Dijkstra and A* on the same graph object back-to-back in the
optimality test (`astar.test.ts:39-44`) without one corrupting the other.

## How it works

### Move 1 — the mental model

You already build with all of these daily. A `Map<string, number>` is the same
shape as a lookup object you'd keep in React state to remember "which row is
selected." A `Set<string>` is the dedup structure you reach for to answer "have
I seen this id?" An adjacency list is just "for each node, an array of the edges
touching it" — a `Record` whose values are arrays.

```
  The adjacency list — node id → array of incident edge ids

  adjacency = {
    "S": ["sa", "sb", "sd"],   ← node S touches 3 edges
    "A": ["sa", "ag", "ac"],   ← edge "sa" appears under BOTH endpoints
    "G": ["ag", "bg", "dg"],     (undirected: stored once per endpoint)
    ...
  }

  to expand node S:  for edgeId of adjacency["S"]  → O(deg(S))
```

The key insight from `graph.ts`: edges are stored **undirected** — each edge id
lands in the array of *both* its endpoints. Direction is derived at traversal
time, not stored twice.

### Move 2 — the walkthrough

#### The adjacency list — building it

Bridge: you've built adjacency lists in reincodes (`Graph.ts`,
`Graph2.ts`). flattr's is the `Record`-of-arrays flavor. Here's the builder,
`graph.ts:22-29`:

```ts
// graph.ts:22-29 — every edge registered under both endpoints
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);   // register under fromNode
    (adj[e.toNode]   ??= []).push(e.id);   // AND under toNode (undirected)
  }
  return adj;
}
```

The `??=` does the "create the array if this is the first edge for this node"
in one line. The cost: one `O(E)` pass, and every edge stored twice (once per
endpoint). The payoff: `adjacency[nodeId]` is `O(1)`, and iterating a node's
edges is `O(deg)` — exactly the work A* needs at `astar.ts:64`.

**Where it breaks:** if an edge id appeared under only one endpoint, the search
could traverse it one direction but not the other — you'd silently lose half
your routes. Storing under both endpoints is the load-bearing part.

#### Direction derived, not stored — otherEnd and directedGrade

Here's the elegant bit. The edge is undirected in storage, but the search needs
to know "which way am I going across it?" Two helpers do that, `graph.ts:9-19`:

```ts
// graph.ts:10-14 — the endpoint opposite the one you arrived from
export function otherEnd(edge: Edge, nodeId: string): string {
  if (nodeId === edge.fromNode) return edge.toNode;
  if (nodeId === edge.toNode)   return edge.fromNode;
  throw new Error(...);   // nodeId isn't an endpoint — a bug, fail loud
}

// graph.ts:17-19 — signed grade in the direction of travel
export function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
}
```

```
  One stored edge, two directions — derived at traversal

  stored:  edge "xy"  fromNode=X  toNode=Y  gradePct=+8

  arrive from X →  otherEnd = Y       directedGrade = +8  (uphill)
  arrive from Y →  otherEnd = X       directedGrade = −8  (downhill, free)

  one Edge object, no duplication — the SIGN carries direction
```

This is why a single edge can cost differently each way (`cost.ts:32-33` uses
`directedGrade`), without storing two edges. The directed-A* test
(`astar.test.ts:74-80`) proves it: `X→Y` detours around the climb, `Y→X` takes
the direct downhill — same edge, asymmetric cost.

#### g, came, closed — the three search maps

These three are the heart of the bookkeeping. Each is keyed by node-id string.
From `astar.ts:31-33`:

```
  Layers-and-hops — what each map answers, per relaxation

  ┌─ relaxing edge (current → next) at astar.ts:68-73 ────────┐
  │                                                            │
  │  g.get(current)        → cost to reach current   [read]    │
  │  + costFn(edge,…)      → edge cost                          │
  │  = tentative                                                │
  │                                                            │
  │  tentative < g.get(next) ?? Infinity ?   [read, default]   │
  │     │ yes                                                   │
  │     ├─ g.set(next, tentative)            [write best cost] │
  │     ├─ came.set(next, {edge, prev})      [write trail]     │
  │     └─ open.push(next, tentative + h)    [enqueue]         │
  └────────────────────────────────────────────────────────────┘

  closed.has(next) ?  → skip already-finalized (astar.ts:67)
```

- **`g`** — "cheapest cost found so far to reach this node." The `?? Infinity`
  at `astar.ts:69` is the "I've never seen this node" default: any real cost
  beats `Infinity`, so the first time you reach a node it always relaxes.
- **`came`** — "which edge did I arrive on, and from where." This is the
  reconstruction trail; `02`'s sibling file `07` covers how `reconstruct()`
  walks it backward.
- **`closed`** — "this node is finalized, don't touch it again." A `Set`, not a
  `Map`, because you only need membership, not a value.

**The boundary condition people miss:** `g` stores the *value*, `closed`
stores the *fact of finalization*. They're separate because a node can have a
`g` entry (reached, in the frontier) long before it's `closed` (popped and
finalized). Conflating them — using `closed` membership as "have I seen it" —
would break the lazy-deletion logic.

#### The byId index — string keys, O(1) resolution

Covered for complexity in `01`; here's the data-structure read. The graph
stores edges as an *array* (`graph.edges`), but the search needs them by *id*.
`indexEdges` (`astar.ts:12-16`) builds the `Map<string, Edge>` once so
`byId.get(edgeId)` at `astar.ts:65` is `O(1)`. Without it you'd
`graph.edges.find(...)` — a linear scan of an array — on every edge.

```
  Array → Map, so id lookups stop being linear scans

  graph.edges = [ {id:"sa",…}, {id:"ag",…}, {id:"sb",…}, … ]
                        │ indexEdges, one O(E) pass
                        ▼
  byId = Map { "sa"→{…}, "ag"→{…}, "sb"→{…}, … }
                        │
  byId.get("ag")  →  O(1)   (vs edges.find → O(E))
```

### Move 3 — the principle

The graph is a topology, but the *implementation* is hash structures. The
recurring move: when your keys are strings (or any non-dense identifier), reach
for `Map`/`Set`/`Record`, not positional arrays — you trade a hash computation
for the ability to key by meaningful identity. flattr keys everything by node
id and edge id, which is why it can store edges undirected and derive direction
on the fly. The deeper lesson is the immutable-graph / mutable-search-state
split: shared read-only structure plus per-call scratch state is how you run
the same algorithm twice on one graph without interference.

## Primary diagram

Every array/hash structure in a search, and who reads/writes it.

```
  The data structures of one search() call

  IMMUTABLE (shared, read-only for the whole search)
  ┌──────────────────────────────────────────────────────────┐
  │ nodes    Record<id, Node>      coordinates + elevation    │
  │ adjacency Record<id, string[]> node → incident edge ids   │
  │ byId     Map<id, Edge>         edge id → Edge  (O(1))      │
  └──────────────────────────────────────────────────────────┘
                          read ▼
  MUTABLE (born and dies with this search() call)
  ┌──────────────────────────────────────────────────────────┐
  │ open    PQueue<string>   frontier, ordered by f = g + h   │
  │ g       Map<id, number>  best cost so far  (?? Infinity)  │
  │ came    Map<id, {edge}>  reconstruction trail             │
  │ closed  Set<id>          finalized nodes (membership)     │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Adjacency lists vs adjacency matrices is the classic graph-representation
tradeoff: lists are `O(V+E)` space and great for sparse graphs (a street
network is *very* sparse — each intersection touches a handful of streets); a
matrix is `O(V²)` and only wins for dense graphs or `O(1)` edge-existence
checks. flattr's street graph is sparse, so the list is correct. The
string-keyed `Map` over an integer-indexed array is the other deliberate
choice — node ids like `"11,11"` carry meaning (grid coordinates), and the
hash cost is worth the readability and the freedom from a dense id space.

Read next: `03` (the array-backed heap that `open` actually is) and `05`
(the search that drives all these structures).

## Interview defense

**Q: Why store edges undirected and derive direction, instead of two directed
edges?**

Half the memory and a single source of truth. One `Edge` object lives in the
arrays of both endpoints (`buildAdjacency`, `graph.ts:22`); `otherEnd` and
`directedGrade` (`graph.ts:10,17`) compute the traversal direction from which
endpoint you arrived at. The sign of `gradePct` carries direction, so one edge
costs `+8%` one way and `−8%` (free, downhill) the other.

```
  edge "xy" (X→Y, +8%)   arrive from X → +8 uphill (penalized)
                         arrive from Y → −8 downhill (free)
  one object, two costs, no duplication
```

Anchor: "direction is a *function of arrival endpoint*, not a stored fact."

**Q: Why is `closed` a Set but `g` a Map?**

`closed` only needs membership — "is this node finalized, yes or no" — so a
`Set` is exactly right (`astar.ts:33`). `g` needs the *value* — the best cost
to compare against at `astar.ts:69` — so it's a `Map`. Using the wrong one
would either waste a value you never read or lose the value you need.

Anchor: "`Set` for membership, `Map` for membership-plus-value."

## See also

- `03-stacks-queues-deques-and-heaps.md` — `open` is an array-backed heap.
- `05-graphs-and-traversals.md` — the search that drives g/came/closed.
- `07-recursion-backtracking-and-dynamic-programming.md` — `reconstruct()`
  walks the `came` map.
- `04-trees-tries-and-balanced-indexes.md` — where a spatial index *would*
  replace the `nodes` linear scan in `nearestNode`.
