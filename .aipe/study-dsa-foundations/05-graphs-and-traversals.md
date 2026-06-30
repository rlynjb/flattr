# Graphs & Traversals

**Industry names:** Dijkstra's algorithm · A* search · best-first search ·
bidirectional search · weighted graph traversal. **Type:** Industry standard.

## Zoom out, then zoom in

This is the spine. Everything else in this guide exists to serve the `search()`
function at `astar.ts:22`. That one function is **Dijkstra, A*, grade-A*, and
directed-A* all at once** — the algorithm is fixed; the behavior changes
entirely based on which `(costFn, heuristicFn)` pair you pass it. Read this file
and you understand flattr's router. The four stage wrappers at the bottom of
`astar.ts` (`dijkstra`, `astar`, `gradeAstar`, `directedAstar`) are one-liners
that pick the pair.

```
  Zoom out — search() is the engine, everything else feeds it

  ┌─ Entry ───────────────────────────────────────────────────┐
  │  nearestNode (tap→id)  →  dijkstra/astar/gradeAstar/...    │
  └────────────────────────────┬──────────────────────────────┘
                               │ (graph, start, goal, userMax, costFn, hFn)
  ┌─ THE SPINE — search() astar.ts:22-78 ──▼──────────────────┐
  │  best-first loop over a weighted graph                    │ ★★★
  │    open=PQueue · g=Map · came=Map · closed=Set            │
  │    pop cheapest → expand neighbors → relax → repeat       │
  └──────┬──────────────────┬───────────────────────┬─────────┘
         │ frontier         │ edge cost             │ topology
  ┌──────▼──────┐   ┌────────▼────────┐   ┌──────────▼─────────┐
  │ PQueue (03) │   │ cost.ts (01)    │   │ graph.ts (02)      │
  └─────────────┘   └─────────────────┘   └────────────────────┘
```

Zoom in: a graph is nodes connected by weighted edges; a traversal visits them
in some disciplined order. Best-first search picks the discipline "always
expand the node that looks cheapest next." Dijkstra and A* are both that —
they differ only in whether "cheapest" includes a guess about the remaining
distance. That single difference is the whole story.

## The structure pass

The four stages are *layers of the same algorithm*. Trace one axis —
**what does "cheapest next" mean** — down through them. This is the
self-similarity payoff: it's one loop seen four ways.

```
  Axis: how is the frontier priority computed? (one loop, four answers)

  stage          costFn              heuristic        priority f =
  ────────────   ─────────────────   ──────────────   ──────────────────
  Dijkstra       distanceCost        zeroHeuristic    g          (cost so far)
  A*             distanceCost        haversine        g + h      (cost + guess)
  grade-A*       gradeCostAbs        haversine        g + h      (penalized + guess)
  directed-A*    gradeCostDirected   haversine        g + h      (signed + guess)

  the LOOP is identical (astar.ts:48-76).  only the two functions change.
```

**The seam that matters most:** the boundary between `search()` and the
`(costFn, heuristicFn)` pair. That's where the four algorithms diverge and
nowhere else. The contract across it: `costFn ≥ 0` (no negative edges, or
Dijkstra/A* break) and `heuristicFn` must be *admissible* — never overestimate
the true remaining cost. Haversine straight-line distance is admissible because
the real path is always at least as long as the crow-flies distance. Cross that
seam with a bad heuristic and A* returns wrong paths; the optimality test
(`astar.test.ts:38-45`) is the guard that the seam's contract holds.

## How it works

### Move 1 — the mental model

You've built this in reincodes — `Graph2.ts` runs Dijkstra over a weighted
graph, and you built the BFS that lights up your river-crossing grid. flattr's
`search()` is the *priority-queue generalization* of that BFS: instead of a
FIFO queue expanding in ring order, it's a min-heap expanding in cheapest-cost
order. The shape:

```
  Best-first search — the frontier expands cheapest-first

         start ●
              / \
       (g=10) ●   ● (g=15)         pop the CHEAPEST frontier node,
            / |   |                expand its neighbors, relax their
     (g=22)● (g=18)● ...           costs, push them back.  repeat.
                  │
              ┌───┴────────────────────────────┐
              │ open  = min-heap by f = g + h   │ ← the frontier
              │ closed= nodes already finalized │
              │ g     = best cost to each node  │
              │ came  = how we got there        │
              └─────────────────────────────────┘
         …until we pop the GOAL → reconstruct the path
```

A* is Dijkstra with one change: the priority isn't just `g` (cost so far), it's
`g + h` (cost so far *plus a guess* of cost remaining). The guess pulls the
search toward the goal so it explores far fewer dead-end directions.

### Move 2 — the load-bearing skeleton

`search()` has a kernel. Run the skeleton variant — isolate it, name each part
by what breaks without it.

The irreducible best-first search: **a frontier heap + a g-map + a closed-set +
the relaxation step + goal termination.** Here's the loop, `astar.ts:48-76`:

```ts
// astar.ts:48-76 — the kernel of every flattr route
while (!open.isEmpty()) {
  const current = open.pop()!;              // cheapest frontier node
  pops++;
  if (closed.has(current)) continue;        // [A] stale duplicate → skip
  if (current === goalId) {                 // [B] goal reached → done
    const { nodes, edges } = reconstruct(came, startId, goalId);
    return { path: summarizePath(...), ... };
  }
  closed.add(current);                      // [C] finalize this node
  nodesExpanded++;

  for (const edgeId of graph.adjacency[current] ?? []) {  // [D] expand
    const edge = byId.get(edgeId)!;
    const next = otherEnd(edge, current);
    if (closed.has(next)) continue;
    const tentative = g.get(current)! + costFn(edge, current, userMax);  // [E] relax
    if (tentative < (g.get(next) ?? Infinity)) {
      g.set(next, tentative);                            // [F] better path found
      came.set(next, { edge, prev: current });
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  // [G] push f
      pushes++;
    }
  }
}
return { path: null, ... };                 // [H] frontier empty → unreachable
```

Walk each load-bearing part one at a time:

**[A] The lazy-deletion skip — `closed.has(current)`.** Bridge from `03`: the
heap holds stale duplicates because flattr improves a node's cost by pushing a
new entry, not by decrease-key. When the stale one pops, this line skips it.
*Drop it and you'd re-expand already-finalized nodes, doing redundant work and,
worse, potentially relaxing against an already-optimal node.* It's the line
that makes lazy deletion correct.

**[B] Goal termination — `current === goalId`.** The search stops the moment it
*pops* the goal (not when it first *reaches* it). *Drop it and the search runs
until the frontier empties — still correct, but it explores the whole graph
instead of stopping early.* Popping the goal (rather than reaching it) is what
guarantees the path is optimal: by the time the goal is the cheapest frontier
node, no cheaper path to it can exist.

**[C] The closed set — `closed.add(current)`.** Finalizes a node. *Drop it and
on a cyclic graph (every street graph) the search revisits nodes forever and
never terminates* — the same failure your reincodes BFS would have without its
`visited` set.

**[E][F] Relaxation — the tentative-cost comparison.** This is the heart. For
each neighbor, compute "cost to get here through `current`"
(`g.get(current) + costFn(edge…)`). If that beats the best known cost to the
neighbor (`g.get(next) ?? Infinity`), record the improvement. *Drop the
comparison and you'd overwrite good paths with worse ones; the `?? Infinity`
is what makes the first arrival at any node always relax.*

**[G] The push priority — `tentative + heuristicFn(...)`.** This one line is
what makes it A* instead of Dijkstra. The frontier priority is
`g + h`. For Dijkstra, `h` is `zeroHeuristic` (`astar.ts:8`) so priority is
just `g`. *Swap `h` from zero to haversine and the exact same loop becomes A*.*

**[H] Empty-frontier termination — `return null`.** When the heap drains with
no goal found, the goal is genuinely unreachable. *This is the "no route at
all" answer that `01`'s `BLOCKED` invariant keeps distinct from "no flat
route."*

#### Execution trace — A* on the diamond graph

Watch the variables move. Diamond graph (`fixtures.ts:46-65`), `S→G`, A* with
haversine. Known optimal: `S,A,G` at cost 200.

```
  Execution trace — astar(diamond, S, G)

  init:  g={S:0}  open=[(S, h_S)]  closed={}

  pop S (f=h_S):  closed={S}
    relax S→A: tentative=0+100=100 < ∞  → g[A]=100, push (A, 100+h_A)
    relax S→B: tentative=0+100=100 < ∞  → g[B]=100, push (B, 100+h_B)
    relax S→D: tentative=0+300=300 < ∞  → g[D]=300, push (D, 300+h_D)

  pop A (cheapest f, A nearer goal):  closed={S,A}
    relax A→G: tentative=100+100=200 < ∞ → g[G]=200, push (G, 200+0)
    relax A→C: tentative=100+100=200 < ∞ → g[C]=200, push (C, ...)

  pop G  → current===goalId  → reconstruct
    came: G←{edge ag, prev A}, A←{edge sa, prev S}
    path = S,A,G   cost=200   ✓ matches Dijkstra
```

The key moment: A* pops `A` before `B` or `D` because `A`'s `f = g + h` is
lowest — `h` (haversine to G) makes the search *lean toward the goal*. Dijkstra
with `h=0` would pop `A`, `B` (tie) before `D` too here, but on a big grid the
heuristic prunes whole regions A* never touches. That's exactly what
`astar.test.ts:47-52` asserts: A* expands ≤ as many nodes as Dijkstra.

#### Reconstruction off the exact relaxed edge — the subtle correctness fix

Most A* writeups reconstruct by walking node-to-node and re-looking-up the edge
between each pair. flattr stores the *exact edge* it relaxed in `came`
(`astar.ts:72`, the `{edge, prev}`), and `reconstruct` (`astar.ts:86-103`)
emits those stored edges. Why it matters: **parallel edges.**

```
  Parallel edges A→B — why "the exact relaxed edge" matters

  short-steep  A════════B   length 50,  grade 20%  (over max → penalized)
  long-flat    A────────B   length 100, grade 0%   (the one search chose)

  directed grade router relaxes long-flat (cheaper penalized cost).
  came[B] = { edge: long-flat, prev: A }   ← stores THE edge, not the pair

  reconstruct emits long-flat.
  a length-based re-resolution would wrongly pick short-steep (it's shorter)
```

The test at `astar.test.ts:102-128` builds exactly this two-parallel-edge graph
and asserts reconstruction reports `long-flat` (the one the grade router chose),
not `short-steep` (the one a naive shortest-by-length re-lookup would grab). The
doc comment at `astar.ts:80-84` calls this out. *It's a one-word fix — store the
edge, not the node pair — and it's the difference between a correct cost report
and a wrong one.*

#### Bidirectional search — two frontiers meeting in the middle

`bidirectional.ts` is the fifth stage: run A* forward from start *and* backward
from goal, stop when they meet. It roughly halves the explored region on long
routes. Two things make it correct, and they're the load-bearing parts:

**The balanced potential** (`bidirectional.ts:30-32`):

```ts
// bidirectional.ts:30-32 — consistent potential for BOTH directions
const pf = (id) => (haversine(nodes[id], goal) - haversine(nodes[id], start)) / 2;
const pr = (id) => -pf(id);   // reverse uses the negation
```

A plain forward heuristic (`haversine to goal`) and a plain backward heuristic
(`haversine to start`) aren't consistent with each other — the two searches
would meet at a non-optimal node. The *balanced* potential `(h_goal − h_start)/2`
is consistent for both directions at once. *Drop the balancing and the meeting
node isn't guaranteed optimal.*

**The stopping rule** (`bidirectional.ts:52`):

```ts
if (topF + topR >= mu) break;   // mu = best meeting cost found so far
```

```
  Bidirectional — two frontiers, stop when they can't improve

  start ●───►  forward frontier  ····  backward frontier  ◄───● goal
              (openF, gf)                    (openR, gr)
                        ╲                  ╱
                         ╲   meet at u?   ╱
                          ▼              ▼
              mu = best gf[u] + gr[u] found so far
              STOP when topF + topR ≥ mu
              (no unexpanded pair can beat the best meeting)
```

`mu` is the cheapest total cost across any node both sides have reached. When
the sum of the two frontier-tops can't beat `mu`, no future meeting can improve
it, so stop. *Drop the rule and the search either stops too early (suboptimal)
or runs the whole graph (no speedup).* The bidirectional test
(`bidirectional.test.ts`) gates it against the same Dijkstra-cost oracle.

### Move 3 — the principle

One parametric loop expressing four algorithms is the lesson worth carrying:
Dijkstra, A*, grade-A*, and directed-A* aren't four algorithms, they're one
best-first search with two pluggable functions. The discipline that makes it
work is the seam contract — `costFn ≥ 0`, `heuristic` admissible — verified by
the differential oracle (A*-cost == Dijkstra-cost). Generalize it: when several
"algorithms" share a control structure and differ only in a scoring function,
collapse them into one parametric engine and pin correctness with a
differential test against the simplest member. That's exactly how flattr keeps
four routers from drifting apart.

## Primary diagram

The whole spine in one frame.

```
  flattr's search() — one loop, four (then five) algorithms

  ┌─ INPUT ───────────────────────────────────────────────────┐
  │  graph · startId · goalId · userMax · costFn · heuristicFn │
  └────────────────────────────┬──────────────────────────────┘
                               ▼
  ┌─ THE LOOP (astar.ts:48-76) ───────────────────────────────┐
  │  while open not empty:                                     │
  │    current = open.pop()        ← cheapest f = g + h        │
  │    if closed → skip (lazy del) [A]                         │
  │    if current = goal → reconstruct & return [B]            │
  │    closed.add(current)         [C]                         │
  │    for each neighbor (adjacency):  [D]                     │
  │       tentative = g[current] + costFn(edge)   [E]          │
  │       if tentative < g[next]:  relax, push f  [F][G]       │
  │  → frontier empty → return null  [H] (unreachable)         │
  └────────────────────────────┬──────────────────────────────┘
                               ▼
  ┌─ RECONSTRUCT (astar.ts:86) ───────────────────────────────┐
  │  walk came backward, emit the EXACT relaxed edges          │
  │  → parallel edges stay correct (astar.test.ts:102)         │
  └────────────────────────────────────────────────────────────┘

  stage = (costFn, heuristicFn):
    Dijkstra (distance,0) · A* (distance,haversine)
    grade-A* (gradeAbs,haversine) · directed-A* (gradeDir,haversine)
  bidirectional.ts = two of these loops meeting in the middle
```

## Elaborate

Dijkstra (1959) is best-first with no heuristic; A* (Hart, Nilsson, Raphael,
1968) adds the admissible heuristic that makes it goal-directed without losing
optimality. The admissibility condition — `h` never overestimates — is the
whole reason A* still finds the shortest path; a *consistent* (monotone)
heuristic additionally guarantees each node is finalized once, which is what
lets flattr's closed-set skip be correct. Haversine straight-line distance is
both admissible and consistent for a geographic graph, which is why it's the
right heuristic here. Bidirectional A* with a consistent potential is the
production technique for long routes; the balanced potential
`(h_goal − h_start)/2` (Ikeda et al.) is the standard fix for making both
directions consistent. flattr implements the textbook correctly — the grade
cost is the only domain-specific twist on a classical core.

Read next: `01` (the cost model the search minimizes), `03` (the heap it pops),
`07` (the reconstruction recursion).

## Interview defense

**Q: Walk me through your routing search. How is A* different from Dijkstra?**

It's one loop — `search()` at `astar.ts:22` — parameterized by a cost function
and a heuristic. The loop pops the cheapest frontier node, expands its
neighbors, relaxes their costs, and pushes them back with priority `g + h`.
Dijkstra is that loop with `h = 0`; A* is the same loop with `h = haversine`.
The heuristic pulls the search toward the goal so it expands far fewer nodes,
and as long as `h` never overestimates the real remaining cost, A* still returns
the optimal path.

```
  Dijkstra: priority = g           A*: priority = g + h
  same loop, same closed set, same relaxation — only h changes
```

Anchor: "four algorithms, one loop — Dijkstra/A*/grade/directed are just
`(costFn, heuristicFn)` pairs."

**Q: How do you know your A* returns the *optimal* path, not just *a* path?**

A differential oracle. The test at `astar.test.ts:38-45` runs both Dijkstra and
A* on the same grid and asserts equal cost to six decimals. Dijkstra is the
ground truth — no heuristic, provably optimal — so if A* matches it, the
heuristic is admissible and A* is optimal too. The named load-bearing detail:
the search terminates when it *pops* the goal, not when it first *reaches* it —
that's what guarantees no cheaper path exists.

```
  Dijkstra (ground truth, h=0)  ═══ cost ═══  A* (h=haversine)
  equal to 6 decimals → heuristic admissible → A* optimal
```

Anchor: "terminate on *pop* of the goal, not first *reach* — and pin
admissibility with an A*==Dijkstra differential test."

**Q: What breaks if you remove the closed set?**

On a street graph — which is cyclic — the search revisits nodes forever and
never terminates. The closed set (`astar.ts:61`) is what finalizes a node so
it's never expanded twice; it's the same role `visited` plays in BFS. With lazy
deletion it does double duty: `closed.has(current)` at `astar.ts:51` also skips
the stale heap duplicates.

Anchor: "closed = termination on cyclic graphs *and* the lazy-deletion skip."

## See also

- `01-complexity-and-cost-models.md` — the cost the search minimizes; `BLOCKED`.
- `03-stacks-queues-deques-and-heaps.md` — the frontier heap and lazy deletion.
- `02-arrays-strings-and-hash-maps.md` — adjacency, g/came/closed.
- `07-recursion-backtracking-and-dynamic-programming.md` — `reconstruct()`.
- `06-sorting-searching-and-selection.md` — the optimality oracle as selection.
