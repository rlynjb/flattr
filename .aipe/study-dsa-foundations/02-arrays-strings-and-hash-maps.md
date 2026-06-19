# Arrays, strings & hash-maps

**Industry names:** dynamic array · hash table / hash map · associative array ·
adjacency list (as a map). **Type:** Language-agnostic (the repo uses JS
`Map`, `Set`, `Record`, and `Array`).

---

## Zoom out, then zoom in

Before any graph algorithm runs, the graph has to *be* something in memory. In
`flattr` it's three plain JavaScript containers: an array of edges, a record of
nodes keyed by id, and an adjacency record mapping node id → edge ids. Every
`O(1)` lookup the search depends on is a hash-map lookup in disguise.

```
  Zoom out — the containers under the graph

  ┌─ Graph model layer (types.ts:22-28) ──────────────────────────┐
  │  Graph = {                                                      │
  │    nodes:     Record<string, Node>   ← ★ HASH MAP (id→node)     │
  │    edges:     Edge[]                 ← ★ ARRAY (the edge list)  │
  │    adjacency: Record<string,string[]>← ★ HASH MAP of ARRAYS     │
  │  }                                                              │
  └─────────────────────────┬──────────────────────────────────────┘
                            │ consumed by
  ┌─ Search layer ──────────▼──────────────────────────────────────┐
  │  g, came: Map<string,...>   closed: Set<string>   ← ★ all hash  │
  │  byId: Map<string,Edge>     ← ★ array→map index (astar.ts:12)  │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the question this file answers is *which container, and what does each
operation cost?* The repo's defining move is converting the `edges` **array**
into a `byId` **map** once per search (`astar.ts:12-16`) so that `O(E)`
linear scans become `O(1)` lookups inside the hot loop.

---

## The structure pass

**Layers.** Two altitudes: the *stored* model (built once at graph-load time) and
the *working* state (rebuilt every search).

```
  One question — "how is this looked up?" — across the two layers

  ┌─────────────────────────────────────────────┐
  │ stored model (fixtures.ts / graph.json)       │
  │   edges: Edge[]        → look up by SCAN O(E)  │  ← graph.ts:3-7 edgeById
  │   nodes: Record        → look up by KEY  O(1)  │
  │   adjacency: Record    → look up by KEY  O(1)  │
  └────────────────────┬───────────────────────────┘
        rebuilt per search to fix the slow one
  ┌─────────────────────▼─────────────────────────┐
  │ working state (astar.ts:31-34)                  │
  │   byId: Map<id,Edge>   → look up by KEY  O(1)   │  ← the fix
  │   g, came: Map         → look up by KEY  O(1)   │
  │   closed: Set          → membership      O(1)   │
  └─────────────────────────────────────────────────┘
```

**Axis = lookup cost.** Hold "how do I find this thing?" constant. The `edges`
array answers `O(E)` (you scan it — `graph.ts:4` literally calls `.find()`).
Every map answers `O(1)`. The seam is `indexEdges()` (`astar.ts:12-16`): it sits
exactly on the boundary where the array's slow lookup is converted to a map's
fast one, *once*, before the loop that would otherwise pay `O(E)` per edge.

**Seam.** `edgeById` vs `byId.get`. Both find an edge by id. One is `O(E)`, one
is `O(1)`. They coexist in the repo because `edgeById` (`graph.ts:3-7`) is used
in cold paths (`summary.ts:14`) where a scan is fine, while the search's hot loop
uses the map. Knowing *which to use where* is the lesson.

---

## How it works

### Move 1 — the mental model

You already trust a JS object as a lookup table: `users[id]` is instant
regardless of how many users you have. That `O(1)`-average lookup is a hash
table — it hashes the key to a bucket and reads it directly, instead of walking
the collection. An array is the opposite trade: `O(1)` by *position*, `O(n)` by
*value*.

```
  Two containers, opposite strengths

  ARRAY  edges[2]              HASH MAP  nodes["S"]
  ┌────┬────┬────┬────┐        ┌─────────────────────────┐
  │ e0 │ e1 │ e2 │ e3 │        │ hash("S") → bucket 4 → ● │
  └────┴────┴─▲──┴────┘        └─────────────────────────┘
              │                          │
   O(1) by index                O(1) by KEY (avg), O(n) worst (collisions)
   O(n) by value (.find)        no positional access
```

### Move 2 — the moving parts

**The adjacency map: `Record<string, string[]>`.** This is the graph's spine.
`buildAdjacency` (`graph.ts:22-29`) walks the edge array once and, for each edge,
appends its id to *both* endpoints' lists. The `??=` idiom (`adj[e.fromNode] ??=
[]`) is "create the array if this key is unseen, then push." Result: one `O(1)`
keyed lookup gives you every edge touching a node — which is exactly what the
search's neighbor loop needs (`astar.ts:64`).

```
  buildAdjacency over edges [sa: S-A, ag: A-G]  (graph.ts:22-29)

  edge sa (S→A):  adj["S"] ??= []; push "sa"  →  { S:["sa"] }
                  adj["A"] ??= []; push "sa"  →  { S:["sa"], A:["sa"] }
  edge ag (A→G):  adj["A"] push "ag"          →  { ..., A:["sa","ag"] }
                  adj["G"] ??= []; push "ag"  →  { ..., G:["ag"] }

  each node now maps to ALL incident edge ids — O(1) to fetch, O(deg) to walk
```

**The `byId` index: array → map, once.** `indexEdges()` (`astar.ts:12-16`)
exists for one reason: the adjacency map stores edge *ids* (strings), but the
search needs edge *objects*. Without the index, every `astar.ts:65` would call
`graph.edges.find()` — `O(E)` per edge, turning the whole search into `O(E²)`.
With it, the conversion is paid once (`O(E)`) and every lookup after is `O(1)`.
The test `astar.test.ts:130-135` pins this: `indexEdges` maps every id to its
edge object.

**`Set` for the closed list — membership, not storage.** `closed = new
Set<string>()` (`astar.ts:34`). The only questions asked of it are "have I
finalized this node?" (`closed.has(current)`, `astar.ts:51`) and "mark it
finalized" (`closed.add`, `astar.ts:61`). A `Set` answers both in `O(1)`. Use an
array here and membership becomes `O(V)`, silently making the search quadratic.

**Strings as ids — the universal key.** Every node and edge id is a string
(`types.ts:2,11`). Grid nodes are `"row,col"` (`fixtures.ts:111`); edges are
`"e0"`, `"e1"`. Strings hash well and are the natural map key. The one cost: a
parse step when you need the numbers back (`zones.ts:46`,
`key.split(",").map(Number)`). String-as-composite-key is a deliberate, cheap
modeling choice.

**Collision behavior — the hidden worst case.** Hash-map lookup is `O(1)`
*average*, `O(n)` *worst* if every key collides into one bucket. The repo never
hits this — JS engine string hashing is well-distributed and the keys are
distinct ids — but it's the honest caveat behind "`O(1)`": you're trusting the
hash function to spread keys across buckets.

### Move 3 — the principle

**Pick the container by the operation you do most in the hot loop.** The search's
hot loop does keyed lookups (`g.get`, `byId.get`, `closed.has`), so every
working structure is a map or set, and the one array (`edges`) gets indexed into
a map before the loop starts. The pattern — *scan once to build an index, then
do `O(1)` lookups* — is the most reusable idea in this file.

---

## Primary diagram

The full container layout: what's an array, what's a map, and where the index
conversion happens.

```
  flattr's containers and the array→map index seam

  STORED (built once)                    WORKING (per search, astar.ts:31-34)
  ┌────────────────────────────┐         ┌──────────────────────────────────┐
  │ edges: Edge[]              ─┼──index─►│ byId: Map<id,Edge>   O(1) lookup  │
  │   O(E) scan (graph.ts:4)   │ astar:12 │                                   │
  │                            │         │ g:     Map<id,number> best cost   │
  │ nodes: Record<id,Node>     │         │ came:  Map<id,{edge,prev}>        │
  │   O(1) keyed               │         │ closed:Set<id>   O(1) membership  │
  │                            │         └──────────────────────────────────┘
  │ adjacency: Record<id,id[]> │                     ▲
  │   O(1) → id[], O(deg) walk ┼─────────────────────┘
  └────────────────────────────┘     neighbor loop reads adjacency[current]
       built by buildAdjacency             then byId.get(edgeId)
       (graph.ts:22-29)                     (astar.ts:64-65)
```

---

## Implementation in codebase

**Use cases.** Hash-maps are reached for everywhere a lookup-by-id happens: the
node table, the adjacency, and all four working structures in the search. Arrays
are reached for the edge list (iteration order matters for deterministic builds)
and the per-node incident-edge lists.

```
  features/routing/graph.ts  (lines 22-29)  — buildAdjacency

  const adj: Record<string, string[]> = {};    ← the map of arrays
  for (const e of edges) {                      ← one O(E) pass
    (adj[e.fromNode] ??= []).push(e.id);        ← undirected: BOTH ends...
    (adj[e.toNode]   ??= []).push(e.id);        ← ...get the same edge id
  }
  return adj;
       │
       └─ both endpoints store the edge because the graph is UNDIRECTED in
          storage (one physical edge). Direction is derived later by
          directedGrade (graph.ts:17-19). Drop the second push and half the
          graph's connectivity vanishes — the search can't traverse the edge
          backward. (See 05 for why this is the right storage choice.)
```

```
  features/routing/astar.ts  (lines 12-16)  — indexEdges

  export function indexEdges(graph: Graph): Map<string, Edge> {
    const m = new Map<string, Edge>();
    for (const e of graph.edges) m.set(e.id, e);   ← O(E) once
    return m;
  }
       │
       └─ called at astar.ts:34 and reused inside the loop at astar.ts:65.
          Without it, astar.ts:65 would be graph.edges.find(...) — O(E) per
          edge, O(E²) per search. This single line is the difference between
          a usable router and a quadratic one.
```

---

## Elaborate

The hash table (Luhn, 1953; Knuth's analysis in TAOCP vol. 3) is the data
structure that makes "look it up by name" cheap, and it underlies almost every
`O(1)` claim in software — JS objects, Python dicts, database hash indexes. The
adjacency *list* (a map of arrays) is the standard sparse-graph representation;
its dense alternative, the adjacency *matrix*, is `O(V²)` space and would be
catastrophic for a street graph that's mostly empty. `flattr` correctly uses the
list form. For where the array form gets *indexed* into something searchable, see
**04** (balanced trees / spatial indexes) and **06** (sorting and binary search).
The data-modeling angle — why ids are strings, why edges are signed by direction
— lives in `.aipe/study-data-modeling/`.

---

## Interview defense

**Q: "Why convert the edge array to a map at the start of every search?"**

Because the adjacency stores edge *ids* but the search needs edge *objects*, and
resolving an id by scanning the array is `O(E)`. Indexing once is `O(E)`; every
lookup after is `O(1)`. Skip it and the search is `O(E²)`.

```
  without index:  for each edge → edges.find()  → O(E) → O(E²) total
  with index:     build once O(E) → get() O(1)  → O(E + work)
  anchor: astar.ts:12-16 (build), astar.ts:65 (use)
```

**Q: "Why is `closed` a `Set` and not an array?"**

The only operations are membership-test and insert, both `O(1)` on a `Set`. An
array makes membership `O(V)`, turning the search quadratic. Anchor:
`astar.ts:51,61`.

---

## Validate

1. **Reconstruct:** Name the three containers in the `Graph` type
   (`types.ts:22-28`) and give the lookup cost of each.
2. **Explain:** Why does `buildAdjacency` (`graph.ts:22-29`) push each edge id to
   *both* endpoints? What breaks if it pushes to only one?
3. **Apply:** Trace `indexEdges` (`astar.ts:12-16`) on the diamond fixture's 8
   edges and state the resulting map size. (`astar.test.ts:130-135` is your
   check.)
4. **Defend:** `summary.ts:14` uses `edgeById` (an `O(E)` scan) while the search
   uses `byId.get`. Argue why both are correct choices in their contexts.

---

## See also

- **05-graphs-and-traversals.md** — how the adjacency map drives traversal.
- **03-stacks-queues-deques-and-heaps.md** — the `Set`/`Map` working state's neighbor.
- **04-trees-tries-and-balanced-indexes.md** — when a tree beats a hash map (ordered/spatial lookups).
- `.aipe/study-data-modeling/` — the Node/Edge/Graph schema decisions.
