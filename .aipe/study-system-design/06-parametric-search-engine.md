# Parametric search engine

**Industry names:** strategy pattern / policy injection / one engine, many
algorithms / dependency-injected cost & heuristic. **Type:** Industry standard.

---

## Zoom out, then zoom in

flattr's algorithm progression — Dijkstra → A* → grade-aware A* → directional A* —
isn't four implementations. It's **one** `search()` function, and each "algorithm"
is just a choice of two functions passed in: a cost function and a heuristic. The
entire routing capability collapses to a single parametric engine.

```
  Zoom out — one engine, four named wrappers, one production caller

  ┌─ Engine (features/routing/astar.ts) ────────────────────────┐
  │  ★ search(graph, start, goal, userMax, costFn, heuristicFn) ★│ ← we are here
  └───────────────┬─────────────────────────────────────────────┘
       ┌──────────┼──────────┬─────────────┐
       ▼          ▼          ▼             ▼
   dijkstra    astar    gradeAstar    directedAstar  ← (costFn, heuristicFn) presets
   (bench)    (bench)    (bench)       (production, MapScreen.tsx:155)
```

You've passed a comparator into `sort()` and gotten a totally different ordering
from the same algorithm — the sort is fixed, the *policy* is injected. Same shape:
`search()` is fixed (priority-queue best-first with lazy deletion and a closed set);
the cost and heuristic are injected, and that injection is the difference between
Dijkstra and directional grade-A*. The question it answers: *how does one codebase
support a whole algorithm progression without four diverging copies?*

---

## The structure pass

**Layers:** named wrapper → generic `search()` → injected `costFn`/`heuristicFn` →
graph primitives.

**Axis = control (what decides the route's shape — the engine, or the injected
policy?).**

```
  One question down the layers: "what decides which route wins?"

  ┌───────────────────────────────────┐
  │ search() loop                     │  → the ENGINE decides traversal order
  └───────────────────────────────────┘     (pop min-f, relax, close)
      ┌─────────────────────────────────┐
      │ costFn (distance / grade / dir) │  → the POLICY decides what's "cheap"
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ heuristicFn (zero/haversine)│  → the POLICY decides the lower bound
          └─────────────────────────────┘

  the engine is invariant; swapping the two injected fns is the whole progression
```

**Seam = the `(CostFn, HeuristicFn)` parameter pair (`types.ts:40`, `:43`).** This
is the substitution boundary. `search()` never names "grade" or "distance" — it
calls `costFn(edge, current, userMax)` and `heuristicFn(node, goal)` and trusts the
contract. Cross the seam and the *behavior* axis flips entirely (Dijkstra ↔
directional grade-A*) while the engine code doesn't move a line. The one rule the
seam must honor: the heuristic stays admissible (haversine lower bound; penalty ≥ 0),
pinned in the project constraints.

---

## How it works

#### Move 1 — the mental model

The shape is best-first search with two pluggable holes. A priority queue ordered by
`g + h`; pop the cheapest, relax neighbors through `costFn`, estimate the rest
through `heuristicFn`. Fill the holes with `(distanceCost, zeroHeuristic)` and it's
Dijkstra; with `(gradeCostDirected, haversineHeuristic)` it's the production router.

```
  Pattern — best-first with two injected holes

  open = PQueue ordered by  g(n) + ⟨heuristicFn⟩(n, goal)
  while open not empty:
    current = open.pop()              ← cheapest f
    if current in closed: continue    ← lazy deletion (stale dup)
    if current == goal: reconstruct   ← done
    closed.add(current)
    for edge in adjacency[current]:
        tentative = g[current] + ⟨costFn⟩(edge, current, userMax)   ← HOLE 1
        if tentative < g[next]:
            g[next] = tentative
            open.push(next, tentative + ⟨heuristicFn⟩(next, goal))  ← HOLE 2
```

#### Move 2 — the load-bearing skeleton

This concept has a kernel — the A* loop — so here's the skeleton, each part named by
what breaks without it.

**1. The frontier (priority queue) — without it, no "cheapest-first."**
```ts
// features/routing/astar.ts:30
const open = new PQueue<string>();              // hand-rolled binary heap (pqueue.ts)
open.push(startId, heuristicFn(graph.nodes[startId], goal));
```
Drop the PQueue and you can't always expand the lowest-cost node; optimality is gone.

**2. The `g` map (best-known cost) — without it, no relaxation.**
```ts
// astar.ts:69
const tentative = g.get(current)! + costFn(edge, current, userMax);   // HOLE 1
if (tentative < (g.get(next) ?? Infinity)) { g.set(next, tentative); ... }
```
This is where `costFn` enters. Drop the comparison and you'd accept the first path to
a node, not the cheapest.

**3. The closed set + lazy deletion — without it, rework and stale pops.**
```ts
// astar.ts:51
if (closed.has(current)) continue;   // stale duplicate left by an earlier cheaper push
closed.add(current);
```
The PQueue has no decrease-key, so a node can be pushed multiple times; lazy deletion
skips the stale copies on pop. Drop it and you re-expand finalized nodes.

**4. The injected policy — the two holes that make it parametric.**
```ts
// astar.ts:8 — heuristics
export const zeroHeuristic = () => 0;                         // Dijkstra
export const haversineHeuristic = (node, goal) => haversine(node, goal);  // A*
// cost.ts:25 — costs
export const distanceCost = (edge) => edge.lengthM;           // pure distance
export const gradeCostDirected = (edge, from, max) =>         // production
  edge.lengthM * (1 + penalty(directedGrade(edge, from), max));
```
These are the only things that change across the progression.

**The four wrappers are one-liners.** This is the payoff — the whole "algorithm
progression" is preset injection:
```ts
// astar.ts:136
dijkstra      = (g,s,e) => search(g,s,e, Infinity, distanceCost,       zeroHeuristic);
astar         = (g,s,e) => search(g,s,e, Infinity, distanceCost,       haversineHeuristic);
gradeAstar    = (g,s,e,m)=> search(g,s,e, m,        gradeCostAbs,       haversineHeuristic);
directedAstar = (g,s,e,m)=> search(g,s,e, m,        gradeCostDirected,  haversineHeuristic);
```

**Optional hardening (not the kernel):** `indexEdges` builds an id→edge map so each
expansion is O(1) not O(E) (`astar.ts:12`); `reconstruct` walks the exact relaxed
edges so parallel edges don't get mis-resolved (`:86`). These make it fast and
correct on multigraphs, but the *pattern* is the four-part kernel above.

The substitution, drawn:

```
  Layers-and-hops — same engine, swapped policy

  ┌─ caller ─────────────┐ hop1: pick preset    ┌─ search() (invariant) ──────┐
  │ MapScreen            │ ───────────────────► │ PQueue · g · closed · loop  │
  │ → directedAstar      │  (costFn,heuristicFn) │                             │
  └──────────────────────┘                      └───────┬────────────┬────────┘
                                       hop2: costFn(edge)│   hop3: heuristicFn(node)
                                                         ▼            ▼
                                   ┌─ cost.ts ──────┐  ┌─ haversine (lib/geo) ─┐
                                   │ gradeCostDirected│ │ admissible lower bound│
                                   └────────────────┘  └───────────────────────┘
```

#### Move 3 — the principle

When several algorithms share a skeleton and differ only in a policy, inject the
policy instead of copying the skeleton. The win isn't just less code — it's that the
engine is tested *once* and every variant inherits its correctness, and the
`bench/` harness can compare Dijkstra→A*→directional by swapping presets against the
identical engine (`SearchResult` carries `nodesExpanded`/`pushes`/`pops` for exactly
that, `types.ts:46`). The seam to protect is the contract: keep the heuristic
admissible or A* stops returning optimal paths.

---

## Primary diagram

```
  Parametric search engine — full pattern

  ┌─ callers ────────────────────────────────────────────────────┐
  │ dijkstra · astar · gradeAstar · directedAstar (production)    │
  └───────────────┬──────────────────────────────────────────────┘
                  ▼ (costFn, heuristicFn, userMax)
  ┌─ search() — invariant best-first engine ─────────────────────┐
  │  open: PQueue by g+h   │ closed set + lazy deletion           │
  │  pop min-f → relax neighbors via costFn → push via +heuristic │
  │  indexEdges (O(1) expand) · reconstruct exact relaxed edges   │
  └───────┬───────────────────────────────────┬──────────────────┘
          ▼ HOLE 1                             ▼ HOLE 2
  ┌─ costFn ─────────────────────┐   ┌─ heuristicFn ───────────────┐
  │ distance | gradeAbs |        │   │ zero (Dijkstra) |           │
  │ gradeDirected (signed,       │   │ haversine (admissible A*)   │
  │ BLOCKED 1e9 — see 04-)       │   │                             │
  └──────────────────────────────┘   └─────────────────────────────┘
```

---

## Elaborate

This is the strategy pattern at its cleanest — the GoF version wraps each policy in a
class, but in TypeScript a function *is* the strategy, so `CostFn` and `HeuristicFn`
are just type aliases (`types.ts:40`). The same instinct shows up everywhere you've
passed a comparator to `sort` or a reducer to `reduce`: fixed machine, injected
decision.

The cost policy's internals (the banded penalty, the finite `BLOCKED`) are
`04-honest-fallback-routing.md`. The graph this runs over is assembled by
`03-tile-merge-stitch.md`. The A* optimality argument, the binary-heap `PQueue`
internals, and admissibility live in `study-dsa-foundations` — this guide treats the
engine as an *architectural seam* (the injection boundary), not as an algorithm to
re-teach.

---

## Interview defense

**Q: Is the Dijkstra→A*→directional progression four algorithms or one?**
One. `search()` is a single best-first engine; the four named functions are just
preset `(costFn, heuristicFn)` pairs (`astar.ts:136`). Dijkstra is `search` with a
zero heuristic; directional grade-A* is `search` with the signed-grade cost and a
haversine heuristic. The engine never moves.

```
  search(...) ──┬─ +distanceCost +zeroHeuristic      = Dijkstra
                ├─ +distanceCost +haversine          = A*
                └─ +gradeCostDirected +haversine      = production router
```
Anchor: one engine, injected policy — "A* is Dijkstra with a heuristic" is literally
true in this code.

**Q: What's the load-bearing part people forget in this loop?**
The closed-set + lazy-deletion check (`astar.ts:51`). The PQueue has no decrease-key,
so nodes get pushed multiple times; without the `if (closed.has(current)) continue`
you re-expand finalized nodes and waste work (and can mis-handle stale entries).
Naming that is the signal you've built A*, not just called one.
Anchor: lazy deletion compensates for a heap with no decrease-key.

**Q: What contract does the injection seam require?**
The heuristic must be admissible — never overestimate remaining cost — or A* stops
returning optimal paths. Haversine is a valid lower bound on road distance, and the
grade penalty is ≥ 0 so it never makes the heuristic inadmissible. It's a pinned
project constraint.
Anchor: admissible heuristic is the contract the parametric seam must keep.

---

## See also

- `04-honest-fallback-routing.md` — the cost policy's finite `BLOCKED` ceiling.
- `03-tile-merge-stitch.md` — assembles the graph this searches.
- `study-dsa-foundations` — A* optimality, the `PQueue` binary heap, admissibility.
- `audit.md` lenses 2, 8 — data flow, the O(E) `edgeById` red flag vs `indexEdges`.
</content>
