# Recursion, backtracking & dynamic programming

**Industry names:** recursion / iterative-recursion · backtracking · dynamic
programming (memoization / tabulation) · optimal substructure · path
reconstruction. **Type:** Industry standard. The repo uses **iterative path
reconstruction** (the iterative form of a recursive walk) and **spatial
bucketing** (a fold/aggregation). Backtracking and classic DP are
`not yet exercised`; this file teaches them and names where they'd land.

---

## Zoom out, then zoom in

Three of this file's ideas show up in `flattr`, all in the *aggregation* and
*reconstruction* corners, not the search loop itself. The came-from walk that
turns A\*'s result into a route is the iterative form of a recursive
back-pointer trace. The zone bucketing is a fold. And A\*'s own correctness rests
on **optimal substructure** — the same property DP exploits.

```
  Zoom out — where these ideas live

  ┌─ Search layer ─────────────────────────────────────────────────┐
  │  A* relies on OPTIMAL SUBSTRUCTURE (the DP property)             │
  │  reconstruct() — iterative back-pointer walk  ← ★ recursion form │
  │  features/routing/astar.ts:86-103                               │
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ Aggregation layer ─────▼────────────────────────────────────────┐
  │  computeZones() — fold edges into grid buckets ← ★ aggregation   │
  │  features/grade/zones.ts:23-58                                    │
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ Stretch (NOT built) ───▼────────────────────────────────────────┐
  │  k-alternative routes via penalty method  ← ★ DP-adjacent (gap)  │
  │  spec §14.5                                                       │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: recursion is "solve a problem by solving a smaller version of itself."
DP is recursion where the *same* subproblem recurs and you cache it. Backtracking
is recursion that *undoes* choices to explore alternatives. `flattr` touches the
first and the substructure-property behind DP; it doesn't need backtracking or
memo tables because A\* already computes optimal subpaths greedily via the heap.

---

## The structure pass

**Layers.** These three techniques layer by *how they handle repeated/overlapping
work*:

```
  One question — "how is repeated work handled?" — across the techniques

  ┌──────────────────────────────────────────────┐
  │ PLAIN RECURSION  → recompute every subproblem  │  fine if no overlap
  └────────────────────┬───────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ MEMOIZATION (top-down DP) → cache results │  overlapping subproblems
       └───────────────┬─────────────────────────┘
           ┌───────────▼───────────────────────┐
           │ TABULATION (bottom-up DP)            │  build the table iteratively
           └───────────┬───────────────────────┘
               ┌───────▼─────────────────────┐
               │ BACKTRACKING → recurse + UNDO │  explore a state space, prune
               └───────────────────────────────┘  ← e.g. Rein's river-crossing PG.ts
```

**Axis = repeated work / state.** Hold "do subproblems overlap, and do we save
state?" constant. Plain recursion recomputes; DP caches; backtracking mutates and
restores. A\*'s relaxation (`astar.ts:69`) is *implicitly* DP: it keeps the best
cost to each node in the `g` map (`astar.ts:31`) — that map *is* a memo table for
"cheapest cost to reach node X." The seam is the `g` map: it's where A\* turns a
potentially exponential path-enumeration into a polynomial search by remembering
the best subpath cost to each node.

---

## How it works

### Move 1 — the mental model

You've written a recursive tree walk: visit a node, recurse into children, combine.
Path reconstruction is the *reverse* of that — follow a single chain of
back-pointers from the goal to the start. DP is the optimization you apply when a
naive recursion would recompute the same subanswer over and over: you cache it.

```
  Three shapes

  RECURSION (a chain)        DP / MEMO (a cached DAG)     BACKTRACKING (a pruned tree)
   goal                       f(5)                          [ ]
    │ back-pointer            ╱  ╲  ← f(3) computed once     ╱ │ ╲   try, recurse,
   prev                     f(4)  f(3)   reused              ●  ●  ●  undo if dead end
    │                       ╱ ╲   (cached)                  ╱╲    ╲
   prev                  f(3) f(2)                         ●  ✗    ●  prune
    │
   start                  ← reconstruct() is this chain (astar.ts:86-103)
```

### Move 2 — the moving parts

**Path reconstruction — iterative recursion via back-pointers.**
`reconstruct` (`astar.ts:86-103`) is a recursive idea written as a loop: start at
the goal, follow `came.get(cur)` to the predecessor, push the node and the edge,
repeat until you hit the start, then reverse. It's iterative (a `while` loop) not
recursive-with-the-call-stack — a deliberate choice, because a deep path would
blow the call stack, and the loop is the same `O(path length)` work without that
risk.

```
  reconstruct goal→start (astar.ts:92-100)

  came = { G:{edge:ag, prev:A}, A:{edge:sa, prev:S} }   start=S goal=G
  cur=G  push G        nodes=[G]
         entry=came[G]={ag,A}  push edge ag  cur=A  push A  nodes=[G,A]
  cur=A  entry=came[A]={sa,S}  push edge sa  cur=S  push S  nodes=[G,A,S]
  cur=S == start → stop
  reverse → nodes=[S,A,G] edges=[sa,ag]   ← the route, in travel order
```

The load-bearing subtlety: it records `entry.edge` — the *exact edge the search
relaxed* — not a re-lookup by node pair. With parallel edges (two A→B blocks), a
node-pair re-lookup could report the wrong one (**05**, the parallel-edge trap,
`astar.test.ts:102-128`). The back-pointer carries the *identity* of the choice,
not just the endpoints.

**Optimal substructure — the property A\* (and DP) exploit.** A shortest path
from S to G through some node X contains *within it* a shortest path from S to X.
That's optimal substructure, and it's exactly why A\* can be greedy: when it
finalizes X (closes it), it has X's optimal cost and never needs to reconsider it.
The `g` map (`astar.ts:31`) is the memo table — "best cost to reach each node so
far." *Without* optimal substructure (e.g. if cost depended on the whole prior
path, not just the current node), A\* would be wrong and you'd need full
enumeration or DP over richer states.

```
  Optimal substructure → A* as implicit DP

  g map = memo of "cheapest cost to reach this node"  (astar.ts:31)
  relax (astar.ts:69):  if tentative < g[next] → update
        └─ this IS the DP recurrence:
           bestCost[next] = min over edges (bestCost[cur] + edgeCost)
  closed set = "this subproblem is SOLVED, don't recompute"  (astar.ts:61)
```

**Spatial bucketing — a fold / aggregation.** `computeZones` (`zones.ts:23-58`)
isn't recursion, but it's the other half of this file's territory: reducing many
items to per-group summaries. It folds the edge list into a `Map<"col,row",
number[]>` (group edges by grid cell), then maps each bucket to its p85
(`zones.ts:53`). Group-then-reduce is the shape behind histograms, GROUP BY, and
MapReduce.

```
  computeZones fold (zones.ts:31-57)

  edges ──group-by-cell──► Map{ "0,0":[4,10], "3,1":[5] } ──reduce──► cells
          (midpoint → col,row)                              (p85 each)
   step 1: bucket each edge by geometry midpoint  (zones.ts:31-42)
   step 2: per bucket, value = percentile(grades, 0.85)  (zones.ts:45-56)
   empty cells never created → omitted (zones.ts:44 iterates only seen buckets)
```

### Move 2.5 — current state vs future state

Reconstruction and bucketing ship. Backtracking and explicit DP are absent; the
nearest future use is k-alternative routes.

```
  Phase A (shipped)                Phase B (spec §14.5, not built)
  ┌────────────────────────┐       ┌──────────────────────────────────────┐
  │ reconstruct (iterative) │       │ k-alternative routes (penalty method): │
  │ computeZones (fold)     │  ───► │   1. run A*, get best path             │
  │ implicit DP via g map   │       │   2. inflate cost of its edges         │
  │                         │       │   3. re-run → a DISTINCT 2nd-best path │
  └────────────────────────┘       │   repeat k times                       │
                                    └──────────────────────────────────────┘
  the penalty method is iterated-search-with-state, the DP-adjacent stretch.
  flattr's alternatives.ts is named in spec §9 but NOT implemented.
```

### Move 3 — the principle

**When subproblems overlap and have optimal substructure, remember answers
instead of recomputing them.** A\* embodies this: the `g` map is a memo table, the
`closed` set marks solved subproblems, and reconstruction reads the recorded
choices back. You rarely need an explicit DP table when a graph search with a
visited set already gives you the memoization for free — recognizing that A\* *is*
DP over the node-cost subproblem is the insight that connects this file to **05**.

---

## Primary diagram

The recursion/DP ideas as they actually appear in the repo.

```
  flattr's recursion & DP surface

  ┌─ implicit DP (in the search, astar.ts) ───────────────────────┐
  │  g map     = memo: cheapest cost per node    (astar.ts:31,69)  │
  │  closed    = "subproblem solved"             (astar.ts:61)     │
  │  optimal substructure ⟹ greedy finalize is correct            │
  └─────────────────────────┬──────────────────────────────────────┘
  ┌─ reconstruction (astar.ts:86-103) ──────────▼─────────────────┐
  │  back-pointer chain goal→start, carries EDGE IDENTITY          │
  │  iterative (no call stack) · O(path length) · reverse at end   │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ aggregation (zones.ts:23-58) ─────────────────────────────────┐
  │  fold: group edges by cell → reduce each to p85                 │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ GAPS: backtracking (state-space search) · explicit DP tables · │
  │        k-alternatives penalty method (spec §14.5)               │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Reconstruction runs at the end of every successful search
(`astar.ts:53`, `bidirectional.ts:121-143`). Bucketing runs once to build the
heatmap. The implicit DP runs continuously inside the search loop.

```
  features/routing/astar.ts  (lines 92-100)  — reconstruct (iterative back-walk)

  const nodes = [goalId]; const edges = [];
  let cur = goalId;
  while (cur !== startId) {              ← walk back until we reach the start
    const entry = came.get(cur)!;        ← the back-pointer for this node
    edges.push(entry.edge);              ← record the EXACT relaxed edge
    cur = entry.prev;                    ← step to the predecessor
    nodes.push(cur);
  }
  nodes.reverse(); edges.reverse();      ← we built it goal→start; flip it
       │
       └─ iterative, not recursive, on purpose: a long path would overflow the
          call stack with recursion. pushing entry.edge (not re-resolving by
          node pair) is what keeps parallel edges correct (astar.test.ts:102-128).
          This is the reverse of a recursive tree descent — a single chain.
```

```
  features/grade/zones.ts  (lines 31-42)  — the bucketing fold

  for (const e of graph.edges) {                    ← fold over all edges
    const midLat = (first[0]+last[0])/2;            ← group key from geometry
    const midLng = (first[1]+last[1])/2;
    const col = clamp(Math.floor((midLng-minLng)/cellW));
    const row = clamp(Math.floor((midLat-minLat)/cellH));
    const arr = buckets.get(`${col},${row}`);
    if (arr) arr.push(e.absGradePct);               ← accumulate into the group
    else buckets.set(`${col},${row}`, [e.absGradePct]);  ← new group
  }
       │
       └─ group-then-reduce: this loop is the GROUP BY, percentile() (zones.ts:53)
          is the aggregate. clamp keeps a midpoint exactly on the bbox edge inside
          the grid (zones.ts:29) — without it a boundary edge indexes out of range.
```

---

## Elaborate

Recursion is as old as the call stack; the insight that *overlapping* recursive
subproblems should be cached is Bellman's dynamic programming (1950s) — the
shortest-path connection is direct, since Bellman-Ford and Dijkstra are both DP
over "best cost to each node." A\* is the goal-directed, heuristic-pruned member
of that family (**05**). Backtracking (exploring a state space with undo) powers
constraint solvers, puzzles, and parsers — Rein's `reincodes/PG.ts` (river-crossing
puzzle via BFS over an implicit state graph) is the closest built example, and
the place a `flattr` feature like "route avoiding a list of blocked streets" might
eventually need it. The k-alternative-routes penalty method (spec §14.5,
`alternatives.ts` named but unbuilt) is the repo's most concrete DP-adjacent
stretch: iterated search with accumulated state. Next read: **05** for the search
this all hangs off, and **08** for where to practice the gaps.

**`not yet exercised` — explicit DP tables and backtracking.** No memo table, no
tabulation, no backtracking search in the repo. They'd matter for: k-shortest /
k-alternative routes (penalty method or Yen's algorithm), constraint-based
routing (avoid a set, visit waypoints in order), and build-time graph validation.
The implicit DP in A\*'s `g` map covers the single-shortest-path case, which is
all v1 needs.

---

## Interview defense

**Q: "Is there any dynamic programming in this routing engine?"**

Yes — implicitly. A\*'s `g` map (`astar.ts:31`) is a memo table of "cheapest cost
to reach each node," and the relaxation (`astar.ts:69`) is the DP recurrence
`bestCost[next] = min(bestCost[cur] + edgeCost)`. The `closed` set marks solved
subproblems. It works because shortest paths have optimal substructure — a
shortest S→G path contains a shortest S→X path for any X on it.

```
  g map = memo · relax = recurrence · closed = "solved"
  optimal substructure ⟹ greedy finalize correct ⟹ no explicit table needed
  anchor: astar.ts:31,61,69
```

**Q: "Why is reconstruction iterative and not recursive?"**

A long path would overflow the call stack with recursion. The `while` loop does
the same `O(path length)` back-pointer walk without that risk (`astar.ts:92-100`).
And it records the exact relaxed edge, not a node-pair re-lookup, so parallel
edges stay correct.

**Q: "Where would backtracking show up if you extended this?"**

Constraint routing — "avoid these streets" or "visit waypoints in order" — is a
state-space search that explores and undoes choices. The penalty method for
k-alternatives (spec §14.5) is the nearest planned thing: run A\*, inflate the
used edges' cost, re-run for a distinct path.

---

## Validate

1. **Reconstruct:** Write the back-pointer walk from `astar.ts:92-100` from
   memory, including why it reverses at the end.
2. **Explain:** Why is A\*'s `g` map a memo table, and what property of shortest
   paths makes the greedy `closed`-finalize correct?
3. **Apply:** Trace `computeZones` (`zones.ts:31-42`) bucketing two edges with
   midpoints `[0.1,0.1]` and `[0.2,0.2]` over a 2×2 grid on bbox `[0,0,1,1]`;
   check against `zones.test.ts:45-55`.
4. **Defend:** Argue why reconstruction is iterative not recursive, and why it
   stores `entry.edge` rather than re-resolving by node pair
   (`astar.test.ts:102-128`).

---

## See also

- **05-graphs-and-traversals.md** — the search whose `g` map is the implicit DP.
- **06-sorting-searching-and-selection.md** — `percentile`, the reduce step of the fold.
- **02-arrays-strings-and-hash-maps.md** — the `Map` buckets and `g`/`came` memo tables.
- **08-dsa-foundations-practice-map.md** — where to drill backtracking and DP.
