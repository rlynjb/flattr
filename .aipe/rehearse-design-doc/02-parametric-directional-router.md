# RFC 02 — Parametric directional router

**Decision:** there is exactly one search function. Dijkstra, A*, grade-aware A*, and
directional A* are not four algorithms — they're four `(costFn, heuristicFn)` arguments
to the same `search()` (`features/routing/astar.ts:22`). Direction is real: A→B and B→A
cost differently because the grade penalty reads a *signed* directed grade. And the
"too steep" cost is `BLOCKED = 1e9` — large but **finite**, not `Infinity`
(`features/routing/cost.ts:5`).

> Coach: the verdict up front is "one engine, parameterized — the algorithm names are
> just argument presets." That reframes a reviewer who expects to see four functions.
> Then the two things they'll actually probe: directional cost and the finite BLOCKED.
> Lead with those; they're where the design earns its keep.

═════════════════════════════════════════════════
2. CONTEXT / PROBLEM
═════════════════════════════════════════════════

flattr "optimizes for flat, not fast." That means three things a stock router doesn't do:

- **Grade is a cost, not just a label.** A short steep block should cost more than a
  longer flat detour. The router has to weight edges by steepness against the user's
  comfort knob `userMax`.
- **Grade is directional.** Going *up* a 8% hill is hard; going *down* it is free. The
  same physical street has a different cost depending on which way you travel it. A→B ≠ B→A.
- **"No flat route" must differ from "no route at all."** If every path has a steep block,
  the user should still get the flattest one *flagged*, not a blank "no route." Those are
  two genuinely different answers (`docs/flattr-spec.md` §14.4).

And the framing constraint: the graph work is the project (`docs/flattr-spec.md` §14, no
OSRM/Valhalla). The router is hand-rolled, and it's also a *benchmarkable progression* —
Dijkstra → A* → grade → directional → bidirectional — that has to be measured against
itself (`docs/flattr-spec.md` §15.2, `bench/`).

═════════════════════════════════════════════════
3. GOALS & NON-GOALS
═════════════════════════════════════════════════

**Goals**
- One correct search core; the algorithm progression expressed as parameter choices, not
  copy-pasted functions.
- A* heuristic stays **admissible** (haversine lower bound; penalty ≥ 0) so A* returns
  the optimal path, not just *a* path.
- Directional grade cost: free downhill, penalized uphill, asymmetric per direction.
- "Flattest-but-steep" returns a flagged path; "disconnected" returns null.

**Non-goals**
- *Not* continental scale. No contraction hierarchies, no preprocessing tricks — those
  buy speed at city/continent scale the neighborhood graph doesn't need, and they'd hide
  the hand-rolled traversal that's the point.
- *Not* turn-by-turn / lane-level routing. Node-and-edge granularity only.
- *Not* multi-criteria Pareto routing. One scalar cost per edge.

═════════════════════════════════════════════════
4. THE DECISION
═════════════════════════════════════════════════

One `search()`. The algorithm is whatever `(costFn, heuristicFn)` you hand it. The four
named stages are thin wrappers that pick the pair.

```
  One engine, four presets — the parameter table IS the algorithm progression

                         costFn            heuristicFn        what you get
  ───────────────────────────────────────────────────────────────────────
  dijkstra        →   distanceCost        zeroHeuristic   uniform-cost search
  astar           →   distanceCost        haversine       shortest distance
  gradeAstar      →   gradeCostAbs        haversine       flattest, undirected
  directedAstar   →   gradeCostDirected   haversine       flattest, A→B ≠ B→A
                         │                    │
                         │                    └─ admissible lower bound (≥0 penalty
                         │                       keeps it a valid A* heuristic)
                         └─ the ONLY thing that changes between stages

  astar.ts:136-163 — each wrapper is a one-liner calling search(…)
```

The kernel — strip everything and this is still A* (`features/routing/astar.ts:48-77`):

```
  The A* kernel — what breaks if each part is removed

  open  = priority queue, ordered by g + h          ← remove: it's BFS/DFS, not A*
  g     = best known cost to each node               ← remove: can't relax edges
  closed= finalized nodes                            ← remove: re-expands, slow/loops
  came  = predecessor edge per node                  ← remove: no path to reconstruct

  loop:
    current = open.pop()                             // lowest g+h
    if closed.has(current): continue                 // ← LAZY DELETION: skip stale dupes
    if current == goal: reconstruct + return         // ← termination
    closed.add(current)
    for edge in adjacency[current]:                  // ← adjacency = the index (RFC 01)
      tentative = g[current] + costFn(edge, current, userMax)   // ← the ONLY parametric line
      if tentative < g[next]:
        g[next] = tentative
        came[next] = {edge, current}
        open.push(next, tentative + heuristicFn(next, goal))    // ← + admissible h
```

The single parametric line is `costFn(edge, current, userMax)` at `astar.ts:68`. Swap
the function passed in and the *same loop* becomes a different algorithm. The heap is a
generic lazy-deletion binary min-heap that knows nothing about graphs or grades
(`features/routing/pqueue.ts:1`) — it just orders by priority.

**Directionality — the part reviewers probe first.** The cost function receives `current`
(the node you're traversing *from*), and grade is signed by travel direction
(`features/routing/graph.ts:17`):

```ts
  // features/routing/graph.ts:17 — same edge, opposite sign depending on direction
  export function directedGrade(edge: Edge, fromNodeId: string): number {
    return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
  }

  // features/routing/cost.ts:32 — free downhill, penalized uphill
  export const gradeCostDirected: CostFn = (edge, fromNodeId, userMax) =>
    edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
```

```
  Why A→B ≠ B→A on the same physical edge

  edge: A ──(gradePct = +8%)──► B          stored ONE direction

  traverse A→B:  directedGrade = +8%  → penalty(+8) = quadratic, expensive (uphill)
  traverse B→A:  directedGrade = -8%  → penalty(-8) = 0           (downhill, free)
                                          cost.ts:16  if g <= 0 return 0

  the router climbs A→B reluctantly and descends B→A for free — asymmetry by design
```

**The finite BLOCKED — the surprising choice, and the most load-bearing constant.** An
edge steeper than `userMax` doesn't cost `Infinity`. It costs `1e9`
(`features/routing/cost.ts:5`):

```ts
  // features/routing/cost.ts:5
  export const BLOCKED = 1e9; // Large but FINITE, so an only-steep path is still returned and flagged.

  // cost.ts:16 — the penalty curve
  export function penalty(g, max, k1=0.4, k2=1.0) {
    if (g <= 0) return 0;              // downhill/flat: free
    if (g > max) return BLOCKED;       // over the user's comfort: huge but FINITE
    const half = 0.5 * max;
    if (g <= half) return k1 * g;      // moderate: linear
    return k2 * (g - half) ** 2 + k1 * half;  // steep: quadratic
  }
```

```
  Why finite, not Infinity — three outcomes the router must distinguish

  scenario              cost of best path        what the user sees
  ────────             ─────────────────        ──────────────────
  clean flat route     normal (no BLOCKED)       "Flat all the way"
  only-steep route     ~1e9 (BLOCKED in sum)     "⚠ Flattest available, N steep blocks"
  disconnected         null (open empties)       "No route between those points"

  if BLOCKED were Infinity:
    Infinity + anything = Infinity → every steep path ties → can't pick the FLATTEST
    steep one, and "only-steep" collapses into "no route". The middle row vanishes.
```

`1e9` is enormous next to real edge lengths (meters), so the router avoids steep edges
whenever any alternative exists — but because it's finite, *summing* it still produces an
orderable cost, so the router can return the least-steep path and flag exactly which edges
crossed the line. That flagging is `steepEdges` (`astar.ts:126`), surfaced to the user as
the steep-block count (`mobile/src/RouteSummaryCard.tsx:35`).

> Coach: the finite-BLOCKED point is your strongest signal in this whole doc. Anyone can
> say "I used A*." Saying "I made the blocked cost finite so flattest-but-steep stays
> distinct from no-route, because Infinity arithmetic destroys the ordering" tells the
> reviewer you *built* this, you didn't read about it. Bring it up unprompted.

═════════════════════════════════════════════════
5. ALTERNATIVES CONSIDERED
═════════════════════════════════════════════════

```
  ┌─ A. OSRM / Valhalla routing engine ─────────────────────────┐
  │  drop in a mature C++ router with contraction hierarchies    │
  │  WHY IT LOST: no native directional-grade cost — you'd fork  │
  │  it. Hides the traversal §14 says to build by hand. And it   │
  │  optimizes for fast, not flat — the whole differentiator.    │
  └──────────────────────────────────────────────────────────────┘
  ┌─ B. four separate algorithm implementations ────────────────┐
  │  hand-write dijkstra(), astar(), gradeAstar() as full,       │
  │  independent functions                                       │
  │  WHY IT LOST: four copies of the same loop = four places a   │
  │  bug hides. A heap fix has to land in all four. The bench-   │
  │  mark progression (§15.2) compares them — if they don't      │
  │  share a core, you're comparing implementation noise, not    │
  │  the cost/heuristic choice.                                  │
  └──────────────────────────────────────────────────────────────┘
  ┌─ C. one parametric search(costFn, heuristicFn) (CHOSEN) ─────┐
  │  WHY IT WON: one correct loop, four configs. The benchmark   │
  │  measures exactly the variable that changed (the cost/heur   │
  │  pair) against a fixed core. Directional grade is just a     │
  │  third costFn — no new engine. Heap is swappable underneath. │
  └──────────────────────────────────────────────────────────────┘
```

The deciding factor against four implementations is the **benchmark**. The progression
*is* the portfolio story (`docs/flattr-spec.md` §15.2) — and a benchmark only means
something if the only thing varying between runs is the thing you're studying. Share the
core; vary the parameters; the numbers attribute cleanly to the cost/heuristic choice.

═════════════════════════════════════════════════
6. TRADEOFFS ACCEPTED
═════════════════════════════════════════════════

We chose the one-parametric-engine, accepting:

- **No contraction hierarchies / no continental scale.** Plain A* with lazy deletion is
  fast at neighborhood scale and dead simple to reason about. It would not route across a
  country in milliseconds. That's a non-goal — flattr is one neighborhood — but it's a
  real ceiling, named.
- **`BLOCKED = 1e9` is a magic-ish constant.** It's tuned to dwarf real edge lengths
  (meters) while staying summable. If someone fed the router a graph with edges measured
  in millimeters and paths thousands of edges long, the BLOCKED gap could erode. For this
  data it's safe by orders of magnitude — but it's a calibrated number, not a law.
- **`gradeCostAbs` is symmetric on purpose, and that's a real difference.** The undirected
  stage (`cost.ts:28`) uses `absGradePct` — it treats up and down the same. It exists for
  the benchmark progression, not for production routing; the directional stage is the one
  the app uses. Shipping the wrong one would silently make downhill cost as much as uphill.

═════════════════════════════════════════════════
7. RISKS & MITIGATIONS
═════════════════════════════════════════════════

```
  Risk                              Mitigation
  ────                              ──────────
  inadmissible heuristic →          haversine is a true lower bound; penalty
    A* returns non-optimal path     ≥ 0 (cost.ts:16). Spec constraint §14.
  NaN priority corrupts the heap    PQueue.push throws on NaN (pqueue.ts:25)
  parallel edges between same nodes  reconstruct() walks the EXACT relaxed
    → wrong cost on reconstruct      edges, not re-resolved by node pair
                                     (astar.ts:86-103)
  BLOCKED summed enough to overflow  1e9 chosen with headroom; would need
    a meaningful cost                ~millions of blocked edges to matter
  swapped abs vs directed cost       directedAstar is the app's entry point;
                                     gradeCostAbs scoped to the benchmark
```

═════════════════════════════════════════════════
8. ROLLOUT / MIGRATION
═════════════════════════════════════════════════

- **The router is pure and data-source-agnostic.** `search()` takes a `Graph` object and
  returns a `SearchResult` — it doesn't know if the graph was bundled, tile-built, or a
  fixture. That's why RFC 01's artifact and RFC 03's degraded tiles both flow through the
  same function untouched.
- **Adding a new stage** is adding a `costFn` and a wrapper — bidirectional already does
  this, reusing `summarizePath` and `indexEdges` from `astar.ts`
  (`features/routing/bidirectional.ts:6`). No core change.
- **Swapping the heap** (the hand-rolled `PQueue`) for an npm library touches one file and
  nothing else — the heap knows nothing about routing (`pqueue.ts:1`). The hand-rolled
  version is a deliberate DSA-portfolio choice, not an architectural lock-in.

═════════════════════════════════════════════════
9. OPEN QUESTIONS
═════════════════════════════════════════════════

- **Does `BLOCKED` want to be relative instead of absolute?** A constant tuned to one
  graph's units is fragile. A BLOCKED expressed as a multiple of total graph length would
  be unit-independent. Worth it, or over-engineering for a single-neighborhood app?
- **Is bidirectional worth shipping, or is it benchmark-only?** It's implemented and
  measured but the app uses `directedAstar`. At neighborhood scale the speedup may not
  justify the added complexity at the meet-in-the-middle seam.
- **Should the penalty curve (`k1`, `k2`) be user-tunable?** Today `userMax` is the only
  knob. Some users may want "avoid steep at all costs" vs "mild preference" — that's the
  `k2` quadratic weight, currently fixed.

> Coach: when a reviewer pushes "why not just use OSRM," don't get defensive about
> reinventing wheels. The answer is one sentence: "OSRM optimizes for fast and has no
> directional grade cost — the two things flattr is *about*." You're not reinventing a
> router; you're building a router that does something theirs can't.

─────────────────────────────────────────────────
**See also**
- `study-dsa-foundations/05-graphs-and-traversals.md` — Dijkstra/A* foundations
- `study-dsa-foundations/03-stacks-queues-deques-and-heaps.md` — the binary heap behind PQueue
- `study-system-design/04-honest-fallback-routing.md` — flattest-but-steep as a graph problem
- RFC 01 — the graph artifact this router traverses
- RFC 03 — degraded (flat) tiles still route through this engine
- `docs/flattr-spec.md` §6 (algorithm), §14.2-14.4 (core + honest fallback), §15.2 (benchmark)
