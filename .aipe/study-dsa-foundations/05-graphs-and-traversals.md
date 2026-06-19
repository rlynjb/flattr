# Graphs & traversals

**Industry names:** weighted directed graph · adjacency list · Dijkstra's
algorithm · A\* search · informed/best-first search · admissible heuristic ·
bidirectional search. **Type:** Industry standard. **This is the centerpiece
of the repo and of this guide.**

---

## Zoom out, then zoom in

This is the whole point of `flattr`. A street network is a graph: intersections
are nodes, blocks are edges, and "find me the flattest comfortable route from A
to B" is a shortest-path query where "shortest" means *lowest grade-effort*, not
lowest distance. Everything in the other files exists to make this one work — the
heap (**03**) is the frontier, the hash maps (**02**) are the adjacency and the
visited set, the cost model (**01**) is what the path minimizes.

```
  Zoom out — the search layer is the engine

  ┌─ Input ────────────────────────────────────────────────────────┐
  │  nearestNode(start), nearestNode(goal)  → snap to node ids       │
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ ★ Search layer (THIS FILE) ───────────▼────────────────────────┐
  │  search(graph, start, goal, userMax, costFn, heuristicFn)        │
  │    ONE engine, four stages:                                      │
  │      dijkstra      = distanceCost + zeroHeuristic                │
  │      astar         = distanceCost + haversineHeuristic           │
  │      gradeAstar    = gradeCostAbs + haversineHeuristic           │
  │      directedAstar = gradeCostDirected + haversineHeuristic      │
  │    bidirectional() = two frontiers, meet in the middle           │
  │  features/routing/astar.ts, bidirectional.ts                     │
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ Cost layer ────────────▼────────────────────────────────────────┐
  │  penalty(directedGrade, userMax)   features/routing/cost.ts       │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: the verdict first. **Dijkstra, A\*, grade-A\*, and directed-A\* are
not four algorithms. They're one function, `search()` (`astar.ts:22-78`), called
with four different `(costFn, heuristicFn)` pairs (`astar.ts:135-163`).** That
collapse *is* the senior insight: Dijkstra is A\* with a zero heuristic; the
domain (grade) lives entirely in the cost function, never in the search loop.
Learn `search()` once and you've learned all four.

---

## The structure pass

**Layers.** The graph machinery nests in three altitudes:

```
  One question — "where does direction live?" — down the layers

  ┌────────────────────────────────────────────────┐
  │ STORAGE: undirected edges + adjacency             │ → direction NOT stored
  │   one Edge, both endpoints in adjacency           │   (graph.ts:22-29)
  └────────────────────┬───────────────────────────────┘
       ┌───────────────▼─────────────────────────────┐
       │ TRAVERSAL: directedGrade(edge, fromNode)      │ → direction DERIVED
       │   +grade forward, -grade reverse              │   at the moment you step
       └───────────────┬─────────────────────────────┘   (graph.ts:17-19)
           ┌───────────▼───────────────────────────┐
           │ COST: penalty over the directed grade    │ → direction MATTERS
           │   uphill penalized, downhill free        │   (cost.ts:32-33)
           └─────────────────────────────────────────┘

  the answer flips: stored undirected → traversed directed → costed asymmetric.
  THAT progression is the model's cleverness (spec §11-F: derive, don't materialize)
```

**Axis = direction.** This is the axis that makes the repo's graph special. A
plain graph search doesn't care which way you cross an edge. `flattr` does:
`directedGrade(edge, fromNodeId)` (`graph.ts:17-19`) returns `+gradePct` if you
entered from the `fromNode` end, `-gradePct` from the other. One physical edge,
two costs depending on travel direction. The cost function consumes that
(`cost.ts:32-33`), so A\* naturally routes downhill-and-flat.

**Seams.** The load-bearing seam is `otherEnd` + `directedGrade` (`graph.ts:9-19`)
— the joint where undirected *storage* becomes directed *traversal*. Cross it
left-to-right and the answer to "what does it cost to cross this edge?" flips from
symmetric to asymmetric. That single seam is open-decision F-(1) from the spec
(§11): derive direction at traversal instead of materializing two edges, paying a
tiny per-step computation to halve the graph size.

---

## How it works

### Move 1 — the mental model

You know BFS: a frontier queue, pop a node, push its unvisited neighbors, repeat
until you find the goal or the queue drains. Dijkstra and A\* are BFS where the
frontier is a *priority* queue ordered by cost-so-far (plus, for A\*, an estimate
of cost-remaining). Instead of expanding the nearest-by-hops node, you expand the
cheapest-by-cost node.

```
  Best-first search — the kernel shared by Dijkstra & A*

       ┌──────────────────────────────────────────┐
       │  open ← {start}   (a priority queue)        │
       │  while open not empty:                      │
       │     current ← open.pop()  (lowest f)        │
       │     if current == goal → reconstruct, done  │
       │     close(current)                          │
       │     for each neighbor via an edge:          │
       │        if cheaper path found → relax & push │
       │  open empty → no path                       │
       └──────────────────────────────────────────┘

  Dijkstra: f = g (cost so far)
  A*:       f = g + h   (cost so far + admissible estimate to goal)
  the ONLY difference is h. that's why one function (search) does both.
```

### Move 2 variant — the load-bearing skeleton

`search()` (`astar.ts:22-78`) has an irreducible kernel. Five parts, each named
by what breaks when it's gone:

**1. The open set (priority queue) — the frontier.**
`open = new PQueue<string>()` (`astar.ts:30`), ordered by f-score. *Remove the
priority ordering* (use a plain queue) and you're back to BFS — correct only when
all edges cost the same, wrong the instant grades vary. The frontier is what makes
the search expand the *cheapest* node next.

**2. The `g` map — best-known cost to each node.**
`g = new Map<string, number>()` (`astar.ts:31`). The relaxation test `tentative <
(g.get(next) ?? Infinity)` (`astar.ts:69`) is the heart of shortest-path: *only
update if I found a cheaper way here.* *Remove `g`* and you can't tell a better
path from a worse one — you'd accept every path and never converge.

**3. The `closed` set — finalized nodes.**
`closed = new Set<string>()` (`astar.ts:34`). When a node is popped, it's
finalized (`astar.ts:61`) — with an admissible heuristic, the first time you pop a
node you have its optimal cost, so you never process it again
(`astar.ts:51,67`). *Remove `closed`* and you reprocess nodes endlessly; on a
cyclic graph (every street graph) the search may not terminate. This is the part
people forget — and the repo has *two* guards: skip if closed at pop
(`astar.ts:51`, catches stale heap entries) and skip closed neighbors
(`astar.ts:67`).

**4. The `came` map — path reconstruction.**
`came = new Map<string, {edge, prev}>()` (`astar.ts:32`). Each relaxation records
*which edge* and *which predecessor* got you to a node cheaply (`astar.ts:71`).
*Remove `came`* and the search finds the optimal *cost* but can't tell you the
*route* — you'd know the trip is 1.2km of gentle grade but not which streets.
Reconstruction (`astar.ts:86-103`) walks `came` backward from goal to start.

**5. Empty-frontier termination — the "no path" signal.**
`while (!open.isEmpty())` falling through to `return {path: null}`
(`astar.ts:48,77`). *Remove it* and a disconnected goal loops forever or crashes
on `pop()!`. This is how A\* distinguishes "no route exists" (returns `null`,
`astar.test.ts:21-27`) from "route exists but steep" (returns a path with
`steepEdges` flagged — see the BLOCKED discussion below).

**Now the execution trace — Dijkstra on the diamond fixture** (`fixtures.ts:46-65`).
Flat graph, distance cost, find S→G. Edges: sa=100, ag=100, sb=100, bg=150,
sd=300, dg=300, ac=100, cb=100.

```
  Dijkstra S→G on diamondGraph (astar.ts:48-75)
  g = cost so far; open = heap of (node, priority); closed = finalized

  init:   g{S:0}                       open[(S,0)]
  pop S:  close S. relax neighbors:
          A: g 0+100=100 < ∞  → g{A:100}  push(A,100)
          B: g 0+100=100 < ∞  → g{B:100}  push(B,100)
          D: g 0+300=300 < ∞  → g{D:300}  push(D,300)
                                          open[(A,100)(B,100)(D,300)]
  pop A:  close A. relax:
          G: g 100+100=200    → g{G:200}  push(G,200)
          C: g 100+100=200    → g{C:200}  push(C,200)
                                          open[(B,100)(G,200)(C,200)(D,300)]
  pop B:  close B. relax:
          G: 100+150=250  NOT< 200 → skip   (B's route to G is worse)
          C: 100+100=200  NOT< 200 → skip
                                          open[(G,200)(C,200)(D,300)]
  pop G:  current == goal → reconstruct via came{G:(ag,A), A:(sa,S)}
          path = [S,A,G]  cost 200  ✓ (astar.test.ts:6-12)
```

Notice D never gets expanded — its priority 300 sat behind the goal at 200. That's
Dijkstra pruning by cost. A\* prunes *harder* because of the heuristic.

**The heuristic — what turns Dijkstra into A\*.** `haversineHeuristic`
(`astar.ts:9`) adds an *estimate of remaining cost* to the priority:
`f = g + h` (`astar.ts:72`). Dijkstra explores in expanding circles (it has no
idea where the goal is); A\* explores in a *cone* aimed at the goal, because nodes
pointing away from the goal get a high `h` and sink in the queue.

```
  Dijkstra floods vs A* cones (same start ●, goal ★)

  DIJKSTRA (h=0)              A* (h=haversine)
      · · · · ·                       · ·
    · · · · · · ·                   · · · ★
  · · · ● · · · ★               · · ● · ·
    · · · · · · ·                   · ·
      · · · · ·
  expands ~everything close    expands a narrow cone toward ★
  to the start, all directions  → far fewer nodes (bench: ~203 vs ~50)
```

**Admissibility — why A\* still finds the optimal path.** A heuristic is
*admissible* if it never overestimates the true remaining cost. Then A\* is
guaranteed optimal. Here's the proof, grounded in the code: every edge cost is
`length * (1 + penalty)` with `penalty >= 0` (`cost.ts:16-22`), so `cost >=
length` always. Straight-line haversine distance is `<=` any real path length
(triangle inequality). Therefore haversine `<=` true remaining cost — it never
overestimates. The test `astar.test.ts:38-45` is the live proof: A\* returns the
*exact same cost* as Dijkstra. If it ever didn't, the heuristic would be
inadmissible.

```
  Why haversine is admissible (the chain, from the code)

  penalty ≥ 0           (cost.ts:16: g≤0 → 0; else positive)
    ⟹ edgeCost = len*(1+penalty) ≥ len           (cost.ts:29,33)
    ⟹ true path cost ≥ true path length
  haversine(n,goal) ≤ true path length            (straight line ≤ any path)
    ⟹ haversine ≤ true path cost   ← NEVER overestimates = ADMISSIBLE
    ⟹ A* optimal (astar.test.ts:38-45 proves equal cost to Dijkstra)
```

**The grade cost — where the domain enters, and ONLY there.** Stage 3 swaps
`distanceCost` for `gradeCostAbs` (`cost.ts:28-29`), stage 4 for
`gradeCostDirected` (`cost.ts:32-33`). The search loop never changes — it just
calls `costFn(edge, current, userMax)` (`astar.ts:68`). `gradeCostDirected` reads
`directedGrade(edge, fromNodeId)`, so the *same edge* costs more uphill than
downhill. That asymmetry is what makes A→B ≠ B→A.

```
  Directed cost asymmetry — directionalGraph (fixtures.ts:88-102)
  Edge xy: X→Y climbs 8%. userMax=5. Detour X-F-Y is flat.

  X→Y (uphill):  directedGrade(xy, X) = +8 > max 5 → penalty BLOCKED (1e9)
                 cost(xy) = 100*(1+1e9) ≈ 1e11   → A* takes detour X-F-Y
  Y→X (downhill):directedGrade(xy, Y) = -8 ≤ 0    → penalty 0
                 cost(xy) = 100*(1+0) = 100        → A* takes direct edge Y-X

  result: up = [X,F,Y], down = [Y,X]   (astar.test.ts:74-80) — A→B ≠ B→A ✓
```

**BLOCKED is large-finite, not Infinity — the honest-fallback design.**
`BLOCKED = 1e9` (`cost.ts:5`). When *every* route crosses a too-steep edge, A\*
still returns one (the cost is huge but finite and comparable), and
`summarizePath` flags the offending edges in `path.steepEdges`
(`astar.ts:126-128`). `null` is reserved for a *genuinely disconnected* graph —
the open set drains without ever reaching the goal. This distinguishes two real
graph states: "no flat way" (steep, flagged) vs "no way at all" (disconnected).
`astar.test.ts:82-96` pins both.

```
  Three outcomes A* distinguishes (the honest fallback)

  clean route exists   → path, steepEdges=[]        (normal)
  only-steep route     → path, steepEdges=[xy]      BLOCKED finite, flagged
                         (astar.test.ts:82-89)        — "no flat way"
  disconnected         → path = null                open drained, goal unseen
                         (astar.test.ts:91-96)        — "no way"

  if BLOCKED were Infinity, only-steep and disconnected would BOTH look like
  "no path" — the honesty distinction collapses. (See 01 for the arithmetic.)
```

**Reconstruction uses the exact relaxed edge — the parallel-edge trap.**
`reconstruct` (`astar.ts:86-103`) walks `came` and reports the *exact edge the
search relaxed* (`entry.edge`), not a re-resolution by node pair. Why it matters:
two parallel edges can connect A→B (a short-steep one and a long-flat one). The
grade router picks long-flat; a naive reconstruction that re-looks-up "an A→B
edge" might report the short-steep one, lying about the route. `astar.test.ts:102-128`
locks this: the path must report `long-flat`, not `short-steep`.

**Bidirectional A\* — two frontiers, meet in the middle.** `bidirectional()`
(`bidirectional.ts:8-151`) runs a forward search from start *and* a backward
search from goal, and stops when they meet. The provable win is *meeting in the
middle*: two small cones instead of one big one (`bidirectional.test.ts:26-38`:
~43 expansions vs Dijkstra's ~203).

```
  Bidirectional A* — two cones meet (bidirectional.ts:49-115)

  forward from S ──►cone     cone◄── backward from G
                    ●  meet  ●
  S ────────────────●━━━━━━━━●──────────────── G
                    └─ meet point: reconstruct
                       front S→meet (cameF) + back meet→G (cameR)

  stopping rule (bidirectional.ts:52): topF + topR ≥ mu → stop
    mu = best total cost found so far; when the two frontier tops can't
    possibly beat it, you're done. This is the part that's easy to get WRONG.
```

The subtle correctness piece is the **balanced consistent potential**
(`bidirectional.ts:30-32`): `pf(n) = (h(n,goal) - h(n,start)) / 2`, with `pr = -pf`.
A naive bidirectional A\* using plain haversine on each side isn't *consistent*
across the two searches, and the meeting rule can return a non-optimal path. The
balanced potential keeps both sides consistent so the stopping rule is sound.
*Remove the balance* and you can get a wrong answer that still looks plausible —
the hardest bug class in the repo. `bidirectional.test.ts:16-24` verifies it
matches directed-A\*'s optimal cost.

### Move 2.5 — current state vs future state

Stages 1–5 are shipped and tested. Stage 6 (contraction hierarchies / ALT
landmarks) and k-alternative routes are spec stretch goals, not built.

```
  Phase A (shipped)              Phase B (spec §14.5 stretch, not built)
  ┌──────────────────────┐       ┌──────────────────────────────────────┐
  │ Dijkstra              │       │ contraction hierarchies — preprocess  │
  │ A* (haversine)        │  ───► │   shortcuts for O(query) ≪ current    │
  │ grade-A*, directed-A* │       │ k-alternatives — penalty method:      │
  │ bidirectional A*      │       │   inflate used edges, re-run (touches  │
  └──────────────────────┘       │   DP ideas — see 07)                   │
  what DOESN'T change: the graph model, the cost function, the heap.
  CH/ALT add a PREPROCESSING layer; the query-time search stays recognizable.
```

### Move 3 — the principle

**The search is generic; the intelligence is the cost function.** `flattr` proves
this structurally — one `search()` function, four behaviors, swapped purely by
arguments. This is the same machine Google Maps and Uber run (spec §15.1): a
weighted graph + shortest-path, where the product differentiation is the *weights*
(directional grade-effort here, traffic/ETA there), not the search. Learn to
separate the two — generic traversal vs domain cost — and you can build any
routing engine.

---

## Primary diagram

The full search engine: model, the one function, the four stages, and
bidirectional, with every structure labelled.

```
  flattr's graph search — the complete picture

  ┌─ MODEL (types.ts, graph.ts) ──────────────────────────────────┐
  │  nodes: Record<id,Node>   edges: Edge[]                        │
  │  adjacency: Record<id,id[]>  (undirected storage)              │
  │  directedGrade(edge, from) → signed by travel dir (graph.ts:17)│
  └─────────────────────────┬──────────────────────────────────────┘
  ┌─ search() — ONE engine (astar.ts:22-78) ──────────────────────┐
  │  open:PQueue  g:Map  came:Map  closed:Set   (the 5 kernel parts)│
  │  loop: pop lowest f → if goal reconstruct → close → relax nbrs  │
  │        relax: tentative<g(next)? → update g,came, push(f=g+h)   │
  │  costFn ──┬─ distanceCost ──────────► stage 1 dijkstra (h=0)    │
  │           ├─ distanceCost + haversine► stage 2 astar            │
  │           ├─ gradeCostAbs ───────────► stage 3 gradeAstar       │
  │           └─ gradeCostDirected ──────► stage 4 directedAstar    │
  └─────────────────────────┬──────────────────────────────────────┘
  ┌─ bidirectional() (bidirectional.ts) ──────────▼───────────────┐
  │  openF + openR (two heaps) · pf/pr balanced potential          │
  │  stop: topF+topR ≥ mu · reconstruct front(cameF)+back(cameR)   │
  └──────────────────────────────────────────────────────────────────┘
       outputs: Path {nodes, edges, cost, lengthM, steepEdges}
                + SearchResult metrics {nodesExpanded, pushes, pops}
```

---

## Implementation in codebase

**Use cases.** The search runs on every route request: snap start/goal with
`nearestNode`, pick a stage by `userMax` and preset, run `search()` or
`bidirectional()`, draw the path and color its segments by directed grade. The
bench harness (`bench/run.ts`) runs all five stages over fixed pairs to prove the
progression. The four stage wrappers are the same function with different args.

```
  features/routing/astar.ts  (lines 64-75)  — the relaxation hot loop

  for (const edgeId of graph.adjacency[current] ?? []) {  ← all incident edges
    const edge = byId.get(edgeId)!;                       ← O(1) (see 02)
    const next = otherEnd(edge, current);                 ← the directed step
    if (closed.has(next)) continue;                       ← skip finalized (guard 2)
    const tentative = g.get(current)! + costFn(edge, current, userMax);
                                                          ← cost-so-far + edge cost
    if (tentative < (g.get(next) ?? Infinity)) {          ← RELAX: found cheaper?
      g.set(next, tentative);                             ← record best cost
      came.set(next, { edge, prev: current });            ← record HOW (for path)
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
      pushes++;                                           ← f = g + h into the heap
    }
  }
       │
       └─ this loop IS the algorithm. costFn is the only thing that changes
          between stages — direction enters via costFn reading directedGrade,
          NOT via the loop. The `?? Infinity` makes an unseen node always relax.
```

```
  features/routing/astar.ts  (lines 48-61)  — pop, goal-check, close

  const current = open.pop()!; pops++;
  if (closed.has(current)) continue;     ← STALE entry from lazy deletion (see 03)
  if (current === goalId) { ...reconstruct, return... }  ← first pop of goal = optimal
  closed.add(current); nodesExpanded++;  ← finalize: never process again
       │
       └─ the `closed.has(current)` skip is the lazy-deletion seam with the heap:
          a node relaxed twice has two heap entries; the better pops first and
          closes the node, the worse pops later and is skipped here. Without
          this line the search reprocesses nodes and may not terminate on cycles.
```

```
  features/routing/bidirectional.ts  (lines 30-32, 49-52)  — potential + stop

  const pf = (id) => (haversine(nodes[id], goal) - haversine(nodes[id], start))/2;
  const pr = (id) => -pf(id);                            ← balanced, consistent
  ...
  const topF = openF.peekPriority()!; const topR = openR.peekPriority()!;
  if (topF + topR >= mu) break;                          ← standard stopping rule
       │
       └─ the /2 balance is what keeps BOTH frontiers consistent so the
          topF+topR≥mu rule is correct. Use raw haversine per side and the
          meeting point can be non-optimal — the subtlest correctness bug here.
          Verified equal-cost to directed-A* in bidirectional.test.ts:16-24.
```

---

## Elaborate

Dijkstra (1959) is the foundation: single-source shortest path on non-negative
weights. A\* (Hart, Nilsson, Raphael, 1968) added the admissible heuristic to
make it goal-directed — the same idea behind every game-AI pathfinder and map
router. Bidirectional search and its consistent-heuristic correctness is 1970s
work; contraction hierarchies (Geisberger et al., 2008) are what make
continent-scale routing answer in microseconds and are the spec's stage-6 stretch.
`flattr`'s contribution isn't a new algorithm — it's the *directional cost
function*, which makes it a genuinely directed-graph problem (A→B ≠ B→A), the
thing most toy routers skip. You've built the pieces before: `reincodes/Graph.ts`
(adjacency, BFS/DFS, connected components), `reincodes/Graph2.ts` (weighted edges,
Dijkstra), `reincodes/PG.ts` (BFS over an implicit state-space graph). This repo
is the applied, directional, heuristic-guided version. Next reads: **03** (the
heap that makes it tractable), **01** (the `O((V+E) log V)` cost), **06** (the
`nearestNode` snap that feeds it). The connected-component gap below points at
**union-find**.

**`not yet exercised` — union-find (DSU).** The repo answers "is the goal
reachable?" *implicitly* — A\* returns `null` when the open set drains. A
union-find structure would answer "are A and B in the same connected component?"
in near-`O(1)` *without running a search at all* — useful to fail fast before
even snapping nodes, or to validate the graph at build time (catch the
disconnected-corner mesh bug the spec warns about, §14.3 node identity).
Rein's `reincodes/Graph.ts` has `numberOfConnectedComponents` (a DFS-based
version); the DSU version with path compression + union by rank is the
near-constant-time upgrade. Not built here.

**`not yet exercised` — DFS / BFS as standalone traversals.** The repo only ever
does *priority-first* search (Dijkstra/A\*). Plain BFS (unweighted shortest path,
FIFO frontier) and DFS (cycle detection, topological sort) aren't used — they'd
matter for graph *validation* at build time rather than routing at query time.

---

## Interview defense

**Q: "Are Dijkstra and A\* different algorithms in this codebase?"**

No — they're one function, `search()` (`astar.ts:22-78`), with different
arguments. Dijkstra is `distanceCost + zeroHeuristic`; A\* is `distanceCost +
haversineHeuristic`. Dijkstra is A\* with `h=0`. The grade stages just swap the
cost function. That collapse is the design.

```
  search(graph, s, g, userMax, COSTFN, HEURISTICFN)
    dijkstra      = distanceCost,      zeroHeuristic       (h=0 → floods)
    astar         = distanceCost,      haversineHeuristic  (h>0 → cones)
    directedAstar = gradeCostDirected, haversineHeuristic  (A→B≠B→A)
  anchor: astar.ts:135-163 — four wrappers, one engine
```

**Q: "Prove your A\* is optimal."**

The heuristic is admissible: every edge cost is `length*(1+penalty)` with
`penalty≥0`, so cost≥length, and straight-line haversine ≤ any real path length,
so haversine never overestimates true remaining cost. Admissible heuristic ⟹
A\* optimal. The live proof is `astar.test.ts:38-45`: A\* returns the *exact same
cost* as Dijkstra.

**Q: "What's the load-bearing part people forget in A\*?"**

The closed set and empty-frontier termination. Without `closed` you reprocess
nodes and may never terminate on a cyclic graph — and every street graph is
cyclic. Without the empty-frontier check you can't signal "no path." `flattr`
has both, plus a *second* closed-check at pop (`astar.ts:51`) to skip stale
lazy-deletion entries.

**Q: "Why is BLOCKED `1e9` and not `Infinity`?"**

So an only-steep path stays a finite, comparable, returnable answer — flagged in
`steepEdges` — distinct from a genuinely disconnected graph that returns `null`.
Infinity would collapse "no flat way" and "no way" into the same outcome, and
`Infinity-Infinity=NaN` would break the heap (which rejects NaN, `pqueue.ts:24`).

---

## Validate

1. **Reconstruct:** From memory, write the five kernel parts of `search()`
   (`astar.ts:30-34`) and name what breaks if each is removed.
2. **Explain:** Walk the admissibility chain from `cost.ts:16-22` to "A\* is
   optimal," and name the test that proves it (`astar.test.ts:38-45`).
3. **Apply:** Trace `directedAstar` on `directionalGraph` (`fixtures.ts:88-102`)
   for X→Y and Y→X; show why one detours and one takes the direct edge
   (`astar.test.ts:74-80`).
4. **Defend:** Explain the balanced potential `pf=(h_goal-h_start)/2`
   (`bidirectional.ts:30-32`) and why raw per-side haversine would break the
   `topF+topR≥mu` stopping rule (`bidirectional.ts:52`).

---

## See also

- **03-stacks-queues-deques-and-heaps.md** — the PQueue frontier this depends on.
- **01-complexity-and-cost-models.md** — the `O((V+E) log V)` cost and `nodesExpanded`.
- **02-arrays-strings-and-hash-maps.md** — adjacency, `g`/`came`/`closed`.
- **06-sorting-searching-and-selection.md** — `nearestNode` snapping the endpoints.
- **04-trees-tries-and-balanced-indexes.md** — union-find for connectivity (gap).
- `.aipe/study-performance-engineering/` — the bench harness proving the progression.
- `.aipe/study-system-design/` — graph-as-artifact, client vs server A\*, tiling.
