# DSA Foundations — flattr

> The repo's whole point is hand-rolled graph algorithms. This guide is the
> centerpiece of the study set: it teaches the reusable data-structures-and-
> algorithms vocabulary that explains `flattr`'s routing engine, grounded in
> real `file:line` evidence, and names the foundations the repo does **not**
> yet exercise so you can practice them deliberately.

`flattr` is a grade-aware A\* router. You type a start and a goal, the engine
walks a grade-annotated street graph, and it returns the *flattest comfortable*
path — not the shortest. Everything keys off one knob, `userMax` (your max
comfortable uphill grade). The intelligence is in the **cost function**
(`features/routing/cost.ts`), not the search; the search is textbook A\* done
correctly.

---

## The repo in one diagram

The whole DSA surface, as layers, with each concept file's home marked.

```
  flattr — DSA layers (★ = a concept file in this guide)

  ┌─ Input / spatial layer ───────────────────────────────────────┐
  │  nearestNode()        ★ linear nearest-neighbor scan           │
  │  features/routing/nearest.ts   → 05 graphs, 06 searching       │
  └─────────────────────────┬──────────────────────────────────────┘
                            │ snapped start/goal node ids
  ┌─ Graph model layer ─────▼──────────────────────────────────────┐
  │  Graph = nodes + edges + adjacency      ★ adjacency list        │
  │  directedGrade() — directed travel over undirected storage      │
  │  features/routing/graph.ts, types.ts   → 02 hash-maps, 05 graphs│
  └─────────────────────────┬──────────────────────────────────────┘
                            │ adjacency[nodeId] -> edgeIds
  ┌─ Search layer ──────────▼──────────────────────────────────────┐
  │  search()  — Dijkstra / A* / grade / directed (one engine)      │
  │  bidirectional()  — meet-in-the-middle    ★ graph search        │
  │  PQueue  — binary min-heap, lazy deletion ★ heap / pqueue       │
  │  features/routing/{astar,bidirectional,pqueue}.ts → 03, 05      │
  └─────────────────────────┬──────────────────────────────────────┘
                            │ cost per edge
  ┌─ Cost / aggregation layer ──────────────────────────────────────┐
  │  penalty()  — signed directed-grade → routing weight            │
  │  computeZones()  — edges → grid cells, p85   ★ bucketing+select │
  │  percentile()  — sort + interpolate          → 06 sort/select   │
  │  features/routing/cost.ts, features/grade/zones.ts              │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Verdict-first findings — ranked by what carries the weight

**1. One parametric search engine, five named stages. The biggest design win.**
`features/routing/astar.ts:22-78` is a single `search()` function. Dijkstra, A\*,
grade-A\*, and directed-A\* are *not* separate algorithms — they're four
`(costFn, heuristicFn)` argument pairs (`astar.ts:135-163`). That collapse is the
strongest signal in the repo: it proves you understand that Dijkstra is A\* with
a zero heuristic, and that the domain (grade) lives entirely in the cost
function, never in the search. See **05-graphs-and-traversals.md**.

**2. The priority queue is a correct, lazy-deletion binary min-heap.**
`features/routing/pqueue.ts` — sift-up on push, sift-down on pop, no
decrease-key. Stale entries are tolerated and skipped at pop time
(`astar.ts:51`). This is the right first choice (spec §14.3 says so explicitly).
The `checkInvariant()` test hook (`pqueue.ts:42-48`) and the oracle property
tests (`pqueue.test.ts:23-99`) are how the heap invariant is *proven*, not
assumed. See **03-stacks-queues-deques-and-heaps.md**.

**3. The heuristic is admissible by construction — that's why A\* stays optimal.**
`haversineHeuristic` (`astar.ts:9`) is straight-line distance; every cost is
`length * (1 + penalty)` with `penalty >= 0` (`cost.ts:16-22`), so cost `>=`
length and the heuristic never overestimates. The test
`astar.test.ts:38-45` is a correctness gate: A\* must return the *exact same
cost* as Dijkstra. See **05** and the admissibility walk inside it.

**4. `BLOCKED` is large-finite, not Infinity — a deliberate graph-state choice.**
`cost.ts:5` sets `BLOCKED = 1e9`. This separates "no flat route" (a path exists
but crosses steep edges, flagged in `path.steepEdges`) from "no route"
(genuinely disconnected, returns `null`). `astar.test.ts:82-96` and
`pqueue.test.ts:101-106` lock this invariant. It's a cost-model decision with
graph-theoretic consequences. See **05** and **01-complexity-and-cost-models.md**.

**5. Adjacency is an undirected hash-map; direction is derived at traversal.**
`graph.ts:22-29` builds `Record<string, string[]>` (node id → incident edge
ids). One physical edge; `directedGrade()` (`graph.ts:17-19`) flips the sign
based on which end you entered from. This is open-decision F-(1) from the spec
(§11): derive, don't materialize. See **02-arrays-strings-and-hash-maps.md** and
**05**.

**6. Bidirectional A\* with a balanced consistent potential — the hardest code.**
`features/routing/bidirectional.ts` runs two frontiers and uses the potential
`pf(n) = (h(n,goal) - h(n,start)) / 2` (`bidirectional.ts:30-32`) so both
directions stay consistent and the `topF + topR >= mu` stopping rule
(`bidirectional.ts:52`) is correct. This is the subtlest correctness argument in
the repo. See **05**.

**7. Spatial bucketing + percentile selection for the heatmap.**
`computeZones()` (`zones.ts:23-58`) tiles the bbox into a grid, assigns each edge
to a cell by geometry midpoint, and stores the p85 of each cell's grades.
`percentile()` (`zones.ts:5-14`) sorts then linearly interpolates. See
**06-sorting-searching-and-selection.md** and **04-trees-tries-and-balanced-indexes.md**
(for what a spatial *index* would replace this with).

---

## What is `not yet exercised`

The repo is graph-and-heap heavy. These reusable foundations the spec's concept
inventory asks me to cover are absent here; each file teaches the foundation
briefly and says when it would become relevant.

| Foundation | Status | Where it would land |
|---|---|---|
| Trees / BSTs / balanced indexes | `not yet exercised` | spatial index (k-d tree / R-tree) to replace `nearest.ts`' linear scan — see **04** |
| Tries | `not yet exercised` | address autocomplete in the mobile UI — see **04** |
| Union-Find (DSU) | `not yet exercised` | connected-component check on the graph (is start reachable from goal at all?) — see **05** |
| Binary search | `not yet exercised` | `nearest.ts` is a linear scan; sorted-coordinate binary search is the cheap upgrade — see **06** |
| Quickselect / heap-select | `not yet exercised` | `percentile()` fully sorts; a selection algorithm avoids it — see **06** |
| Dynamic programming | `not yet exercised` | k-alternative routes via the penalty method touch DP ideas — see **07-recursion-backtracking-and-dynamic-programming.md** |
| Decrease-key heap | `not yet exercised` | the PQueue uses lazy deletion; decrease-key is the documented upgrade path — see **03** |

---

## Reading order

```
  01  complexity-and-cost-models          ← the lens you measure everything with
  02  arrays-strings-and-hash-maps        ← the Map/Record substrate under the graph
  03  stacks-queues-deques-and-heaps      ← PQueue: the engine's heartbeat
  04  trees-tries-and-balanced-indexes    ← mostly the gaps (spatial index, autocomplete)
  05  graphs-and-traversals               ← THE centerpiece: Dijkstra → A* → directed → bidirectional
  06  sorting-searching-and-selection     ← nearestNode, percentile, the search/select gaps
  07  recursion-backtracking-and-dp       ← reconstruction recursion + the DP gaps
  08  dsa-foundations-practice-map        ← ranked plan: exercised first, gaps second
```

Read **05** carefully — it's the longest and the point of the project. **03**
is its prerequisite (the heap is what makes A\* tractable). The rest orbit those
two.

## Cross-links to sibling guides

- `.aipe/study-performance-engineering/` — the bench harness (`bench/run.ts`)
  measures **nodes-expanded**, pushes, pops, and wall-clock ms; the "why each
  refinement exists" story is a performance argument as much as a DSA one.
- `.aipe/study-system-design/` — graph-as-prebuilt-artifact, client vs server
  A\* (spec open-decision D), tiling for scale.
- `.aipe/study-data-modeling/` — the `Node`/`Edge`/`Graph` schema and the
  signed-grade-by-direction modeling decision.
- `.aipe/study-runtime-systems/` — the search loop is synchronous and CPU-bound;
  bounded work and where it would need cancellation/yielding.
