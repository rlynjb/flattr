# Heuristic pruning — A* over Dijkstra

> Industry name: **A\* search / admissible-heuristic guided search**. Type:
> Industry standard.

This is the one optimization in flattr that's actually *measured*. Everything
else in this guide is reasoned about; this one has a benchmark behind it.

## Zoom out — where this concept lives

The search engine is the centerpiece of the whole project. A* sits in the core
engine layer, called from both the bench (which measures it) and the mobile app
(which renders its output).

```
  Zoom out — A* in the flattr stack

  ┌─ Bench layer (Node) ──────────────────────────────────────┐
  │  bench/run.ts → counts expanded/pushes/pops, times ms     │ ← measures it here
  └─────────────────────────────┬──────────────────────────────┘
                                │ calls
  ┌─ Core engine (features/routing) ─▼────────────────────────┐
  │  ★ search() in astar.ts — ONE engine, (cost,heuristic)    │ ← we are here
  │     dijkstra = zeroHeuristic · astar = haversineHeuristic │
  │  uses PQueue (pqueue.ts), cost.ts, graph.ts               │
  └─────────────────────────────┬──────────────────────────────┘
                                │ also called by
  ┌─ Mobile (MapScreen.tsx) ────▼─────────────────────────────┐
  │  directedAstar(graph, startId, endId, userMax) in useMemo │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: A* is Dijkstra plus a *hint*. Dijkstra floods outward in all directions
until it hits the goal. A* adds an admissible heuristic — a never-overestimating
guess of remaining distance — that bends the flood toward the goal, so it expands
a cone instead of a disk. The question this file answers: **how much does that
hint actually save, on this graph?** And the answer is measured, not asserted.

## Structure pass — the skeleton

One engine, two layers of abstraction. **Axis traced: how many nodes get
expanded?** That's the cost metric, and it changes dramatically depending on one
seam — whether the heuristic is `0` or haversine.

```
  One axis — "how many nodes expand?" — across the heuristic seam

  ┌─ generic search() ────────────────────────────────────────┐
  │  pop lowest-priority · skip if closed · relax neighbors    │
  │  priority = g + h(node, goal)        ← h is the only knob  │
  └──────────────────────────┬─────────────────────────────────┘
                  seam: what is h?
        ┌─────────────────────┴─────────────────────┐
   h = 0 (zeroHeuristic)              h = haversine (admissible)
   priority = g only                 priority = g + straight-line-to-goal
   floods a DISK                     bends to a CONE
   → 1079 expansions                 → 276 expansions   (measured, grid40 mid)
```

The seam is `heuristicFn`. Same `search()` body, same heap, same cost function —
the *only* thing that flips between Dijkstra and A* is whether `h` returns 0 or a
real lower bound (`astar.ts:8-9`). And that single flip is what the bench
measures. The mechanics below hang on that one joint.

## How it works

### Move 1 — the mental model

You've built Dijkstra before (`Graph2.ts`, the `updatePriority` PriorityQueue
animation). A* is the same priority-queue loop you already know — pop the
cheapest frontier node, relax its neighbors, repeat — with one change to the
priority key. Dijkstra orders the frontier by `g` (cost so far). A* orders it by
`g + h` (cost so far + optimistic guess of cost remaining). That `+ h` is the
whole trick.

```
  The pattern — priority = g + h bends the frontier

       Dijkstra (h=0)              A* (h=haversine)
       floods a disk               floods a cone toward goal

         . . . . .                       . .
       . . . S . . .                   . S .
       . . .(o). . .  ← all dirs      . (o). .  ← biased
       . . . . . . .                     .(o).
       . . . G . . .                       . G   ← reaches G
                                              expanding far fewer (o)
```

The kernel that makes it A* and not just "Dijkstra with extra math": the
heuristic must be **admissible** — never overestimate the true remaining cost.
Haversine (great-circle straight-line distance) is admissible for a distance
metric because the real path can't be shorter than a straight line. Break
admissibility (overestimate) and A* stops returning the optimal path — it'll
return *a* path, just not the shortest. That's the load-bearing constraint, and
the repo enforces it as a hard rule (`.aipe/project/context.md`: "A* heuristic
must stay admissible — haversine lower bound").

### Move 2 — the walkthrough

**The one engine.** flattr doesn't have a Dijkstra function and an A* function.
It has one `search()` and the stage wrappers pick `(costFn, heuristicFn)`. Here's
the seam, side by side:

```ts
// features/routing/astar.ts:8-9 — the two heuristics
export const zeroHeuristic: HeuristicFn = () => 0;
export const haversineHeuristic: HeuristicFn = (node, goal) => haversine(node, goal);

// features/routing/astar.ts:136-143 — the stage wrappers differ ONLY in heuristic
export function dijkstra(graph, startId, goalId) {
  return search(graph, startId, goalId, Infinity, distanceCost, zeroHeuristic);   // h=0
}
export function astar(graph, startId, goalId) {
  return search(graph, startId, goalId, Infinity, distanceCost, haversineHeuristic); // h=haversine
}
```

`dijkstra` passes `zeroHeuristic`, `astar` passes `haversineHeuristic`. Identical
cost (`distanceCost`), identical everything else. The bench isolates one variable.

**The priority key.** Inside the loop, the heuristic is added exactly once, when a
neighbor is pushed:

```ts
// features/routing/astar.ts:64-74 — relax neighbors
for (const edgeId of graph.adjacency[current] ?? []) {
  const edge = byId.get(edgeId)!;
  const next = otherEnd(edge, current);
  if (closed.has(next)) continue;
  const tentative = g.get(current)! + costFn(edge, current, userMax);  // g: cost so far
  if (tentative < (g.get(next) ?? Infinity)) {
    g.set(next, tentative);
    came.set(next, { edge, prev: current });
    open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  // priority = g + h
    pushes++;
  }
}
```

Line 72 is the whole difference. `tentative` is `g` (real cost so far through this
edge). `heuristicFn(...)` is `h` (optimistic remaining). When `h` is 0 (Dijkstra),
the heap is ordered by `g` alone — pure uniform-cost flood. When `h` is haversine,
nodes closer to the goal jump ahead in the heap, so the goal-ward frontier gets
popped first and the away-from-goal frontier mostly never gets expanded.

**The measurement.** The counters live in the search itself — `pushes`,
`pops`, `nodesExpanded` increment as the loop runs (`astar.ts:36-37,46,51,58,73`)
and ride out on the `SearchResult`. `bench/run.ts:44-56` reads them straight off:

```ts
// bench/run.ts:45-55 — run each stage, record the counters
const { result, ms } = time(run);   // time() wraps performance.now() (bench/run.ts:23-27)
rows.push({
  algorithm,
  nodesExpanded: result.nodesExpanded,   // counted inside search()
  pushes: result.pushes,
  pops: result.pops,
  ms,
  cost: result.path ? result.path.cost : NaN,
});
```

**The numbers (real, `npm run bench`, this machine).** Three fixed interior pairs.
Interior on purpose — corner-to-corner is degenerate (the goal is the farthest
node, so nothing can be pruned and Dijkstra expands the whole graph; comment at
`bench/run.ts:16-17`).

```
  Measured expansions — A* prunes, same optimal cost

  pair                          dijkstra   astar   ratio (expanded)
  grid30 12,12->17,17 (near)        203      32     6.3x
  grid40 10,10->30,20 (mid)        1079     276     3.9x
  grid40 18,18->21,21 (short)        74      10     7.4x

  cost column is IDENTICAL across dijkstra/astar/bidirectional
  (800 / 2400 / 480) — same answer, fewer expansions. That's the proof
  the heuristic is admissible: pruning didn't change the optimum.
```

The ratio swings 3.9x–7.4x with the geometry of the pair. The mid pair
(10,10→30,20) is the widest, most off-axis, so A*'s cone is fattest there and the
ratio is *smallest* — pruning helps least when the goal is far and diagonal. The
short pair (18,18→21,21) is the tightest, so the cone is thinnest and the ratio is
*largest*. That variation is itself a finding: **A*'s win depends on the
query geometry, and the bench captures the range instead of one cherry-picked
number.**

The wall-ms (1.45ms Dijkstra → 0.33ms A* on the mid pair) is real but it's
Node-on-laptop. Don't read it as device latency — see `audit.md` R1.

### Move 2.5 — current state vs the unmeasured device path

```
  Phase A: MEASURED               Phase B: NOT MEASURED
  ─────────────────               ─────────────────────
  bench/run.ts, Node              MapScreen.tsx:151-162
  fixed grid graphs               real merged graph, on a phone
  expanded/pushes/pops + ms       NO timer around directedAstar
  3.9–7.4x proven                 latency on device = [inference]
```

The same `search()` runs in both places. The bench proves the *algorithmic* win.
What's gated is whether that win translates to a fast-feeling route on a mid-range
Android — because the mobile call (`directedAstar` in a `useMemo`,
`MapScreen.tsx:155`) has no timer around it. The fix is one line: wrap it in
`performance.now()` and log. Nothing about the algorithm has to change.

### Move 3 — the principle

A heuristic is a bet that you can guess your way past work. The bet only pays if
the guess never lies in the optimistic direction (admissibility) — and the only
way to know how much it paid is to count the work with and without it. flattr does
the second part right: the metric (`nodesExpanded`) is produced by the thing being
measured, isolated to one variable (the heuristic), over representative inputs.
That's what makes "A* is faster" a measurement here instead of a slogan.

## Primary diagram

```
  Heuristic pruning, end to end

  ┌─ bench/run.ts ────────────────────────────────────────────┐
  │  for each fixed pair × each stage:                        │
  │    time(() => stage(g, start, goal))                      │
  │    record result.{nodesExpanded,pushes,pops}, ms          │
  └───────────────────────────┬────────────────────────────────┘
                              │ both stages call ↓
  ┌─ features/routing/astar.ts : search() ─────────────────────┐
  │  open = PQueue                                            │
  │  loop: current = open.pop()                               │
  │        if closed: skip (lazy deletion)                    │
  │        if current == goal: reconstruct, return + counters │
  │        relax neighbors:                                   │
  │          push(next, g + h(next, goal))  ← h is the seam   │
  │                                                            │
  │  dijkstra → h = 0           → 1079 expanded (mid)         │
  │  astar    → h = haversine   →  276 expanded (mid) = 3.9x  │
  │  SAME cost 2400 → admissible, optimum preserved           │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

A* (Hart, Nilsson, Raphael, 1968) generalizes Dijkstra: Dijkstra *is* A* with
`h=0`. The whole family lives on the admissibility/consistency spectrum — a
*consistent* heuristic (stronger than admissible) guarantees each node is expanded
at most once and lets you drop the lazy-deletion guard. flattr's haversine is
consistent on a distance metric, which is why `bidirectional.ts:29-32` can use a
balanced consistent potential. The grade-aware stages (`gradeAstar`,
`directedAstar`) keep the *same* haversine heuristic even though the cost is now
distance-times-grade-penalty — the heuristic stays a lower bound because the grade
penalty multiplier is `≥ 0` (`cost.ts:16-22`, `penalty ≥ 0`), so straight-line
distance still can't overestimate. That's why `directedAstar` expands more than
plain `astar` (120 vs 32 on grid30) but still prunes hard vs an `h=0` flood. Read
next: `02-single-flight-pump.md` for how this search is fed on mobile.

## Interview defense

**Q: Your bench shows A* expanding 3.9x fewer nodes on one pair and 7.4x on
another. Why isn't it a constant?**

A* prunes a cone toward the goal; the cone's width depends on query geometry. A
wide, diagonal, far-apart pair (grid40 10,10→30,20) makes the cone fat, so pruning
helps least — 3.9x. A tight, short pair (grid40 18,18→21,21) makes the cone thin —
7.4x. I benched a range of interior pairs *specifically* so the number isn't a
cherry-pick; the range is the honest answer.

```
  far/diagonal pair → fat cone → 3.9x
  short/tight pair  → thin cone → 7.4x   (same engine, different geometry)
```

Anchor: *"the heuristic's payoff is query-dependent, and the bench captures the
range, not one number."*

**Q: How do you know A* didn't break correctness while pruning?**

The cost column in the bench is identical across dijkstra/astar/bidirectional —
800, 2400, 480 on the three pairs. Same optimal cost, fewer expansions. That's the
operational proof the heuristic is admissible: if haversine ever overestimated,
A* would return a cheaper-looking but suboptimal path and the cost would *drop*
below Dijkstra's. It doesn't.

Anchor: *"identical cost, fewer expansions — that's admissibility, measured."*

**Q: What's the load-bearing part people forget?**

Admissibility. Everyone remembers `priority = g + h`; the part that breaks if you
forget it is that `h` must never overestimate. Overestimate and you still get a
path, just not the shortest — and the bug is silent because it still *looks* like a
route. flattr pins it as a must-not-change constraint and keeps `penalty ≥ 0` so
the grade-aware cost can't sneak an overestimate in.

Anchor: *"h must under-promise; an overestimating A* returns a path that lies."*

## See also

- `02-single-flight-pump.md` — how the search is fed on mobile without starving.
- `03-linear-nearest-node-scan.md` — the O(N) snap that picks A*'s start/goal.
- `audit.md` lens 2 (baselines), R1 (no device timing), R2 (A* on JS thread).
- `00-overview.md` — the ranked findings.
