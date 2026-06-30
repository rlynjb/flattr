# 01 — Parametric search over cost functions

**Industry names:** strategy pattern / dependency injection / policy-as-parameter.
**Type label:** Industry standard.

One `search()` is Dijkstra, A*, grade-A*, and directed-A* — the
difference is two function arguments, never a branch inside the loop.

---

## Zoom out, then zoom in

Where this sits: it's the floor of the routing core. Everything that
routes — the bench harness, the mobile route button, every test — calls
through this one function.

```
  Zoom out — where parametric search lives

  ┌─ MOBILE / BENCH (callers) ───────────────────────────────────┐
  │  MapScreen route tap        bench/run.ts        *.test.ts     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ dijkstra() / astar() /
                                  │ gradeAstar() / directedAstar()
  ┌─ ROUTING CORE (features/routing) ────────────────────────────┐
  │  ┌──────────────────────────────────────────────────────┐    │
  │  │  ★ search(graph, start, goal, userMax,                │    │
  │  │           costFn, heuristicFn)  ★  ← we are here       │    │
  │  └───────┬───────────────────────────┬───────────────────┘    │
  │          │ costFn                     │ heuristicFn            │
  │   ┌──────▼─────┐               ┌──────▼─────┐                  │
  │   │ cost.ts    │               │ haversine /│                  │
  │   │ (penalty)  │               │ zero       │                  │
  │   └────────────┘               └────────────┘                  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **the strategy pattern, applied to a graph
search.** You've done this every time you passed a comparator to
`Array.prototype.sort` — `sort` is the algorithm, your `(a,b) => …` is
the policy. Here `search` is the algorithm and `(costFn, heuristicFn)`
is the policy. The whole "Dijkstra → A* → grade → directional"
progression the bench measures is *one body* with four argument pairs.

---

## Structure pass

**Layers.** Two: the generic search engine (outer) and the concrete
cost/heuristic policies (inner). The stage wrappers
(`dijkstra`/`astar`/`gradeAstar`/`directedAstar`) are the named bindings
between them.

**Axis held constant — "who knows the domain (grade)?"** Trace it down:

```
  One question down the layers: "who knows about grade?"

  ┌──────────────────────────────────────┐
  │ search()           astar.ts:22        │  → knows NOTHING about grade
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ costFn (a parameter)             │  → the seam: grade enters HERE
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ gradeCostDirected  cost.ts:32│  → knows EVERYTHING about grade
          └──────────────────────────────┘

  the answer flips at the costFn boundary — that's the load-bearing seam
```

**Seam.** `search() │ costFn`. The axis "who knows about grade" flips
from *nothing* to *everything* exactly there. That's why it's load-bearing:
you can swap the grade model, add a new cost (traffic, surface, shade)
or remove grade entirely, and the search loop never changes. → the
penalty side of this seam is `02-penalty-as-the-domain-seam.md`.

Hand off to mechanics.

---

## How it works

### Move 1 — the mental model

The shape: a search loop with two **holes** punched in it where a
decision must be made — "what does this edge cost?" and "how far might
the goal still be?" — and those holes are filled by arguments, not by
`if` branches. Same shape as `sort(arr, comparator)`: the loop is fixed,
the policy is injected.

```
  Pattern — the loop with two injected holes

         ┌───────────────────────────────────────┐
         │  pop cheapest frontier node            │
         │  for each neighbor edge:               │
         │     g' = g + ┌───────────┐ ← HOLE 1    │
         │              │  costFn   │   (policy)   │
         │              └───────────┘              │
         │     priority = g' + ┌────────────┐      │
         │                     │ heuristicFn│ ←HOLE 2
         │                     └────────────┘      │
         │     push neighbor at priority           │
         └───────────────────────────────────────┘
              the loop is fixed; the holes are arguments
```

### Move 2 — the walkthrough

**The signature is the whole design.** `search` takes the two policies
as its last two parameters. This is the line that makes four algorithms
into one.

```ts
// features/routing/astar.ts:22-29
export function search(
  graph: Graph, startId: string, goalId: string,
  userMax: number,
  costFn: CostFn,            // ← HOLE 1: what does an edge cost?
  heuristicFn: HeuristicFn   // ← HOLE 2: estimate to goal
): SearchResult {
```

`CostFn` and `HeuristicFn` are the contracts (`types.ts:40,43`). Anything
matching those types plugs in. That's the seam, expressed as a type.

**Hole 1 fires in the relaxation step.** `astar.ts:68` — the loop adds
`costFn(edge, current, userMax)` and never asks *what kind* of cost it
is:

```ts
// features/routing/astar.ts:68
const tentative = g.get(current)! + costFn(edge, current, userMax);
```

Bridge from what you know: this is the `g + edgeWeight` line of any
Dijkstra you've written — except `edgeWeight` is `costFn(...)`, so the
*meaning* of "weight" is supplied from outside. For `distanceCost` it's
meters; for `gradeCostDirected` it's meters-inflated-by-uphill. The loop
can't tell.

**Hole 2 fires in the push.** `astar.ts:72`:

```ts
// features/routing/astar.ts:72
open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
```

For `zeroHeuristic` (`astar.ts:8`) this is just `tentative` — pure
Dijkstra, no guidance. For `haversineHeuristic` (`astar.ts:9`) it adds a
straight-line lower bound — A*'s informed push. **The boundary condition:**
the heuristic must be *admissible* (never overestimate) or A* returns a
wrong path. flattr keeps it admissible by construction — haversine is a
true lower bound on road distance, and the grade penalty is ≥ 0 so it
only ever *adds* cost (audit constraint, spec §14). Break admissibility
and this exact line silently returns suboptimal routes.

**The four bindings — the named vocabulary.** `astar.ts:136-163` binds
the holes:

```ts
// features/routing/astar.ts:136-163  (condensed)
dijkstra      = search(g, s, t, Infinity, distanceCost,       zeroHeuristic)
astar         = search(g, s, t, Infinity, distanceCost,       haversineHeuristic)
gradeAstar    = search(g, s, t, userMax,  gradeCostAbs,       haversineHeuristic)
directedAstar = search(g, s, t, userMax,  gradeCostDirected,  haversineHeuristic)
```

Read down the cost column: distance → distance → abs-grade →
directed-grade. Read the heuristic column: zero → haversine → haversine →
haversine. The *entire algorithm progression* is a table of argument
choices. The bench harness walks exactly these four to show each
addition's effect on `nodesExpanded`.

**Why this isn't a pass-through layer.** Each wrapper adds the one fact
that names the algorithm (the audit lens 4 makes this call). `dijkstra`
*is* the binding `(distanceCost, zeroHeuristic)` — that's information, not
forwarding.

### Move 3 — the principle

When several "different" things share a skeleton and differ only in a
decision, make the decision a parameter and the skeleton a single
function. You stop maintaining four search loops and start maintaining
one loop plus four tiny policies — and each policy is independently
testable without standing up a graph. The signal that you've found the
right seam: adding the *next* variant (a shade-aware cost, a traffic
cost) is a new 3-line function, not an edit to `search`.

---

## Primary diagram

The whole pattern in one frame: one engine, two typed holes, four
bindings, many callers.

```
  Parametric search — full recap

  callers:  dijkstra()  astar()  gradeAstar()  directedAstar()  (astar.ts:136)
                  │         │          │              │
                  └────┬────┴─────┬────┴──────┬───────┘
                       ▼          ▼           ▼
                 (distanceCost,  (gradeCostAbs, (gradeCostDirected,
                  zeroHeuristic)  haversine)     haversine)
                       │          │           │
                       ▼          ▼           ▼
            ┌─────────────────────────────────────────────┐
            │  search(graph,start,goal,userMax,            │ astar.ts:22
            │         costFn ◄HOLE1, heuristicFn ◄HOLE2)   │
            │  ┌───────────────────────────────────────┐  │
            │  │ pop → relax via costFn → push via      │  │
            │  │ tentative+heuristicFn → repeat         │  │
            │  └───────────────────────────────────────┘  │
            │            returns SearchResult{path,metrics}│
            └─────────────────────────────────────────────┘
                       CostFn / HeuristicFn = types.ts:40,43
```

---

## Elaborate

This is the strategy pattern (GoF) meeting dependency injection, and it's
the same instinct behind `Array.sort(cmp)`, React's render props, and a
SQL planner that takes a cost model. The graph-search version has a long
pedigree: a textbook A* *is* Dijkstra with a heuristic added, so unifying
them under one parameterized loop isn't a flattr invention — it's
recognizing that the "four algorithms" were always one algorithm with a
knob. What flattr does well is resist the temptation to special-case:
there's no `if (useGrade)` anywhere in `search`. Read `cost.ts` next
(`02`) for the policy side of the seam; read `study-dsa-foundations` for
the A*/Dijkstra algorithms themselves.

---

## Project exercises

### EX-01-A — Add a fifth cost without touching `search`

- **What to build:** a `surfaceCost` `CostFn` that inflates unpaved
  edges, plus a `surfaceAstar` wrapper.
- **Why it earns its place:** proves the seam holds — if you can add a
  variant with zero edits to `astar.ts:22-78`, the design is real.
- **Files to touch:** `features/routing/cost.ts` (new fn),
  `features/routing/astar.ts` (new wrapper only).
- **Done when:** a test routes with it and `search` is byte-unchanged.
- **Estimated effort:** 30 min.

### EX-01-B — Prove the heuristic admissibility boundary

- **What to build:** a test that injects a *deliberately inadmissible*
  heuristic (haversine × 5) and asserts the returned path is no longer
  optimal vs Dijkstra on the same graph.
- **Why it earns its place:** makes the load-bearing boundary condition
  visible — the seam allows a wrong policy, so you learn what the
  contract protects.
- **Files to touch:** `features/routing/astar.test.ts`.
- **Done when:** the test demonstrates the suboptimal path and a comment
  names why.
- **Estimated effort:** 45 min.

---

## Interview defense

**Q: Why one `search()` instead of separate `dijkstra` and `astar`
functions? Isn't that over-engineering?**

The load-bearing answer: Dijkstra and A* *are the same algorithm* —
A* is Dijkstra with an admissible heuristic added to the priority. Once
you see that, two copies is the over-engineering: two loops to keep in
sync, two places a stale-skip bug can hide. One parameterized loop with
`(costFn, heuristicFn)` holes is the smaller surface.

```
  one loop, four bindings  vs  four loops

  search(…, costFn, heuristicFn)        dijkstraLoop(){…}
     ├ (distance, zero)    = dijkstra   astarLoop(){…}      ← 4 copies
     ├ (distance, hav)     = astar      gradeLoop(){…}        of the same
     ├ (gradeAbs, hav)     = gradeAstar dirLoop(){…}          stale-skip
     └ (gradeDir, hav)     = directed   ↑ every fix ×4
```

**Q: What stops a bad cost function from breaking the search?**
The `CostFn` type contract plus one invariant: cost ≥ 0 (penalty never
negative, `cost.ts:16` returns 0 for downhill). And `pqueue.ts:24`
throws on NaN priority, so a cost that returns NaN fails loud at push,
not silently in heap order.

**Anchor:** "Dijkstra and A* are the same loop; the difference is two
arguments — `search(…, costFn, heuristicFn)` in `astar.ts:22`."

---

## See also

- `02-penalty-as-the-domain-seam.md` — the cost side of the seam.
- `03-directed-traversal-over-undirected-storage.md` — how `directedGrade`
  feeds the directed cost.
- `04-lazy-deletion-priority-queue.md` — the heap the loop pops from.
- `05-blocked-as-large-finite.md` — what an over-grade edge costs.
- `audit.md` lens 2 (deepest module), lens 4 (not a pass-through).
