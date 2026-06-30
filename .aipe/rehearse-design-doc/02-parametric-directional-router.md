# 02 — Parametric directional router

> **Decision:** one `search()` function is the entire router. Dijkstra, A*,
> grade-aware A*, and directional grade-aware A* are not four algorithms — they're
> four `(costFn, heuristicFn)` argument pairs into the same function. Grade is
> directed (A→B costs differently than B→A), and "over your max grade" is a large
> *finite* penalty, not infinity.

---

## Context / problem

flattr's whole pitch is "optimized for flat, not fast." That's a routing problem
with three twists a stock router doesn't handle:

1. **Cost isn't distance.** A flat 1 km should beat a steep 600 m. The cost of an
   edge depends on its grade relative to the user's `userMax`.
2. **Grade is directional.** Going *up* a hill is the cost; going *down* the same
   hill is free. So the same physical edge has two different costs depending on
   travel direction — `A→B ≠ B→A`.
3. **"No flat route" must stay distinct from "no route."** If every path has one
   steep block, the user still wants the flattest *available* path, with the steep
   block flagged — not a blank "no route found."

There was also a hard constraint from the project itself (`docs/flattr-spec.md`
§14, project context): **hand-rolled graph + router only — no Valhalla / OSRM /
GraphHopper.** The graph work *is* the project. So the question wasn't "which
routing engine," it was "how do I structure my own so the four algorithm stages
don't become four copy-pasted search loops."

---

## Goals & non-goals

**Goals**
- One search core; the algorithm progression (Dijkstra → A* → grade → directional)
  is a *configuration*, not four implementations.
- Directional grade: uphill penalized, downhill free, signed by travel direction.
- A flattest-but-steep path is still returned and flagged, distinct from a genuine
  disconnection.
- A* heuristic stays admissible (haversine lower bound) so the path is optimal.

**Non-goals**
- Contraction hierarchies, ALT, or any preprocessing for continental scale. This is
  neighborhood routing.
- Turn costs, time-of-day, traffic. Cost is a pure function of edge + direction +
  `userMax`.
- Beating OSRM on raw latency. The benchmark exists to show the *progression*, not
  to win a speed contest.

---

## The decision

Make the search core take its policy as two function arguments. Everything that
varies between the four stages lives in `costFn` (how expensive is this edge?) and
`heuristicFn` (how far to the goal, optimistically?). The loop never changes.

```
  One engine, four stages — the only thing that varies is two functions

                          search(graph, start, goal, userMax, costFn, heuristicFn)
                                                              │         │
                          ┌───────────────────────────────────┘         │
                          ▼ costFn                                       ▼ heuristicFn
  ┌──────────────┬─────────────────────────────┬──────────────────────────────┐
  │ Dijkstra     │ distanceCost                 │ zeroHeuristic   (= 0)         │
  │ A*           │ distanceCost                 │ haversineHeuristic            │
  │ grade A*     │ gradeCostAbs (symmetric)     │ haversineHeuristic            │
  │ directed A*  │ gradeCostDirected (signed)   │ haversineHeuristic            │  ← flattr
  └──────────────┴─────────────────────────────┴──────────────────────────────┘
       same closed set, same lazy-deletion heap, same relax step underneath
```

The insight: **Dijkstra is A* with a zero heuristic; A* is grade-A* with a distance
cost; grade-A* is directional-A* with the sign thrown away.** Each stage is the
previous one with one argument changed. That's not four algorithms to a reviewer
who sees it — it's one algorithm with a 2-axis knob.

### The search core

`search()` is the kernel (`features/routing/astar.ts:22`). Strip it to the parts
that can't be removed without it ceasing to be A*:

```
  The kernel — name each part by what breaks without it

  open    : PQueue<nodeId>    drop it → no "cheapest frontier first" → not Dijkstra/A*
  g       : Map<id, cost>     drop it → can't tell if a new path is cheaper → wrong path
  came    : Map<id, {edge}>   drop it → found the goal but can't reconstruct the route
  closed  : Set<id>           drop it → re-expand finalized nodes → blowup on cycles
  costFn  : (edge,from,max)   THIS is the policy seam — swap it, change the algorithm
  heurFn  : (node,goal)       drop it (→0) → A* degrades to Dijkstra, still correct
```

The relax step is textbook, with the two seams marked
(`features/routing/astar.ts:64`):

```ts
// features/routing/astar.ts:64 — the hot loop; the two function args are the seams
for (const edgeId of graph.adjacency[current] ?? []) {
  const edge = byId.get(edgeId)!;
  const next = otherEnd(edge, current);
  if (closed.has(next)) continue;
  const tentative = g.get(current)! + costFn(edge, current, userMax);   // ← cost SEAM
  if (tentative < (g.get(next) ?? Infinity)) {                          //   (direction-aware:
    g.set(next, tentative);                                             //    passes `current`
    came.set(next, { edge, prev: current });                           //    as fromNode)
    open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  // ← heuristic SEAM
  }
}
```

The stage wrappers are one-liners — proof the variation really is just the two
arguments (`features/routing/astar.ts:136`):

```ts
// features/routing/astar.ts:136–162 — the whole "progression" is four calls
export const dijkstra      = (g,s,t)       => search(g,s,t, Infinity, distanceCost,       zeroHeuristic);
export const astar         = (g,s,t)       => search(g,s,t, Infinity, distanceCost,       haversineHeuristic);
export const gradeAstar    = (g,s,t,max)   => search(g,s,t, max,      gradeCostAbs,       haversineHeuristic);
export const directedAstar = (g,s,t,max)   => search(g,s,t, max,      gradeCostDirected,  haversineHeuristic);
```

### Directional cost — the surprising part

Grade is signed by travel direction. `directedGrade` returns `+gradePct` if you're
traversing the edge the way it was stored, `-gradePct` if you're going the other
way (`features/routing/graph.ts:17`):

```ts
// features/routing/graph.ts:17 — same edge, opposite sign depending on direction
return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
```

The cost function feeds that signed grade into a penalty curve
(`features/routing/cost.ts:16`). Downhill or flat costs nothing extra; moderate
uphill is linear; steep uphill is quadratic; over your max is `BLOCKED`:

```ts
// features/routing/cost.ts:16 — penalty(g, max): the grade → multiplier curve
if (g <= 0) return 0;                       // downhill / flat → free
if (g > max) return BLOCKED;                // over your limit → 1e9 (finite!)
const half = 0.5 * max;
if (g <= half) return k1 * g;               // moderate uphill → linear
return k2 * (g - half) ** 2 + k1 * half;    // steep uphill → quadratic, continuous at half
```

Because `current` (the from-node) is threaded through `costFn`, the *same edge*
relaxes at different cost depending on which direction the search reached it. That
asymmetry is the entire "flat, not fast" behavior.

```
  Directional cost — one edge, two costs

       edge stored from A → B, gradePct = +6%, userMax = 5%

  search arrives at A, relaxes toward B:           search arrives at B, relaxes toward A:
  ┌─────────┐   directedGrade = +6% (> max)        ┌─────────┐   directedGrade = -6%
  │    A    │ ──────────────────────────► B        │    B    │ ──────────────────────► A
  └─────────┘   penalty = BLOCKED (1e9)            └─────────┘   penalty = 0 (downhill, free)
       cost = lengthM * (1 + 1e9)                       cost = lengthM * (1 + 0) = lengthM
       → router avoids climbing it                      → router happily descends it
```

### BLOCKED is finite, on purpose

The reflex is to make an over-limit edge cost `Infinity` — unroutable. flattr
makes it `1e9`, large but finite (`features/routing/cost.ts:5`):

```ts
// features/routing/cost.ts:5 — Large but FINITE, so an only-steep path is still returned
export const BLOCKED = 1e9;
```

Here's what that buys, and it's the part people miss. With `Infinity`, a city where
*every* path has one steep block returns "no route" — indistinguishable from two
genuinely disconnected points. With `1e9`, the router still finds the flattest path
(it just pays a huge but comparable penalty for the one steep block), returns it,
and `summarizePath` flags exactly which edges exceed `userMax`
(`features/routing/astar.ts:126`):

```ts
// features/routing/astar.ts:126 — flag the steep edges instead of refusing the route
if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
  steepEdges.push(edge.id);     // honesty: "flattest available, with these steep blocks"
}
```

```
  Why finite — "no flat route" must differ from "no route"

   userMax = 5%, every path has one 7% block

   BLOCKED = Infinity                    BLOCKED = 1e9 (finite)
   ──────────────────                    ──────────────────────
   every path cost = ∞                   flattest path cost = real + 1e9
   → search returns null                 → search returns that path
   → UI: "No route"        ✗ wrong       → steepEdges = [that block]   ✓ honest
                                          → UI: "⚠ Flattest available, 1 steep block"
```

That maps straight to the three UI states in `RouteSummaryCard.tsx`: "Flat all the
way" (steepCount 0), "⚠ Flattest available" (steepCount > 0, the finite-BLOCKED
case), "No route between those points" (`path === null`, genuine disconnection).

---

## Alternatives considered

**1. OSRM / Valhalla / GraphHopper.** Production routing engines with contraction
hierarchies, mature, fast at continental scale. Lost on two counts. First, the
project constraint forbids it — the hand-rolled graph work *is* the project
(`docs/flattr-spec.md` §14). Second, even allowed, the grade model is custom:
directional grade penalty against a per-user `userMax` knob isn't a built-in cost
in any of them, and the finite-BLOCKED honesty ("flattest available") is a product
behavior, not a routing primitive. You'd be fighting the engine to express the one
thing that makes flattr flattr.

**2. Four separate search functions, copy-pasted.** Write `dijkstra()`,
`astar()`, `gradeAstar()`, `directedAstar()` each with its own loop. Lost because
the loop is identical four times — the only difference is cost and heuristic. Four
copies means a bug in the relax step (say, the lazy-deletion check) has to be fixed
four times. The parametric version fixes it once. The benchmark
(`bench/run.ts`) needs all four to compare; one core that takes two functions gives
them for free.

**3. Strategy objects (a `Router` interface, four classes).** The OO version of
the same idea: a `CostStrategy` interface, four implementing classes. Lost because
in TypeScript a `CostFn` *is* the strategy — `type CostFn = (edge, fromNodeId,
userMax) => number` (`features/routing/types.ts:40`). A function type is the
lightest possible strategy pattern; a class hierarchy is ceremony around the same
seam.

---

## Tradeoffs accepted

We chose one parametric core, accepting:

- **No contraction hierarchies, no preprocessing.** Every search is a cold A* from
  scratch. That caps the practical scale at neighborhood size — fine for the
  product, a wall at city-wide instant routing. We chose the clarity and the
  hand-rolled mandate over the scale we don't need.
- **`costFn` runs in the hot loop, per edge relaxed.** A function call per
  relaxation, not an inlined arithmetic expression. The benchmark
  (`bench/`) is there precisely to keep an eye on that the parametric seam doesn't
  cost real latency at the target scale.
- **The admissibility constraint is a discipline, not a type.** The heuristic must
  stay a lower bound (haversine) and the penalty must stay `≥ 0`, or A* stops
  returning optimal paths. Nothing in the type system enforces it — it's a rule a
  future `costFn` author has to know. Named in the project constraints; not
  machine-checked.

---

## Risks & mitigations

```
  Risk                                   Mitigation                        where
  ─────────────────────────────────────  ────────────────────────────────  ──────────────
  a new costFn returns a negative        penalty() is ≥ 0 by construction; cost.ts:16
    penalty → A* non-optimal               documented invariant
  inadmissible heuristic → wrong path    haversine is a true lower bound   astar.ts:9
                                            (great-circle ≤ road distance)
  NaN priority corrupts the heap         PQueue throws on NaN push         pqueue.ts:24
    ordering silently
  BLOCKED accidentally made Infinity     comment + this doc pin the        cost.ts:5
    → "no flat route" regresses to         finite invariant; tested
    "no route"
  parametric call overhead at scale      bench/ tracks pushes/pops/        bench/run.ts
                                            nodesExpanded per stage
```

The heap throwing on `NaN` (`features/routing/pqueue.ts:24`) is the quiet hero — a
`NaN` priority would make heap comparisons all-false and silently corrupt ordering;
failing loud at push turns a heisenbug into a stack trace.

---

## Rollout / migration

Adding a new routing behavior is *not* a migration — it's a new `(costFn,
heuristicFn)` pair and a wrapper. A "prefer shade" or "avoid stairs" mode would be
a new `costFn` and a one-line wrapper next to the existing four
(`features/routing/astar.ts:136`). Callers that already pass `userMax` don't change.

The one migration that *would* ripple: changing the `CostFn` signature (e.g. adding
time-of-day). That's a type change touching every cost function and the `search`
call site. The signature is the seam's contract — widen it deliberately.

---

## Open questions

- **Bidirectional search exists (`features/routing/bidirectional.ts`) but the
  directional cost makes it subtle.** A backward search has to negate grades
  correctly to stay consistent. Is the meet-in-the-middle stopping condition proven
  correct under an asymmetric cost? Worth a written proof, not just a passing test.
- **Should admissibility be enforced, not just documented?** A dev-mode assertion
  that `heuristic(a,b) <= trueCost(a,b)` on sampled pairs would catch an
  inadmissible heuristic at test time instead of as a silently-suboptimal route.
- **Is the quadratic steep-band curve (`k2 * (g-half)²`) the right shape, or just a
  reasonable one?** The constants `k1=0.4, k2=1.0` are tunable
  (`cost.ts:8`) but un-tuned against real rider preference. Open.

---

## Coach notes

- **Verdict first:** "It's one function. Dijkstra, A*, grade, directional — same
  `search()`, different two arguments." Say that before the breakdown. It reframes
  the whole thing from "four algorithms" to "one algorithm, two-axis knob," which is
  the staff-level read.
- The single most impressive thing to surface is **finite BLOCKED**. Most people
  make unroutable edges `Infinity`. Explaining *why* finite — "so 'flattest
  available' stays distinct from 'no route'" — signals you've thought about the
  product behavior, not just the algorithm. Lead with it if the interviewer knows
  graph algorithms.
- If they ask "why not OSRM," don't apologize for hand-rolling. "The custom grade
  model — directional, per-user max, flattest-available honesty — isn't a primitive
  in any of them; I'd be fighting the engine to express the one thing that matters."
- The bridge for a frontend reader: `costFn`/`heuristicFn` are render props for an
  algorithm. Same pattern as passing a `renderItem` to a list — the structure is
  fixed, the policy is injected. You've written that a hundred times.

## See also

- `01-build-time-graph-artifact.md` — the graph this router reads
- `03-honest-degradation-elevation.md` — where the grades come from
- `.aipe/study-dsa-foundations/` — A*, Dijkstra, binary heaps, admissibility
- `.aipe/study-system-design/` — the strategy-via-function seam
