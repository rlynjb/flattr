# Recursion, Backtracking & Dynamic Programming

**Industry names:** path reconstruction, back-pointer chasing,
backtracking, memoization, tabulation, optimal substructure.
**Type:** Industry standard.

---

## Zoom out — where this concept lives

flattr's clearest member of this family is **path reconstruction** — the
backtrack from goal to start through the `came` map. It's written
iteratively, but it *is* the backtracking shape, and it's the place to
anchor. Dynamic programming proper isn't in the repo — but A* itself
quietly has DP's defining property (optimal substructure), which is worth
naming precisely rather than skipping.

```
  Zoom out — recursion/backtracking/DP in flattr

  ┌─ Search produces back-pointers ─────────────────────────────┐
  │  astar.ts: came: Map<id, {edge, prev}>  (file 02)          │
  └───────────────────────────┬──────────────────────────────────┘
                              │ goal popped
  ┌─ Reconstruction (backtrack) ────────────────────────────────┐
  │  ★ reconstruct(came, start, goal)  → walk prev to start ★  │ ← we are here
  │     (iterative, but the backtrack-to-base-case shape)      │
  └──────────────────────────────────────────────────────────────┘
  ┌─ DP-adjacent (the property, not the technique) ─────────────┐
  │  A* relaxation: g[next] = min over paths   = optimal substr.│
  │  not yet exercised: tabulation / memoized recurrence        │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Reconstruction is a backtrack: start at the goal, follow
`prev` pointers until you hit the base case (the start), collecting edges
as you go. This file walks that, then names where DP would belong and why
A* already embodies its core idea without being "a DP."

---

## Structure pass — one axis across the family

These three are usually taught together because they share one axis:
**how is a big answer built from smaller answers?**

```
  Axis: "how does the solution compose from subproblems?"

  recursion     → solve(n) calls solve(smaller)    base case stops it
  backtracking  → recursion that UNDOES choices    explore → retreat
  DP            → recursion + remember subanswers   overlapping subproblems
  reconstruction→ follow a chain of stored sub-answers to a base case
```

The seam in flattr: reconstruction has the recursion/backtracking
*shape* (chain to a base case) but **no overlapping subproblems**, so it
needs no memoization — it's a single linear walk, not a tree of repeated
work. A* has the *optimal-substructure* half of DP (best path to a node =
best path to its predecessor + one edge) but builds it iteratively with a
priority queue instead of a recurrence. Naming which half each piece has
is the whole lesson.

---

## How it works

### Move 1 — the mental model

Backtracking is recursion that retraces its steps: you go forward making
choices, hit a base case or a dead end, and walk back. Reconstruction is
the *walk-back* without the forward exploration — the search already did
the forward part, leaving a trail of `prev` pointers. You just follow the
trail home.

```
  Reconstruction — follow prev to the base case

  goal ──prev──► N3 ──prev──► N2 ──prev──► N1 ──prev──► start
   │                                                      │
   │  collect edge at each hop                            │
   └──────────── base case: cur == start ────────────────┘
   then reverse → [start, N1, N2, N3, goal]
```

It's a linked-list traversal where the list is threaded through a hash map
(`came`). The base case is `cur === startId` — the equivalent of a
recursion's stopping condition.

### Move 2 — reconstruction, then the DP gap

#### `reconstruct()` — the backtrack walk

```ts
// features/routing/astar.ts:86-103
function reconstruct(came, startId, goalId) {
  const nodes = [goalId];
  const edges = [];
  let cur = goalId;
  while (cur !== startId) {            // ← base case: reached the start
    const entry = came.get(cur)!;
    edges.push(entry.edge);            // collect the EXACT edge relaxed
    cur = entry.prev;                  // step backward one hop
    nodes.push(cur);
  }
  nodes.reverse();                     // goal→start becomes start→goal
  edges.reverse();
  return { nodes, edges };
}
```

Execution trace — reconstruct a 3-node path S→A→G:

```
  reconstruct trace (came: G→{prev:A}, A→{prev:S})

  cur=G   nodes=[G]
    G != S → entry=came[G]={edge:ag, prev:A}
             edges=[ag], cur=A, nodes=[G,A]
  cur=A   A != S → entry=came[A]={edge:sa, prev:S}
             edges=[ag,sa], cur=S, nodes=[G,A,S]
  cur=S   S == S → stop (base case)
  reverse: nodes=[S,A,G], edges=[sa,ag]
```

This is the backtracking skeleton written as a `while` loop instead of a
recursive call — same shape, no stack-overflow risk on long paths. A
recursive version would call `reconstruct(came[cur].prev)` and unwind;
the iterative version makes the unwinding explicit with `.reverse()`.

#### The exact-edge subtlety — why it stores the edge, not the pair

Here's the part that's easy to get wrong and the repo gets right. `came`
stores the **exact edge object** that was relaxed, not just the previous
node. Why does that matter? Because two parallel edges can connect the
same node pair — a short-steep street and a long-flat one between the same
intersections.

```ts
// astar.ts:71 — stores the edge, not just the node pair
came.set(next, { edge, prev: current });
```

```
  Parallel edges — why the exact edge must be stored

  A ═══[short-steep, 50m, 20%]═══► B
  A ───[long-flat,  100m,  0%]───► B

  directed grade router relaxes the LONG-FLAT edge (steep is penalized)

  ┌─ store node pair only ──────────┐  ┌─ store exact edge (actual) ─────┐
  │ reconstruct re-resolves (A,B)   │  │ reconstruct reports long-flat   │
  │ → might pick short-steep        │  │ → correct edge, correct length, │
  │ → wrong length, wrong steepEdge │  │   correct steepEdges            │
  └─────────────────────────────────┘  └──────────────────────────────────┘
```

The test pins this exactly: a graph with two parallel A→B edges, the grade
router picks the flat one, and reconstruction must report `["long-flat"]`
with `lengthM: 100` and empty `steepEdges` (`astar.test.ts:102-128`). The
docstring on `reconstruct` says it outright: *"Using the relaxed edges —
not re-resolving by node pair — keeps cost/steepEdges correct when parallel
edges share a node pair"* (`astar.ts:80-85`). `bidirectional.ts:119-144`
does the same thing on both halves of its split path.

#### not yet exercised — dynamic programming

There's no DP in flattr: no memoization table, no tabulation, no recurrence
solved bottom-up. But here's the precise thing to say in an interview
rather than just "no DP": **A* has optimal substructure** — DP's first
prerequisite — but **not overlapping subproblems** in the DP sense.

```
  A* vs dynamic programming — what's shared, what isn't

  shared:    optimal substructure
             best path to N = best path to N's predecessor + edge(pred→N)
             (this is the relaxation: g[next] = min(g[next], g[cur]+cost))

  NOT shared: DP solves a fixed table of subproblems bottom-up
             A* solves them lazily, priority-ordered, pruned by heuristic
             → A* is "DP guided by a heuristic over an implicit graph"
```

`g.set(next, tentative)` in `astar.ts:70` *is* the optimal-substructure
update — it's the same `dist[v] = min(dist[v], dist[u]+w)` you'd write in a
DP shortest-path table. The difference: a DP (Bellman-Ford, Floyd-Warshall)
computes *all* subproblems in a fixed order; A* computes only the ones the
heuristic says are promising, in priority order. So flattr doesn't "use DP"
— but its relaxation is the DP recurrence, evaluated lazily.

**Where actual DP would belong:** if flattr added a constraint like "route
with at most K steep segments" or "minimize climb subject to a distance
budget," that's a multi-dimensional state (`node × budget`) with
overlapping subproblems — textbook DP. It's not in the product today.

#### not yet exercised — backtracking search

No backtracking *search* (the explore-then-undo kind — N-queens,
Sudoku, subset-sum). flattr's state space is explored by best-first A*,
not depth-first backtracking. Your reincodes `PG.ts` (river-crossing puzzle
via BFS over a state graph) is the closest relative — it's state-space
search, just breadth-first rather than backtracking. The shape transfers;
flattr just picks the priority-queue frontier over the recursion stack.

### Move 3 — the principle

Reconstruction is backtracking with the forward search already done — you
follow stored sub-answers to a base case. The detail that separates a
correct implementation from a subtly-broken one is *what* you store: the
exact decision (the edge), not a re-derivable summary (the node pair),
because re-derivation can pick a different valid-looking answer. And the
deeper point: A*'s relaxation is the dynamic-programming recurrence
evaluated lazily — flattr gets DP's optimal-substructure guarantee without
ever building a DP table, by letting the priority queue decide evaluation
order.

---

## Primary diagram

Reconstruction's backtrack walk plus where it sits relative to DP, in one
frame.

```
  Reconstruction (backtrack) + the DP-adjacency

  ┌─ during search: build the trail (astar.ts:71) ──────────────┐
  │  relax edge → came.set(next, {edge: EXACT, prev: current})  │
  │  this update = optimal substructure (the DP recurrence)     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ goal popped
  ┌─ reconstruct (astar.ts:86-103) — the backtrack ─────────────┐
  │  cur = goal                                                  │
  │  while cur != start:        ◄── base case                  │
  │     edges.push(came[cur].edge)   ◄── EXACT edge (parallel-  │
  │     cur = came[cur].prev              edge correctness)     │
  │  reverse() → [start ... goal]                              │
  └──────────────────────────────────────────────────────────────┘
  ┌─ not yet exercised ─────────────────────────────────────────┐
  │  DP table / tabulation  (would need K-steep or budget state)│
  │  backtracking search    (A* uses a frontier, not the stack) │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Path reconstruction via predecessor pointers is the standard companion to
Dijkstra/A* — the search computes `came`, a separate walk extracts the
path, keeping the search loop clean. The exact-edge-vs-node-pair distinction
is a real-world routing gotcha: OSM graphs have genuine parallel edges
(two ways between the same junctions), so re-resolving by endpoints is a
known bug source — flattr sidesteps it by construction. DP and A* are
cousins: both rest on optimal substructure, and Dijkstra is sometimes
taught as "DP on a graph with a priority queue." The honest framing for
flattr is "the recurrence is here, the table isn't." You've built the
state-space-search relative in reincodes (`PG.ts`, BFS over an implicit
graph) and recursion-with-call-stack visualizers (`Tree.ts` generators) —
backtracking is the same recursion with an undo step, and memoized DP is
that recursion with a cache. Read file 05 for the search that fills `came`,
file 08 for where DP enters the practice plan.

---

## Interview defense

**Q: How is the route reconstructed, and why store the edge instead of the
node pair?**

```
  came[cur] = {edge, prev}  → walk prev to start, collect EXACT edges
  parallel edges: short-steep vs long-flat between same (A,B)
  node-pair re-resolution could pick the wrong one → wrong steepEdges
```

*Model answer:* "When the search relaxes an edge it records `{edge, prev}`
in `came`. Reconstruction starts at the goal and follows `prev` to the
start — the base case — collecting edges, then reverses. It stores the
*exact* edge object because OSM graphs have parallel edges: a short-steep
and a long-flat street between the same two junctions. If reconstruction
re-resolved by node pair, it might report the steep one even though the
grade router chose the flat one, corrupting the length and `steepEdges`.
There's a test that pins exactly this."

*Anchor:* store the exact relaxed edge; node-pair re-resolution breaks on
parallel edges.

**Q: Does flattr use dynamic programming?**

*Model answer:* "Not as a technique — no memoization table, no tabulation.
But A*'s relaxation, `g[next] = min(g[next], g[cur] + cost)`, *is* the
dynamic-programming shortest-path recurrence; it has optimal substructure.
The difference is A* evaluates subproblems lazily in priority order over an
implicit graph, pruned by the heuristic, instead of filling a fixed table
bottom-up. So flattr has DP's core property without a DP table. Real DP
would enter if I added a constraint like 'at most K steep segments,' which
makes the state `node × budget` — overlapping subproblems."

*Anchor:* the recurrence is present, the table isn't; A* is lazy,
heuristic-guided DP over an implicit graph.

---

## See also

- `05-graphs-and-traversals.md` — the search that builds `came`.
- `02-arrays-strings-and-hash-maps.md` — `came` as a hash-threaded list.
- `08-dsa-foundations-practice-map.md` — where DP enters the plan.
