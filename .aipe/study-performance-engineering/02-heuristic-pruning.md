# Heuristic Pruning — A* over Dijkstra, measured

**Industry name(s):** A* search / heuristic-guided best-first search /
informed search. **Type:** Industry standard (algorithm), measured here by a
project-specific bench.

## Zoom out, then zoom in

You've already built Dijkstra with a heap for the grid visualizer (`Graph2.ts` +
`PriorityQueue.ts` in reincodes). A* is that same machine with one extra term in
the priority. This file is about what that one term *buys you, measured* — and
how flattr is one of the few places in your portfolio where you actually put a
number on it.

```
  Zoom out — where pruning sits in flattr

  ┌─ UI (JS thread) ──────────────────────────────────────────┐
  │  MapScreen.tsx → directedAstar() in a useMemo             │
  └───────────────────────────┬───────────────────────────────┘
                              │ calls
  ┌─ Algorithm core ──────────▼───────────────────────────────┐
  │  features/routing/astar.ts                                │
  │    search(graph, start, goal, userMax, costFn, ★heuristicFn★) │ ← we are here
  │    PQueue (pqueue.ts) orders the frontier                 │
  └───────────────────────────┬───────────────────────────────┘
                              │ measured by
  ┌─ Bench (the instrument) ──▼───────────────────────────────┐
  │  bench/run.ts → counts nodesExpanded / pushes / pops      │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question this pattern answers is *"how do I reach the goal without
exploring the whole graph?"* Dijkstra explores outward in all directions like a
flood. A* points the flood at the goal. The `heuristicFn` is the only difference,
and flattr's `astar.ts` is written so that difference is **literally one
argument**.

## Structure pass

**Layers.** Three nested levels, one parametric engine at the center:

```
  search engine  →  cost model (costFn)  →  guidance (heuristicFn)
  (astar.ts)        distance vs grade       zero vs haversine
```

**Axis: cost — "how many nodes get expanded to answer one route?"** Hold that
question constant and trace it down the stages:

```
  One question, held constant across the stages
  "how many nodes expand for the SAME optimal cost?"

  ┌─ dijkstra:  zeroHeuristic ─────────────┐  → 1079 expanded  (floods)
  └─ astar:     haversineHeuristic ────────┘  → 276  expanded  (cone)
        (mid-interior grid40, MEASURED)        same cost: 2400
```

The answer changes by ~4x across one seam — the heuristic argument. That seam is
load-bearing: everything else (`costFn`, the heap, reconstruct) is identical
between the two stages.

**Seam.** The one boundary that matters is `heuristicFn` (`astar.ts:8-9, 22-29`).
Cross it from `zeroHeuristic` to `haversineHeuristic` and the cost-axis answer
flips from "flood" to "cone." Everything on either side is the same code path.

## How it works

### Move 1 — the mental model

A* is best-first search where the priority isn't "cost so far" (that's Dijkstra),
it's **cost so far + an optimistic guess of cost remaining**. The guess
(`heuristicFn`) is a lower bound — it can never over-promise, or the result stops
being optimal. With a good lower bound, nodes pointing *away* from the goal get a
worse priority and sink in the queue, so they're popped last or never. That's the
pruning.

```
  Dijkstra vs A* frontier — same start (S), same goal (G)

  DIJKSTRA: f = g            A*: f = g + h(node, goal)
  expands a CIRCLE           expands a CONE toward G

     . . . . .                     . . .
     . o o o .                       o o .
     . o S o .  →  G                 o S o  →  G
     . o o o .                       o o .
     . . . . .                     . . .
   (explores away from G)     (h penalizes away-from-G)
```

### Move 2 — the walkthrough

**The one engine, two stage wrappers.** flattr does not have a separate Dijkstra
function and a separate A* function. It has one `search` and the stages are
`(costFn, heuristicFn)` pairs. This is the design move that makes the bench an
apples-to-apples comparison — same code, one knob.

```ts
// features/routing/astar.ts:8-9, 135-143  — the seam is two constants
export const zeroHeuristic: HeuristicFn = () => 0;                          // Dijkstra's guess
export const haversineHeuristic: HeuristicFn = (node, goal) => haversine(node, goal); // A*'s guess

export function dijkstra(graph, startId, goalId) {
  return search(graph, startId, goalId, Infinity, distanceCost, zeroHeuristic);      // ← h = 0
}
export function astar(graph, startId, goalId) {
  return search(graph, startId, goalId, Infinity, distanceCost, haversineHeuristic); // ← h = haversine
}
```

`zeroHeuristic` returns 0 for every node — `g + 0 = g`, which *is* Dijkstra. Swap
in `haversineHeuristic` and the priority gains the straight-line distance to goal.
Nothing else moves. That's the whole pattern.

**The priority push — where the heuristic enters.** Inside `search`, the only line
that touches the heuristic is the push:

```ts
// features/routing/astar.ts:64-74  — relax edge, push with f = g + h
const tentative = g.get(current)! + costFn(edge, current, userMax);  // cost so far to `next`
if (tentative < (g.get(next) ?? Infinity)) {                          // found a cheaper path?
  g.set(next, tentative);                                             // record g(next)
  came.set(next, { edge, prev: current });                           // remember how we got here
  open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  // ← f = g + h, THE pruning
  pushes++;
}
```

The priority handed to the heap is `tentative + heuristicFn(...)`. For Dijkstra
that second term is 0, so the heap orders by pure cost-so-far. For A* it adds the
optimistic remaining distance, so a node 500 m the wrong way carries +500 in its
priority and sinks. Fewer of those nodes ever reach the top → fewer expansions.

**Admissibility — the load-bearing constraint people forget.** Haversine
(`lib/geo.ts`) is straight-line great-circle distance. The actual road is always
at least that long, so haversine never over-estimates — it's a valid lower bound,
which keeps A* optimal. The project's must-not-change constraints say this
explicitly: *"A* heuristic must stay admissible — haversine lower bound; penalty
≥ 0."* Break admissibility (e.g. multiply haversine by 1.5 to prune harder) and
A* gets faster but can return a **wrong** route. That's the trade you must never
make silently here.

**The measurement — the part most projects skip.** `bench/run.ts` runs both
stages over the same fixed pairs and counts expansions:

```ts
// bench/run.ts:44-55  — same pairs, every algorithm, count the work
for (const { algorithm, run } of algos) {
  const { result, ms } = time(run);          // performance.now() around the call
  rows.push({
    algorithm,
    nodesExpanded: result.nodesExpanded,     // ← the comparable number
    pushes: result.pushes,
    pops: result.pops,
    ms,
    cost: result.path ? result.path.cost : NaN,
  });
}
```

```
  Execution trace — bench/run.ts, mid-interior grid40 (MEASURED)

  pair: grid40 10,10 -> 30,20      same optimal cost = 2400

  step                     dijkstra    astar
  ──────────────────────   ────────    ─────
  nodes expanded              1079       276    ← 3.9x fewer
  pushes                      1141       341
  pops                        1080       277
  cost (must match)           2400      2400    ← identical answer ✓
```

Across all three pairs the ratio is **3.9x–7.4x** (grid30 near-interior:
203 → 32 = 6.3x; grid40 short: 74 → 10 = 7.4x). The cost column is identical in
every row — that's the proof A* didn't cheat. **Measurement over claims:** the
bench doesn't say "A* is faster," it says "A* expanded 276 vs 1079 for the same
2400-cost answer," and you can re-run it.

**Why interior pairs, not corners.** `bench/run.ts:15-16` deliberately routes
between interior nodes. Corner-to-corner makes the goal the single farthest node,
so Dijkstra has to expand essentially everything anyway and the heuristic cone
*is* the whole graph — A*'s win collapses to ~1x. Picking a workload where the
optimization can actually show is itself the measurement skill. A bench over the
degenerate case would "prove" A* doesn't help.

### Move 3 — the principle

A heuristic is a bet that you can guess your way past work. The bet only pays if
the guess is *admissible* (never over-promises) and *informative* (actually points
somewhere). And you only know it paid if you **counted the work both ways on a
representative input.** The generalizable lesson from flattr isn't "use A*" — it's
"instrument the thing you're optimizing and compare on a workload where the
difference can appear."

## Primary diagram

```
  Heuristic pruning, end to end — flattr

  ┌─ UI ──────────────────────────────────────────────────────┐
  │  MapScreen.tsx: directedAstar(graph, startId, endId, max)  │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ astar.ts: ONE search engine ─────────────────────────────┐
  │                                                            │
  │   open = PQueue<string>()                                  │
  │   push(start, h(start, goal))                              │
  │   while not empty:                                         │
  │     current = pop()        ── lazy-deletion skip if closed │
  │     if current == goal: reconstruct → DONE                 │
  │     for edge in adjacency[current]:                        │
  │       tentative = g[current] + costFn(edge)               │
  │       if tentative < g[next]:                              │
  │         push(next, tentative + ★h(next, goal)★)  ← PRUNING │
  │                                                            │
  │   h = zeroHeuristic   → Dijkstra (flood)   1079 expanded  │
  │   h = haversine       → A*       (cone)      276 expanded  │
  └───────────────────────────┬───────────────────────────────┘
                              │ counted by
  ┌─ bench/run.ts ────────────▼───────────────────────────────┐
  │  nodesExpanded / pushes / pops + ms, fixed interior pairs  │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

A* (Hart, Nilsson, Raphael, 1968) generalizes Dijkstra by adding the heuristic
term; Dijkstra is the special case `h = 0`. flattr's grade routing layers a
*cost* change on top (signed directed-grade penalty in `cost.ts`) — that's the
`gradeAstar`/`directedAstar` stages, which raise the *cost* (penalizing hills) but
keep the same haversine *guidance*. The bench shows those stages expand more than
plain A* (e.g. directedAstar 747 vs astar 276 on grid40) — expected, because the
grade penalty distorts the cost landscape so the straight-line heuristic is a
looser bound. That's a cost-model effect, not a search-speed regression.

Next: `03-lazy-deletion-heap.md` for the queue that orders this frontier, and why
`pops` can drift above `nodesExpanded`.

## Interview defense

**Q: Why is A* faster than Dijkstra here, and how do you know it's actually
faster and not just feels faster?**

> Same engine, one extra term: A* orders the frontier by `g + h` instead of `g`,
> where `h` is haversine straight-line distance to goal. That sinks
> away-from-goal nodes so they're popped last or never. I *know* it's faster
> because the bench counts `nodesExpanded` for both over the same fixed pairs:
> 276 vs 1079 on grid40, for the identical 2400 optimal cost. The matching cost
> column is the proof it didn't trade correctness for speed.

```
  f = g + h    h=0 → flood (1079)    h=haversine → cone (276)    cost both 2400
```

Anchor: *the heuristic is one argument; the win is measured, not asserted.*

**Q: What's the load-bearing constraint you can't violate?**

> Admissibility. Haversine must stay a lower bound on real road distance, and the
> grade penalty must be ≥ 0. If `h` over-estimates, A* prunes harder but can
> return a non-optimal route — fast and wrong. It's in flattr's must-not-change
> list for exactly that reason.

```
  h ≤ true remaining cost  → optimal ✓     h > true  → faster but WRONG ✗
```

Anchor: *an inadmissible heuristic is the classic "optimization" that silently
breaks correctness.*

## See also

- `03-lazy-deletion-heap.md` — the PQueue ordering this frontier.
- `04-linear-nearest-node.md` — snapping the tap to `startId`/`endId` before search.
- `08-render-thread-search-and-debounce.md` — this search runs on the JS thread.
- `audit.md` lens 2 (baselines) and lens 4 (CPU).
- Cross-guide: `study-dsa-foundations` (A* as a structure), `study-runtime-systems` (the thread it runs on).
