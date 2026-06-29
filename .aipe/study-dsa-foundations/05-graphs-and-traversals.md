# Graphs & Traversals

**Industry names:** weighted graph, adjacency list, Dijkstra's algorithm,
A* search, bidirectional search, best-first traversal, admissible
heuristic. **Type:** Industry standard.

---

## Zoom out — where this concept lives

This is the spine. Everything in the other files — the heap, the hash
maps, the cost model — exists to serve one function: `search()` in
`astar.ts`. And the single most important thing to understand about
flattr is that there is **one** search function, and Dijkstra, A*,
grade-A*, and directional-A* are all just it, called with different
`(costFn, heuristicFn)` pairs.

```
  Zoom out — the routing engine in the system

  ┌─ Mobile UI (mobile/) ───────────────────────────────────────┐
  │  tap two points → nearestNode() → startId, goalId           │
  └───────────────────────────┬──────────────────────────────────┘
                              │  one call into the engine
  ┌─ Routing engine (features/routing/) ────────────────────────┐
  │  ★ search(graph, start, goal, userMax, costFn, heuristicFn) ★│ ← we are here
  │       uses: PQueue (file 03) + g/came/closed (file 02)      │
  │       over: adjacency list (graph.ts)                       │
  │       costs: penalty() (cost.ts, file 01)                   │
  │  wrappers: dijkstra | astar | gradeAstar | directedAstar    │
  │  variant:  bidirectional (two frontiers)                    │
  └───────────────────────────┬──────────────────────────────────┘
                              │  Path { nodes, edges, cost, steepEdges }
  ┌─ Static graph (mobile/assets/graph.json) ───────────────────┐
  │  nodes, edges, adjacency — prebuilt, read-only              │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** A grade-annotated street graph stored as an undirected
adjacency list, traversed by a best-first search whose order is set by an
admissible heuristic and whose preferences are set by a swappable cost
function. This file builds the search kernel, then shows how four
algorithms fall out of one engine, then the bidirectional variant.

---

## Structure pass — one axis across the search progression

The layers here are the **five search stages** (`bench/` calls them the
progression: Dijkstra → A* → grade-A* → directional-A* → bidirectional).
The axis that makes them legible is **what does the priority key
encode?** — because that one choice is the entire difference between them.

```
  Axis: "what goes into the heap priority?"  (the f-score)

  ┌─ stage 1  Dijkstra ────────┐  priority = g            (cost so far)
  │  costFn=distance, h=0       │  → uninformed flood
  └─────────────────────────────┘
  ┌─ stage 2  A* ──────────────┐  priority = g + h        (+ haversine)
  │  costFn=distance, h=havers. │  → aimed at the goal
  └─────────────────────────────┘
  ┌─ stage 3  grade-A* ────────┐  priority = g + h, g uses penalty
  │  costFn=gradeAbs            │  → flattest, symmetric
  └─────────────────────────────┘
  ┌─ stage 4  directional-A* ──┐  priority = g + h, g uses SIGNED grade
  │  costFn=gradeDirected       │  → flattest, A→B ≠ B→A
  └─────────────────────────────┘
  ┌─ stage 5  bidirectional ───┐  two heaps, balanced potential
  │  meet in the middle         │  → fewer expansions vs flood
  └─────────────────────────────┘
```

The seams: **stage 1→2** the heuristic flips the search from blind to
aimed (the `closed`/`g` machinery is identical). **stage 2→3** the cost
flips from distance to grade-penalized — the search engine doesn't change
*at all*, only the function plugged into it. **stage 4** the cost becomes
direction-aware, so the graph's undirected storage has to derive direction
at traversal time. That last seam — undirected storage, directed cost — is
the subtle one this file spends the most time on.

---

## How it works

### Move 1 — the mental model

You already know BFS: a frontier queue, a visited set, dequeue-expand-
enqueue until you hit the goal. A* is BFS with the FIFO queue replaced by
a *priority* queue, and the priority is a guess at total trip cost. That's
the entire idea — pop the most promising node, not the oldest one.

```
  A* — the best-first frontier (the kernel)

       start ●
            / \
       g=80●   ● g=80          each frontier node ranked by:
          /|    \                f = g + h
   g=160● |      ● g=160          g = real cost from start (so far)
         ...      ▼               h = admissible estimate to goal
                ● goal           pop LOWEST f → expand → repeat
                                 stop when goal is popped
```

The "admissible" part is the contract that makes A* *correct*: the
heuristic `h` must never *over*estimate the remaining cost. flattr uses
straight-line haversine distance (`astar.ts:9`), which can't overestimate
because the real road is never shorter than the great-circle line. Honor
that contract and A* returns the *exact same optimal path* as Dijkstra,
just by expanding fewer nodes. Break it and A* gets fast but wrong.

### Move 2 — the search kernel, one moving part at a time

#### The kernel — five parts, named by what breaks without each

This is the load-bearing skeleton. Here's the smallest thing that's still
A*:

```
  search() kernel (astar.ts:48-76)

  while open not empty:
    current = open.pop()                  ── 1. FRONTIER (priority queue)
    if closed.has(current): continue      ── 2. STALE SKIP (lazy deletion)
    if current == goal: reconstruct       ── 3. TERMINATION
    closed.add(current)                   ── 4. VISITED SET
    for edge in adjacency[current]:       ── 5. RELAXATION
      tentative = g[current] + cost(edge)
      if tentative < g[next] ?? Inf:
        g[next] = tentative
        came[next] = {edge, current}
        open.push(next, tentative + h(next))
```

What breaks if you remove each:

- **Drop the frontier (pop min):** without priority ordering it's BFS,
  which ignores edge weights — it'd return the fewest-*edges* path, not the
  flattest. Grades would be invisible.
- **Drop the stale skip:** lazy-deletion duplicates get re-expanded;
  wasted work, and the `closed` invariant breaks (file 03).
- **Drop termination on goal-pop:** the search runs the whole graph. Note
  the subtlety — it terminates when the goal is *popped* (`astar.ts:52`),
  not when it's first *seen*, because only at pop time is its cost final.
- **Drop the visited set:** revisits nodes forever on a cyclic graph
  (every street graph has cycles).
- **Drop relaxation's `<` test:** you'd overwrite good paths with worse
  ones; the `tentative < g[next]` is what keeps `g` holding the *best*
  cost.

Now walk the live ones.

#### The relaxation step — the heart of shortest-path

"Relaxing" an edge means: is going through `current` a cheaper way to
reach `next` than anything found so far?

```ts
// features/routing/astar.ts:64-74
for (const edgeId of graph.adjacency[current] ?? []) {
  const edge = byId.get(edgeId)!;
  const next = otherEnd(edge, current);
  if (closed.has(next)) continue;
  const tentative = g.get(current)! + costFn(edge, current, userMax);
  if (tentative < (g.get(next) ?? Infinity)) {
    g.set(next, tentative);
    came.set(next, { edge, prev: current });
    open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
    pushes++;
  }
}
```

Execution trace — relaxing out of `current=A` (g[A]=80) over two edges:

```
  relaxation trace (g[A]=80)

  edge A→C, cost 90:
    tentative = 80 + 90 = 170
    g[C] ?? Inf = Inf  →  170 < Inf  → relax: g[C]=170, push(C, 170+h(C))
  edge A→G, cost 100:
    tentative = 80 + 100 = 180
    g[G] ?? Inf = Inf  →  180 < Inf  → relax: g[G]=180, push(G, 180+h(G))

  later, B reaches G cheaper (g[G]=150):
    tentative = 150 < g[G]=180 → relax: g[G]=150, came[G] rewired to B
    push(G, 150+h(G))   ← duplicate G in heap; old (G,180+h) now stale
```

The priority pushed is `tentative + h(next)` — that's the f-score. `g` is
known cost; `h` is the estimate. The duplicate push is exactly the lazy
deletion from file 03: G is now in the heap twice, and the stale `(G,180)`
copy gets skipped when it pops.

#### costFn — the parameter that makes one engine into four

Here's the design move that defines flattr. The search engine never
mentions grades. It calls `costFn(edge, current, userMax)` and that's it.
The four wrappers just pick the function:

```ts
// features/routing/astar.ts:135-163 — four algorithms, one engine
export function dijkstra(g, s, go)       { return search(g,s,go, Infinity, distanceCost,        zeroHeuristic); }
export function astar(g, s, go)          { return search(g,s,go, Infinity, distanceCost,        haversineHeuristic); }
export function gradeAstar(g,s,go,uMax)  { return search(g,s,go, uMax,     gradeCostAbs,         haversineHeuristic); }
export function directedAstar(g,s,go,uMax){ return search(g,s,go, uMax,    gradeCostDirected,    haversineHeuristic); }
```

```
  One engine, four (costFn, heuristicFn) pairs

  search(...) ◄─── costFn ───┬─ distanceCost      → "shortest"
                             ├─ gradeCostAbs      → "flattest, symmetric"
                             └─ gradeCostDirected → "flattest, directional"
              ◄─── heuristicFn ─┬─ zeroHeuristic     → Dijkstra (blind)
                                └─ haversineHeuristic → A* (aimed)
```

This is dependency injection at the algorithm level. The *correctness*
proof is in the test suite: `astar.test.ts:38-45` asserts A*'s path cost
equals Dijkstra's on a 12×12 grid — the **optimality oracle**. Same
optimum, fewer expansions (`astar.test.ts:47-52`: A* expands `<=`
Dijkstra). If a refactor ever broke admissibility, that oracle would catch
it.

#### Undirected storage, directed cost — the subtle seam

The graph stores each edge **once**, listed under both endpoints
(`buildAdjacency`, `graph.ts:22-29`). There are no reversed edges. So how
does directional routing — where uphill A→B costs more than downhill
B→A — work?

Direction is **derived at traversal time**, not stored:

```ts
// features/routing/graph.ts:10-19
export function otherEnd(edge: Edge, nodeId: string): string {
  if (nodeId === edge.fromNode) return edge.toNode;
  if (nodeId === edge.toNode) return edge.fromNode;
  throw new Error(...);
}
export function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
}
```

```
  One stored edge, two travel directions (graph.ts)

  stored:   A ──[gradePct = +8%]── B     (signed from→to)

  traverse A→B:  directedGrade(edge, "A") = +8   → uphill → penalized
  traverse B→A:  directedGrade(edge, "B") = -8   → downhill → free (penalty 0)
                 otherEnd(edge, "B") = "A"

  same edge object; the FROM node decides the sign
```

`gradeCostDirected` (`cost.ts:32-33`) feeds `directedGrade(edge, fromNode)`
into `penalty()`, so the *same edge* is expensive one way and free the
other. The test proves it: `directedAstar(X,Y)` detours uphill via F, but
`directedAstar(Y,X)` takes the direct edge downhill
(`astar.test.ts:73-80`). **Why store undirected?** Half the memory, and a
single source of truth per street — you can't have the A→B and B→A grades
drift out of sync because there's only one number. The cost of that choice
is the `fromNodeId` parameter threaded through every cost function. That's
the seam: storage is undirected, cost is directional, and the bridge is a
function argument.

#### Bidirectional A* — two frontiers meeting in the middle

The stage-5 variant runs two searches at once: forward from start,
backward from goal, stopping when they meet. The win is geometric — two
small explored circles instead of one big one.

```
  Bidirectional — two frontiers (bidirectional.ts)

      start ●───►  ◄───● goal
            forward    backward
            frontier   frontier
                  \   /
                   meet         total = gf[meet] + gr[meet]
                                stop when topF + topR >= mu (best found)
```

The hard part of bidirectional A* is keeping it *correct* — a naive
"stop when they touch" returns suboptimal paths. flattr uses a **balanced
consistent potential**:

```ts
// features/routing/bidirectional.ts:30-32
const pf = (id) => (haversine(nodes[id], goal) - haversine(nodes[id], start)) / 2;
const pr = (id) => -pf(id);
```

```
  Balanced potential — keeps both frontiers consistent

  pf(node) = (h_goal(node) - h_start(node)) / 2     forward potential
  pr(node) = -pf(node)                              reverse potential

  stopping rule: topF + topR >= mu  → break  (bidirectional.ts:52)
    where mu = best meeting-point total cost found so far
```

The `/2` is what makes the forward and reverse potentials *consistent*
with each other — without it the two searches use mismatched estimates and
the meeting point isn't guaranteed optimal. The stopping rule
`topF + topR >= mu` (`bidirectional.ts:52`) says: once the two frontiers'
best remaining estimates sum to at least the best path already found, no
better meeting is possible — stop. The correctness gate is again an
oracle: `bidirectional.test.ts:16-24` asserts bidirectional's cost matches
directional-A*'s on the grid. And the test is honest about the limits —
`bidirectional.test.ts:26-38` notes bidirectional beats *uninformed
Dijkstra's* flood, but a tight unidirectional A* cone on a Euclidean grid
can legitimately expand *fewer* nodes. The win is "vs flood," not "always
fewest."

#### Reconstruction — the exact-edge subtlety

Once the goal pops, walk `came` backward to rebuild the path. The detail
that matters: it stores the **exact edge relaxed**, not the node pair, so
parallel edges stay correct (full walk in file 07).

```ts
// features/routing/astar.ts:93-99 — walk back via the exact edge
while (cur !== startId) {
  const entry = came.get(cur)!;
  edges.push(entry.edge);        // the EXACT edge, not re-resolved by pair
  cur = entry.prev;
  nodes.push(cur);
}
```

### Move 3 — the principle

A shortest-path search is four parts you can mix independently: a graph
(adjacency list), a frontier ordered by some key (the heap), a cost
function (what "shortest" means), and a heuristic (how to aim). flattr's
insight is that the *first two never change* — Dijkstra and A* and
grade-A* share one engine — and only the *last two* are parameters. Once
you see a search engine that way, "add a new routing mode" stops being "write
a new algorithm" and becomes "write a new `costFn`." That's the whole
reason the file is called `astar.ts` and not `dijkstra.ts` and
`grade-router.ts`.

---

## Primary diagram

The complete search: graph, frontier, relaxation, the cost/heuristic
parameters, and reconstruction — one frame.

```
  search() — the full A* engine (astar.ts:22-103)

  ┌─ Graph (undirected adjacency, graph.ts) ────────────────────┐
  │  adjacency[nodeId] → edgeIds   |  otherEnd/directedGrade     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ expand
  ┌─ Search loop ───────────────────────────────────────────────┐
  │  open: PQueue ──pop min-f──► current                        │
  │     closed.has? skip stale (lazy deletion, file 03)         │
  │     current==goal? ──► reconstruct via came (exact edges)   │
  │     closed.add(current)                                      │
  │     for edge in adjacency[current]:                         │
  │        tentative = g[current] + costFn(edge, current, uMax) │ ◄─ cost.ts
  │        if tentative < g[next]?:                             │
  │           g[next]=tentative; came[next]={edge,current}      │
  │           open.push(next, tentative + h(next))              │ ◄─ haversine
  └───────────────────────────┬──────────────────────────────────┘
                              │ Path
  ┌─ Output ────────────────────────────────────────────────────┐
  │  {nodes, edges, cost, lengthM, steepEdges}                  │
  │  wrappers pick (costFn,h): dijkstra/astar/gradeAstar/dir.   │
  │  variant: bidirectional (two frontiers, balanced potential) │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Dijkstra (1959) is uninformed best-first; A* (Hart, Nilsson, Raphael,
1968) adds the admissible heuristic to aim it — A* *is* Dijkstra when
`h=0`, which is literally how `astar.ts` implements Dijkstra
(`zeroHeuristic`, line 137). Bidirectional A* with consistent potentials
is from Ikeda et al. / Goldberg's work on the topic; the balanced
`(h_goal - h_start)/2` potential is the standard trick to make the two
directions agree. You've built the unweighted half of this in reincodes —
`Graph.ts` BFS/DFS, `Graph2.ts` with weighted edges supporting Dijkstra,
`PG.ts` BFS over an implicit state-space graph. flattr is the weighted,
heuristic-guided continuation: your Dijkstra animation's `PriorityQueue`
is the same frontier, now ranked by `g + h` instead of just `g`. The
biggest *missing* graph foundation is **union-find** for a connectivity
preflight (file 08) — right now "is the goal reachable?" is answered by
running the whole search and getting `null`. Read file 03 for the frontier,
file 07 for reconstruction.

---

## Interview defense

**Q: Are Dijkstra and A* different algorithms here, or the same?**

```
  one search() ── h=0 ───────► Dijkstra (blind flood)
              └─ h=haversine ─► A* (aimed cone)
  same g/came/closed/heap machinery; only the priority key changes
```

*Model answer:* "Same engine. `search()` takes a `(costFn, heuristicFn)`
pair. Dijkstra is `search` with `zeroHeuristic`; A* is `search` with the
haversine heuristic. The grade modes just swap the cost function. The
correctness gate is an oracle test: A*'s path cost must equal Dijkstra's
on a 12×12 grid — same optimum, fewer expansions. The heuristic only
changes the *order* nodes come off the heap, never the answer, as long as
it stays admissible."

*Anchor:* one parametric engine; Dijkstra is A* with `h=0`.

**Q: The graph is undirected but routing is directional. How?**

*Model answer:* "Each edge is stored once with a signed `gradePct`
from→to, listed under both endpoints in the adjacency list. Direction is
derived at traversal: `directedGrade(edge, fromNode)` returns `+gradePct`
if you entered from the `from` node, `-gradePct` otherwise, and `otherEnd`
gives the opposite endpoint. So the same edge object is uphill (penalized)
one way and downhill (free) the other. The bridge is the `fromNodeId`
argument threaded through every cost function. Storing undirected halves
memory and keeps one source of truth per street so the two-way grades
can't drift."

*Anchor:* undirected storage + `directedGrade`-derived direction; the
`fromNode` is the bridge.

**Q: Why does A* terminate when the goal is *popped*, not when it's first
seen?**

*Model answer:* "Because a node's `g` cost isn't final until it comes off
the heap. The first time you *see* the goal you might have a suboptimal
path to it; a cheaper one could still be sitting in the frontier. Only
when the goal is the minimum-f node popped do you know nothing cheaper
remains. Terminating on first-sight would return a valid but possibly
non-optimal route."

*Anchor:* `astar.ts:52` — pop-time termination is what makes A* optimal.

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the frontier this drives.
- `02-arrays-strings-and-hash-maps.md` — `g`/`came`/`closed`/`adjacency`.
- `01-complexity-and-cost-models.md` — `O(E log V)` and `BLOCKED`.
- `07-recursion-backtracking-and-dynamic-programming.md` — reconstruction.
- `08-dsa-foundations-practice-map.md` — union-find connectivity gap.
- sibling **system-design** — owns the static-graph artifact architecture.
