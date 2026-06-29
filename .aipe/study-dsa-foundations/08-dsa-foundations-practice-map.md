# DSA Foundations — Practice Map

**Industry name:** a ranked learning plan. **Type:** Project-specific.

This is the file that turns the guide into a to-do list. It ranks what to
practice, exercised foundations first (to deepen what flattr already
proves you can do), then the missing foundations in order of leverage —
each one anchored to where it'd land in *this* repo and to the reincodes
implementation you can lift from. No new concepts here; this is the map.

---

## Zoom out — the whole plan in one frame

```
  Practice map — confidence (built) → leverage (gaps)

  ┌─ TIER 1: exercised in flattr — deepen, don't relearn ───────┐
  │  A* / Dijkstra (one engine)   graphs+traversal   file 05   │
  │  binary min-heap (lazy del.)  heaps              file 03   │
  │  hash-map bookkeeping         arrays/maps        file 02   │
  │  reconstruction (exact edge)  recursion          file 07   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ TIER 2: missing, HIGH leverage in this repo ───────────────┐
  │  1. spatial index (k-d/grid)  → nearest.ts O(N) → O(log N) │
  │  2. union-find (DSU)          → connectivity preflight      │
  │  3. quickselect               → zones.ts sort → O(n) select │
  └──────────────────────────────────────────────────────────────┘
  ┌─ TIER 3: missing, LOWER leverage / no home yet ─────────────┐
  │  4. decrease-key heap         → alt to lazy deletion        │
  │  5. binary search             → needs a kept-sorted index   │
  │  6. dynamic programming       → only if K-steep constraint  │
  │  7. trie                      → only if offline autocomplete│
  └──────────────────────────────────────────────────────────────┘
```

---

## Structure pass — the ranking axis

The axis that orders this list is **leverage = (cost flattr pays today) ×
(how close you already are to building the fix)**. A gap ranks high when
the repo genuinely pays for its absence *and* you've built something
adjacent in reincodes, so the practice is short.

```
  Axis: "leverage" — repo cost × your readiness

                 high readiness (built it before)
                        ▲
        union-find ●    │    ● spatial index   ← do these first
        quickselect●    │    ● decrease-key
        ────────────────┼────────────────► high repo cost
                        │
        trie       ●    │    ● binary search
        DP         ●    │                       ← do these last
                        ▼
                 low readiness / no repo home
```

---

## Tier 1 — exercised foundations (deepen what flattr proves)

You don't need to *learn* these — flattr demonstrates them. The practice
is to be able to defend the *design choices*, which the interview-defense
blocks in files 02/03/05/07 already drill. Quick self-check:

| Foundation | The non-obvious thing to be able to explain | File |
|-----------|---------------------------------------------|------|
| A* = Dijkstra + h | one parametric `search()`; Dijkstra is `h=0`; optimality oracle test | 05 |
| Binary heap | lazy deletion *instead of* decrease-key; closed-set skips stale | 03 |
| Hash bookkeeping | `byId` built once so the hot loop is `O(1)`, not `O(E)` | 02 |
| Reconstruction | store the *exact edge*, not the node pair (parallel edges) | 07 |
| `BLOCKED=1e9` | large-finite keeps "steep" distinct from "no route" | 01 |
| Undirected storage | direction derived at traversal via `directedGrade` | 05 |

If you can give the interview-defense answers in those files cold, Tier 1
is done.

---

## Tier 2 — high-leverage gaps (build these)

### 2.1 — Spatial index for `nearest.ts`  ★ top priority

- **What to build:** replace the `O(N)` linear scan in `nearestNode`
  (`nearest.ts:5-18`) with a grid index — bucket nodes by cell exactly
  like `zones.ts` buckets edges (`zones.ts:27-42`) — or a k-d tree.
- **Why it earns the top spot:** it's the single clearest algorithmic gap
  in the repo (file 04). `nearestNode` runs twice per route; on a full
  city `graph.json` the snap can rival the search itself. And the fix is
  already half-written one file over.
- **Anchor — you've already built it:** reincodes `BinarySearchTree.ts`
  gives you the node-and-pointer tree machinery a k-d tree needs; the grid
  variant just reuses the `zones.ts` bucketing you can read right now.
- **Done when:** `nearestNode` returns the same node as the linear scan on
  the existing `nearest.test.ts` fixtures, in `O(log N)`/`O(1)`-avg, with
  a benchmark in `bench/` showing the win on a large graph.

### 2.2 — Union-find (disjoint-set) connectivity preflight

- **What to build:** a DSU over `graph.edges` that answers "are start and
  goal in the same connected component?" *before* running the full search.
- **Why it matters here:** today, "is the goal reachable?" is answered by
  running the entire A* and getting `null` (`astar.ts:77`). On a
  disconnected graph that's a full wasted flood. A DSU built once at load
  answers it in near-`O(1)`.
- **Anchor — you've already built it:** reincodes `Graph.ts` has
  `numberOfConnectedComponents` — that's connectivity via traversal. DSU is
  the same question answered with path-compression + union-by-rank instead
  of BFS, and it stays cheap under repeated queries.
- **Done when:** a `sameComponent(start, goal)` check short-circuits a
  disconnected query to `null` without entering the search loop, proven by
  a test mirroring `astar.test.ts:91-96`.

### 2.3 — Quickselect for `zones.ts` percentile

- **What to build:** a `select(values, k)` that finds the rank-`k` element
  via partitioning, and rewire `percentile` (`zones.ts:5-14`) to use it
  instead of a full `.sort()`.
- **Why it's Tier 2 not higher:** `zones.ts` is build-time over small
  per-cell arrays, so the *runtime* win is small (file 06 is honest about
  this). It ranks here because the practice value is high and you're one
  deletion away from it.
- **Anchor — you've already built it:** quickselect is quicksort with one
  recursive branch removed, and you animated quicksort's partition in
  reincodes (`utils/notes/Sorting/`).
- **Done when:** `percentile` matches the sort-based result on
  `zones.test.ts` inputs while doing `O(n)`-average selection.

---

## Tier 3 — lower-leverage / no-home-yet gaps (study, build if curious)

### 3.1 — Decrease-key heap

- **What:** add `updatePriority` (value→index map) to `pqueue.ts` and have
  the search call it instead of pushing duplicates.
- **Why lower:** lazy deletion is a *defensible* choice (file 03), not a
  bug. This is "know the alternative," not "fix a flaw."
- **Anchor:** you've already built this — reincodes `PriorityQueue.ts` has
  `updatePriority` and the value→index lookup. flattr deliberately took the
  *other* fork. Building it here makes you able to argue both sides.
- **Done when:** a decrease-key variant matches the lazy-deletion router's
  paths with zero stale pops (`SearchResult.pops` drops).

### 3.2 — Binary search

- **Why it has no home yet:** flattr keeps nothing sorted to search
  (file 06). It becomes relevant only if you add a sorted index — e.g.,
  nodes sorted by latitude for a strip-based nearest-neighbor (but the
  spatial index in 2.1 is the better fix for that exact need).
- **Study, don't force into the repo.**

### 3.3 — Dynamic programming

- **Why no home:** no overlapping-subproblem structure in the product
  today (file 07). It enters only with a new constraint like "≤ K steep
  segments" or "minimize climb under a distance budget," which makes the
  state `node × budget`.
- **Practice anchor:** reincodes recursion-with-memoization patterns are
  the on-ramp; the flattr-relevant version is constrained shortest path.

### 3.4 — Trie

- **Why no home:** no prefix/autocomplete surface in the engine; the
  address bar lives in `mobile/` and uses geocoding (`pipeline/geocode.ts`),
  not local prefix matching. Only relevant if you build offline address
  suggestions.

---

## The honest summary

```
  flattr's DSA report card

  graphs / traversal   ████████████  shipped, tested, optimal-oracle gated
  heaps / PQ           ████████████  hand-rolled, lazy-deletion, invariant-tested
  hash maps / sets     ████████████  the bookkeeping spine
  recursion / reconstr ██████████░░  iterative backtrack, exact-edge correct
  complexity models    ██████████░░  BLOCKED=1e9 is a real cost-model decision
  sorting / selection  ██████░░░░░░  one full sort; selection would be leaner
  spatial indexing     ░░░░░░░░░░░░  NOT exercised — the top gap (nearest.ts)
  union-find           ░░░░░░░░░░░░  NOT exercised — connectivity preflight gap
  binary search        ░░░░░░░░░░░░  NOT exercised — no sorted index
  dynamic programming  ░░░░░░░░░░░░  NOT exercised — no overlapping subproblems
  tries                ░░░░░░░░░░░░  NOT exercised — no prefix surface
```

The repo is strong exactly where your reincodes portfolio is strong —
graphs, heaps, recursion. The three highest-leverage gaps (spatial index,
union-find, quickselect) are all ones where you've **already built the
adjacent structure** in reincodes, so each is a short hop. Start with the
spatial index: it's the clearest cost flattr pays, and the grid-bucketing
fix is already sitting in `zones.ts`.

---

## See also

- `00-overview.md` — the verdict table this plan ranks.
- `04-trees-tries-and-balanced-indexes.md` — the spatial index gap in full.
- `05-graphs-and-traversals.md` — the union-find connectivity gap.
- `06-sorting-searching-and-selection.md` — the quickselect gap.
- sibling **performance-engineering** — the `bench/` harness to measure
  each fix.
