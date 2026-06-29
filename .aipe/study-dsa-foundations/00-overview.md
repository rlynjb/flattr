# DSA Foundations — flattr

> The repo-grounded map. flattr is a hand-rolled graph router that finds
> flat-not-fast routes over a grade-annotated street graph. The DSA spine
> is `features/routing/` — one parametric search engine, a hand-built
> binary heap, an undirected adjacency graph, and a percentile sort. This
> guide teaches the fundamentals *that explain those files*, plus the
> foundations the repo deliberately leaves on the table.

---

## The whole thing in one frame

This is the system the rest of the guide takes apart. Every box is a real
data structure or algorithm; every arrow is a real call.

```
  flattr routing — the DSA spine (features/routing/)

  ┌─ Input ─────────────────────────────────────────────────────┐
  │  tapped (lat,lng)  +  userMax (max comfortable uphill %)     │
  └───────────────────────────┬──────────────────────────────────┘
                              │  nearest.ts: O(N) linear scan
                              ▼
  ┌─ Snap ──────────────────────────────────────────────────────┐
  │  nearestNode()  →  startId, goalId   (graph node ids)        │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Search ────────────────────────────────────────────────────┐
  │  astar.ts  search(costFn, heuristicFn)                       │
  │    ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
  │    │ open: PQueue │   │ g: Map<id,n> │   │ closed: Set    │  │
  │    │ (binary heap)│   │ came: Map    │   │ (visited)      │  │
  │    └──────┬───────┘   └──────────────┘   └────────────────┘  │
  │           │  pop min-f → expand neighbors → relax → push     │
  │           ▼                                                    │
  │   graph.ts: adjacency[nodeId] → edgeIds → otherEnd / grade   │
  │   cost.ts: penalty() turns signed grade into a cost multiplier│
  └───────────────────────────┬──────────────────────────────────┘
                              │  reconstruct via came-from
                              ▼
  ┌─ Output ────────────────────────────────────────────────────┐
  │  Path { nodes, edges, cost, lengthM, steepEdges }           │
  │  + grade/zones.ts: percentile() heatmap (full-sort p85)     │
  └──────────────────────────────────────────────────────────────┘
```

The router is the centerpiece. The product knob — `userMax` — feeds
`cost.ts`, which is the only thing that makes flattr different from any
shortest-path demo. Everything else is the standard A* machinery you'd
recognize from any algorithms course, implemented by hand.

---

## The verdict — what this repo actually exercises

Ranked by how load-bearing each foundation is to flattr working at all:

| Rank | Foundation | Where | Verdict |
|------|-----------|-------|---------|
| 1 | **Graph + traversal (A*/Dijkstra)** | `astar.ts`, `graph.ts`, `bidirectional.ts` | The whole product. One parametric `search()` is Dijkstra, A*, grade-A*, and directional-A* via `(costFn, heuristicFn)` pairs. |
| 2 | **Binary min-heap / priority queue** | `pqueue.ts` | Hand-rolled, array-backed, lazy-deletion. The frontier. Without it, A* is O(V²). |
| 3 | **Hash maps + sets** | `g`, `came`, `closed`, `adjacency`, `indexEdges` | The bookkeeping that makes the search O(1) per lookup. |
| 4 | **Complexity / cost models** | every routing file | `BLOCKED = 1e9` (large-finite, not Infinity) is a deliberate cost-model choice, not a bug. |
| 5 | **Recursion / reconstruction** | `reconstruct()` in `astar.ts` | Path rebuilt by walking `came` backward — iterative, but the same backtrack shape. |
| 6 | **Sorting / selection** | `zones.ts` `percentile()` | Full `.sort()` to get a p85. Correct, but O(N log N) where O(N) selection would do. |
| 7 | **Strings** | node/edge ids (`"row,col"`) | Used as map keys. Composite-key encoding, nothing more. |

And the honest gaps — foundations a senior would expect but the repo does
**not yet exercise**:

| Missing foundation | Where it would belong | Why it matters |
|--------------------|----------------------|----------------|
| **Spatial index (k-d tree / grid)** | `nearest.ts` | `nearestNode` is O(N) per snap — the single clearest algorithmic gap. |
| **Decrease-key heap** | `pqueue.ts` | The repo uses lazy deletion instead. A defensible choice — but you should know the alternative. |
| **Union-find (DSU)** | connectivity preflight | "Is goal even reachable?" is currently answered by running the full search. |
| **Binary search** | sorted lookups | `nearestNode` and `zones` both do linear scans where a sorted structure could binary-search. |
| **Quickselect** | `zones.ts` percentile | A full sort to find one percentile is selection done the expensive way. |
| **Trie** | — | No prefix/autocomplete surface yet (address bar is in `mobile/`). |
| **Dynamic programming** | — | No overlapping-subproblem structure in the repo. |

You've **already built** most of these in `reincodes` (BinaryHeap,
PriorityQueue with `updatePriority`, Graph BFS/DFS, connected-components,
all five sorts). The practice map (file 08) maps each gap to the
reincodes implementation you can lift from.

---

## Reading order

```
  00-overview.md            ← you are here
  01-complexity-and-cost-models.md      cost models, BLOCKED, amortized heap
  02-arrays-strings-and-hash-maps.md    g / came / closed / adjacency
  03-stacks-queues-deques-and-heaps.md  PQueue: the binary min-heap
  04-trees-tries-and-balanced-indexes.md the heap-as-tree; the index gaps
  05-graphs-and-traversals.md           ★ the spine: A*, Dijkstra, bidir
  06-sorting-searching-and-selection.md percentile sort; the search gaps
  07-recursion-backtracking-and-dynamic-programming.md  reconstruct; DP gap
  08-dsa-foundations-practice-map.md    ranked plan: exercised → missing
```

Start with **05** if you want the payoff first — it's the spine, and
everything else is in service of it. Read **01** first if you want the
cost-model framing (`BLOCKED`, amortized heap) that the rest leans on.

---

## not yet exercised — the honest list

So you don't go looking for these in the code: **spatial indexing,
decrease-key, union-find, binary search, quickselect, tries, dynamic
programming, balanced BSTs (red-black/AVL), B-trees, segment trees,
suffix structures.** None are in `features/` or `pipeline/`. Each is
named where it would belong, in the file that owns that family.

---

## Cross-links to sibling guides

- **system-design** — owns the architectural shape (static `graph.json`
  artifact, mobile/engine split). This guide owns the algorithms inside.
- **performance-engineering** — owns the `bench/` harness and latency
  budgets; this guide owns the complexity that drives them.
- **runtime-systems** — owns the JS execution model the heap runs on.
- **data-modeling** — owns the `Graph`/`Node`/`Edge` schema shape; this
  guide owns how the algorithms traverse it.
