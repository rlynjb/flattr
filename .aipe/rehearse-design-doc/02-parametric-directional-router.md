# Design Doc — A parametric router with a directional grade cost

**One-line summary:** flattr hand-rolls one `search()` function that is Dijkstra, A\*, grade-A\*, and directed-A\* depending on the cost and heuristic passed to it, with a *directional* grade cost (uphill penalized, downhill free, so A→B ≠ B→A) and a large-but-finite `BLOCKED` sentinel that keeps "too steep" distinct from "no route."

Lead with the shape: this isn't four algorithms, it's one engine with the domain pushed entirely into a cost function. That separation is the decision, and it's what a reviewer should walk away remembering.

## Context / problem

flattr's whole premise is routing for *flattest comfortable*, not shortest. That means the cost of crossing a block depends on its grade — and on the *direction* you cross it, because climbing is hard and descending is free. Off-the-shelf routers (OSRM, Valhalla) optimize for distance/time and don't model directional grade-effort cleanly. And the project's stated goal is to own the graph algorithm, not call a library. So the problem is: design a search that's correct, provably optimal, and where the grade logic lives in exactly one place.

## Goals & non-goals

```
  GOALS                                 NON-GOALS
  ─────                                 ─────────
  optimal paths, provably               city-scale query latency
    (admissible heuristic)                (no contraction hierarchies)
  grade logic in ONE seam               a general routing platform
  directional cost (A→B ≠ B→A)          turn restrictions / one-ways
  honest failure: steep ≠ disconnected    (not modeled yet)
  the search loop is domain-agnostic    k-alternative routes
```

The decisive goal is **one seam for the domain**: the search loop must never mention grade, and the cost function must never mention search. That constraint is what makes the engine teachable and the variants free.

## The decision

One `search(graph, start, goal, userMax, costFn, heuristicFn)` engine. The named algorithms are argument tuples; direction is derived at traversal from undirected storage.

```
  ONE ENGINE, FOUR BEHAVIORS — the seam is the cost function

  search(graph, s, g, userMax, COSTFN, HEURISTICFN)
    ├─ dijkstra      = distanceCost,      zeroHeuristic    (h=0, floods)
    ├─ astar         = distanceCost,      haversine        (cones to goal)
    ├─ gradeAstar    = gradeCostAbs,      haversine
    └─ directedAstar = gradeCostDirected, haversine        (A→B ≠ B→A)

  STORAGE → TRAVERSAL → COST  (where direction enters)
  ┌────────────────────────────────────────────────────────────┐
  │ undirected edge in adjacency  ── stored once, both ends      │
  │        │ directedGrade(edge, fromNode)                       │
  │        ▼ +grade if entered from one end, −grade from other   │
  │ penalty(signedGrade, userMax):                              │
  │   downhill/flat → 0   |  up to ½·max → linear               │
  │   ½·max..max → quadratic |  > max → BLOCKED (1e9, FINITE)    │
  └────────────────────────────────────────────────────────────┘

  outcomes A* distinguishes:
    clean path        → route, no steep edges
    only-steep path   → route returned, steep edges flagged (BLOCKED finite)
    disconnected      → null  (frontier drains, goal unreached)
```

Two non-obvious choices live in that diagram. First, **direction is derived, not stored** — one physical edge yields two costs depending on travel direction, halving the graph and keeping the asymmetry in one function. Second, **`BLOCKED` is `1e9`, not `Infinity`** — so an all-steep route stays a finite, comparable, *returnable* answer (flagged "flattest available"), while `null` is reserved for a genuinely disconnected graph. `Infinity` would collapse those two states and `Infinity − Infinity = NaN` would corrupt the heap.

## Alternatives considered

| Alternative | Why it lost |
|-------------|-------------|
| **Use OSRM / Valhalla / GraphHopper** | Production-grade and city-scale, but directional grade-effort fights their distance/time cost models, and using one removes the project's entire learning goal. Right for a funded product on a deadline; wrong here. |
| **Four separate algorithm implementations** | Dijkstra, A\*, grade-A\* as distinct functions. Rejected: massive duplication, and it hides the actual insight that Dijkstra is A\* with a zero heuristic. The parametric form *teaches* the relationship. |
| **Materialize two directed edges per street** | Store A→B and B→A separately with baked directional costs. Rejected: doubles the graph and scatters the directional logic across the data instead of concentrating it in `directedGrade`. Derive-don't-materialize is cheaper and cleaner. |
| **`BLOCKED = Infinity`** | Simpler to write, but collapses "too steep" into "no route" and breaks heap arithmetic via NaN. The finite sentinel is a deliberate correctness choice. |

## Tradeoffs accepted

We chose a hand-rolled, neighborhood-scale engine, accepting **no contraction hierarchies and no spatial index** — so it doesn't answer city-scale queries in microseconds the way OSRM does, and `nearestNode` is an O(N) scan. For the project's goal and graph size, that cost is acceptable and the alternative wouldn't teach more.

> Coach note — where a reviewer pushes: "isn't a lazy-deletion heap wasteful?" The framing that holds: "it trades a bigger heap for dead-simple correctness — no decrease-key bookkeeping. The bench measures `pops` vs `nodesExpanded`; I'd port the decrease-key heap I've already built only when that ratio says the staleness actually hurts. Measure, then optimize."

## Risks & mitigations

```
  RISK                               MITIGATION
  ────                               ──────────
  inadmissible heuristic → wrong     oracle test: A* cost == Dijkstra
    'optimal' paths                    cost, or the suite fails
  bidirectional returns non-optimal  balanced consistent potential
    path (subtle)                      pf=(h_goal−h_start)/2; tested to
                                       match directed-A* cost
  lazy-deletion staleness slows       bench tracks pops≫expanded as the
    search                             trigger to upgrade to decrease-key
  parallel-edge reconstruction lies   reconstruct via the exact relaxed
    about the route                    edge, not a node-pair re-lookup
```

## Rollout / migration

Foundational, nothing to migrate. The forward path is preprocessing: contraction hierarchies or ALT landmarks add a *build-time* layer for city-scale queries without changing the query-time search, the cost model, or the heap. The engine is designed so that scaling is an additive preprocessing step, not a rewrite.

## Open questions

1. **Decrease-key threshold:** at what `pops/nodesExpanded` ratio is the heap upgrade worth the added bookkeeping?
2. **Bidirectional consistency proof:** the balanced potential is tested correct, but the formal non-negative-reduced-cost proof deserves to be written down.
3. **Turn restrictions / one-ways:** real routing needs them eventually; how do they enter the cost model without breaking the single-seam property?

┃ "Dijkstra is A\* with a zero heuristic — and the code proves it by being the same function."
┃ "Direction is derived at traversal, not stored — one edge, two costs, one seam."
