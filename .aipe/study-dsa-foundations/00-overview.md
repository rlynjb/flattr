# DSA Foundations — flattr

> The reusable data-structures-and-algorithms vocabulary behind flattr's
> hand-rolled grade-aware router — plus the foundations the repo deliberately
> doesn't exercise yet, ranked so you know what to practice next.

The whole guide hangs off one file: `features/routing/astar.ts`. That single
`search()` at line 22 is Dijkstra, A*, grade-A*, and directed-A* — all four —
selected by which `(costFn, heuristicFn)` pair you hand it. Everything else in
the routing package is the supporting cast: the heap that orders the frontier
(`pqueue.ts`), the maps that hold `g`/`came`/`closed` (`astar.ts`), the
adjacency that models the graph (`graph.ts`), the cost shaping (`cost.ts`), and
the percentile sort that builds the heatmap (`grade/zones.ts`).

## The system in one diagram

The DSA spine of flattr, top to bottom — every concept file in this guide marks
one band of this picture.

```
  flattr's routing engine — which DSA primitive lives where

  ┌─ Entry layer ─────────────────────────────────────────────┐
  │  nearestNode()  ──snap tap→node id──►  search()            │
  │  nearest.ts:5    O(N) linear scan      astar.ts:22         │
  └────────────────────────────┬──────────────────────────────┘
                               │  startId, goalId, userMax
  ┌─ Algorithm layer ──────────▼──────────────────────────────┐
  │  search()  — one parametric Dijkstra/A* loop               │
  │    open    : PQueue<string>     ← frontier ordering        │
  │    g       : Map<string,number> ← best cost so far         │
  │    came    : Map<string,{edge}> ← reconstruction trail     │
  │    closed  : Set<string>        ← finalized nodes          │
  └──────┬───────────────────────┬─────────────────────┬──────┘
         │ push/pop              │ costFn(edge,…)       │ adjacency[id]
  ┌─ Structure layer ──▼──┐ ┌────▼─────────┐ ┌──────────▼────────┐
  │ PQueue (binary heap)  │ │ cost.ts       │ │ graph.ts          │
  │ pqueue.ts             │ │ penalty()     │ │ adjacency + dir   │
  │ siftUp/siftDown       │ │ BLOCKED=1e9   │ │ otherEnd, grade   │
  └───────────────────────┘ └───────────────┘ └───────────────────┘

  ┌─ Side path: heatmap (not routing) ────────────────────────┐
  │  computeZones()  →  percentile()  ← full sort, O(M log M)  │
  │  grade/zones.ts:23   zones.ts:5                            │
  └────────────────────────────────────────────────────────────┘
```

## Ranked findings — verdict first

The honest read on flattr's DSA, ordered by how much it teaches you:

1. **The parametric `search()` is the centerpiece and it's genuinely good.**
   One loop, four algorithms, lazy-deletion frontier, closed-set skip,
   reconstruction off the exact relaxed edge. `astar.ts:22-78`. This is the
   file to be able to rebuild from memory. → `05-graphs-and-traversals.md`.

2. **The binary min-heap is hand-rolled and correct.** Array-backed,
   `siftUp`/`siftDown`, lazy deletion instead of decrease-key, NaN guard at
   `pqueue.ts:24`, a `checkInvariant()` oracle. `pqueue.ts:1-78`. You've built
   this before (`BinaryHeap.ts`, `PriorityQueue.ts` in reincodes) — flattr is
   the same primitive minus `updatePriority`. → `03-stacks-queues-deques-and-heaps.md`.

3. **The cost model is the most surprising design choice.** `BLOCKED = 1e9`
   is large-*finite*, not `Infinity` (`cost.ts:5`), so "only-steep route"
   stays distinct from "no route." That one constant is a correctness
   invariant, not a hack. → `01-complexity-and-cost-models.md`,
   `02-arrays-strings-and-hash-maps.md`.

4. **The optimality oracle is the test worth copying.** A* cost is asserted
   equal to Dijkstra cost (`astar.test.ts:38-45`) — a differential test that
   pins admissibility. → `05`, `06`.

5. **`nearestNode()` is the one real algorithmic gap that's exercised.**
   O(N) linear scan over every node on every tap (`nearest.ts:8`). Correct,
   but the place a k-d tree or grid index would earn its keep. →
   `04-trees-tries-and-balanced-indexes.md`, `06-sorting-searching-and-selection.md`.

6. **`zones.ts` sorts the whole array to read one percentile** (`zones.ts:6`).
   Fine at build-frequency; quickselect territory if it ever moved hot. →
   `06-sorting-searching-and-selection.md`.

## not yet exercised — the foundations to practice

These don't appear in flattr at all. The practice map (`08`) ranks them; each
concept file flags its own gaps inline with `not yet exercised`.

- **k-d tree / spatial grid index** — would replace `nearest.ts`'s O(N) scan.
- **decrease-key heap (indexed PQ)** — flattr uses lazy deletion instead; you
  *did* build `updatePriority` in reincodes' `PriorityQueue.ts`.
- **union-find / DSU** — no connectivity-under-union anywhere.
- **binary search** — no sorted-array lookup; `percentile` interpolates a rank
  but never bisects.
- **quickselect** — `zones.ts` full-sorts where partition-select would do.
- **trie** — no prefix structure (would matter for address autocomplete).
- **dynamic programming** — no memoized subproblem tables; the router is greedy
  best-first, not DP.

## Reading order

```
  01  complexity-and-cost-models           ← the cost model + BLOCKED invariant
  02  arrays-strings-and-hash-maps          ← adjacency, g/came/closed, byId index
  03  stacks-queues-deques-and-heaps        ← the PQueue (the frontier engine)
  04  trees-tries-and-balanced-indexes      ← mostly gaps (k-d tree for nearest)
  05  graphs-and-traversals                 ← THE SPINE: search() + bidirectional
  06  sorting-searching-and-selection       ← percentile sort, the binary-search gap
  07  recursion-backtracking-and-dynamic-programming  ← reconstruct(); DP gap
  08  dsa-foundations-practice-map          ← ranked plan: exercised → missing
```

Read `05` first if you only read one — it's the centerpiece. `01` and `03`
are its prerequisites. `04`, `06`, `07` are where the gaps live.

## Cross-links to sibling guides

- **system-design** owns the architectural shape (static `graph.json`,
  build-time pipeline, the four-stage progression as a product story). This
  guide owns the *algorithms inside* those boxes.
- **performance-engineering** owns the benchmark harness (`bench/`) as a
  measurement discipline; this guide owns the complexity classes it measures.
- **testing** owns the oracle pattern as a testing technique; this guide owns
  why the A*==Dijkstra equality is *algorithmically* load-bearing.
- **runtime-systems** owns the event loop / async; flattr's router is
  synchronous CPU work, so the overlap is thin.
