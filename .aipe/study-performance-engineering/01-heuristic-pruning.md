# Heuristic pruning — turning Dijkstra's flood into A*'s cone

**Industry name:** informed search / A* with an admissible heuristic.
**Type:** Industry standard.

---

## Zoom out, then zoom in

You already know Dijkstra finds the shortest path. The performance problem is
*how much of the graph it touches getting there* — it expands outward in all
directions like a flood, even directions pointing away from the goal. A* keeps
Dijkstra's optimality but adds one number per node — an estimate of how far the
goal still is — and that number bends the flood into a cone aimed at the goal.
Same answer, far fewer nodes touched.

Here's where this sits. It's the load-bearing optimization in the engine: one
function, one swapped argument.

```
  Zoom out — where heuristic pruning lives

  ┌─ bench/ (measurement) ───────────────────────────────────┐
  │  run.ts runs all stages → report.ts prints expanded/ms    │
  └───────────────────────────────┬───────────────────────────┘
                                   │  calls
  ┌─ features/routing/ (the engine) ▼─────────────────────────┐
  │  dijkstra() ─┐                                             │
  │  astar()    ─┼─► search(graph, s, g, max, costFn, ★heurFn★)│ ← here
  │  gradeAstar()┘        the ONE engine; stages = arguments   │
  │                       pqueue.ts (the open set)             │
  └───────────────────────────────┬───────────────────────────┘
                                   │  consumed by
  ┌─ mobile/src/MapScreen.tsx ─────▼──────────────────────────┐
  │  directedAstar(graph, startId, endId, userMax) in useMemo  │
  └────────────────────────────────────────────────────────────┘
```

The pattern: **A* = Dijkstra + an admissible heuristic.** "Admissible" means the
estimate never *overshoots* the true remaining cost. That single property is what
keeps the answer optimal while the cone gets narrow.

## Structure pass

Before the mechanics, read the skeleton along the **cost axis** — "how much work
(nodes expanded) does each layer do, and where does that number drop?"

**Layers** (one engine, three abstraction levels):

```
  One question down the layers: "how many nodes get expanded?"

  ┌──────────────────────────────────────────────┐
  │ stage wrapper: dijkstra() vs astar()          │  → SAME engine,
  └───────────────────────┬────────────────────────┘    different heurFn
                          │  the answer flips HERE
  ┌─ generic search() ────▼─────────────────────────┐
  │ priority = g(node) + heuristicFn(node, goal)     │  → zero heur:  flood
  └───────────────────────┬──────────────────────────┘    haversine:  cone
  ┌─ PQueue (open set) ───▼──────────────────────────┐
  │ pops the lowest-priority node next               │  → ordering decides
  └───────────────────────────────────────────────────┘    which nodes ever pop
```

**Axis = cost (nodes expanded).** Trace it down: the wrapper layer looks
identical between Dijkstra and A* — same `search()` call. The generic layer is
where the answer flips: `heuristicFn` is either `() => 0` (Dijkstra) or
`haversine(node, goal)` (A*). The queue layer just obeys the priorities it's
handed.

**The seam that matters:** the boundary between the stage wrapper and the generic
`search()` — specifically the `heuristicFn` argument. That's the load-bearing
seam, because the *cost axis flips across it*: above the seam the two stages are
indistinguishable; below it, one floods and one cones. Everything else (cost
function, lazy deletion, reconstruction) is shared and unchanged. The win is
purchased entirely at that one seam.

## How it works

### Move 1 — the mental model

You know how Dijkstra always pops the node with the smallest *distance so far*?
A* pops the node with the smallest *distance so far PLUS a guess of distance
still to go*. The guess is the whole trick. A node that's close to the start but
pointing the wrong way gets a big "still to go" guess, sinks in the queue, and
often never gets popped at all. That un-popped node is a node you didn't expand —
that's the saved work.

The shape — Dijkstra's flood vs A*'s cone toward the goal:

```
  Same start S, same goal G — what gets expanded

  Dijkstra (heuristic = 0)        A* (heuristic = straight-line to G)
  expands a disk around S         expands a cone aimed at G

      · · · · ·                          · ·
    · · · · · · ·                       · · ·
  · · · · S · · · ·                   · · S · ·
    · · · · · · ·  · ·                  · · · · ·
      · · · · ·  · · G                    · · · · G
                                           (sides pruned away)

  nodes touched: MANY              nodes touched: FEW   ← same path found
```

The priority every node is scored by:

```
  f(node) = g(node) + h(node)
            │          │
            │          └── h = heuristic estimate of node→goal (the guess)
            └── g = cost of the best known path start→node (the truth so far)

  Dijkstra: h ≡ 0   → f = g          → expand by distance-so-far → flood
  A*:       h = haversine(node, goal) → f = g + guess → expand toward goal → cone
```

### Move 2 — the step-by-step walkthrough

Walk the kernel one moving part at a time. This is the load-bearing skeleton:
strip any one of these and either optimality or termination breaks.

#### Part 1 — `g`: the truth so far

`g[node]` is the cheapest cost found *so far* to reach `node` from the start.
It starts at 0 for the start node and at ∞ for everyone else. You know this from
Dijkstra — it's the same map. When you find a cheaper way to a node, you lower its
`g`. **Drop it and you have no notion of "best path," so reconstruction is
meaningless.**

```
  Relaxation — the same move Dijkstra makes

  for each neighbor `next` of `current`:
      tentative = g[current] + edgeCost(current → next)
      if tentative < g[next]:        // found a cheaper route to next
          g[next] = tentative        // lower the truth
          came[next] = current       // remember how we got here
          push next with priority (tentative + h[next])
```

#### Part 2 — `h`: the guess (the admissible heuristic)

`h[node]` estimates the remaining cost from `node` to the goal. Here it's the
straight-line (haversine) distance. The one rule that makes A* still optimal:
**`h` must never overestimate the real remaining cost.** Straight-line distance
can't overestimate road distance — the road is never shorter than the crow flies.
That's why haversine is a safe choice.

```
  Admissibility — why the guess can't lie upward

  true remaining road cost:  ━━━━━━━━━━  (≥ straight line, always)
  haversine guess:           ──────────  (the straight line)

  guess ≤ truth  ⇒  A* never skips the optimal path
  guess > truth  ⇒  A* could return a WRONG (suboptimal) path
```

**Drop admissibility (let `h` overshoot) and A* gets faster but stops being
correct** — it can commit to a path that looked cheap by an inflated guess. The
repo guards this in its contract (`docs/flattr-spec.md` §14, "heuristic must stay
admissible; penalty ≥ 0").

#### Part 3 — `f = g + h`: the priority that bends the search

The open set is a min-priority queue ordered by `f`. This is the seam from the
structure pass made concrete: set `h ≡ 0` and `f = g`, so you're back to pure
Dijkstra. Set `h = haversine` and nodes pointing away from the goal carry a big
`h`, get a big `f`, and sink. **This is the entire pruning mechanism** — nothing
else changes between the two algorithms.

#### Part 4 — the closed set + lazy-deletion skip

When you pop a node, you finalize it (add to `closed`, increment
`nodesExpanded`). Because there's no decrease-key, the same node can sit in the
queue multiple times with different priorities; the first (best) pop wins, later
ones get skipped. **Drop the closed-set skip and you re-expand finalized nodes,
inflating the count and risking wasted work.** (The heap mechanics get their own
file — `03-lazy-deletion-heap.md`.)

#### Execution trace — watch the cone form

Three pops, watching how `h` reorders what comes next. Goal is to the east.

```
  Trace — A* expanding toward an eastern goal

  pop  node   g    h     f=g+h   action
  ───  ─────  ───  ────  ─────   ─────────────────────────────────
   1   S       0   100    100    expand; push E-neighbor f=98,
                                          push W-neighbor f=180
   2   E-nbr  20    78     98    expand (low f — toward goal)
                                          ← W-neighbor (f=180) still waiting
   3   E-nbr2 40    56     96    expand (toward goal)
                                          ← W-neighbor NEVER pops if G found first

  the westward node has a high h, sinks, and is never expanded → pruned
```

### Move 2.5 — current state: this is fully shipped

No future-state caveat. All five stages exist and run today
(`dijkstra`/`astar`/`gradeAstar`/`directedAstar` in `astar.ts:136-163`,
`bidirectional` in `bidirectional.ts`). The mobile app uses `directedAstar` in
production (`MapScreen.tsx:147`). The next rung beyond bidirectional —
Contraction Hierarchies / ALT — is a spec stretch goal, **not yet built** (see
`00-overview.md`).

### Move 3 — the principle

The general lesson beyond this repo: **an optimal algorithm and a fast one aren't
opposites — a good heuristic buys speed without giving up the answer, as long as
the heuristic never lies upward.** The discipline is to separate the *truth*
you've measured (`g`) from the *guess* about the future (`h`), and to constrain
the guess (admissibility) so it can only ever help. That's the same shape behind
branch-and-bound, alpha-beta pruning, and any "estimate the remaining cost to
prune the search" technique.

## Primary diagram

The whole mechanism in one frame — the engine, the swapped heuristic, and the
measured outcome.

```
  Heuristic pruning end to end

  ┌─ stage wrapper (features/routing/astar.ts) ────────────────────┐
  │  dijkstra(g,s,goal)            astar(g,s,goal)                  │
  │   └ heurFn = zeroHeuristic      └ heurFn = haversineHeuristic   │
  └───────────────────────┬─────────────────────────┬───────────────┘
                          │  (only this differs)     │
                          ▼                          ▼
  ┌─ generic search() ─────────────────────────────────────────────┐
  │  open = min-PQueue ordered by  f = g + heurFn(node, goal)        │
  │  loop: pop lowest f → skip if closed → expand → relax neighbors  │
  │  count: nodesExpanded, pushes, pops                             │
  └───────────────────────┬─────────────────────────────────────────┘
                          │  measured by bench/run.ts → report.ts
                          ▼
  ┌─ comparison table (MEASURED, grid40 mid-interior) ─────────────┐
  │  dijkstra   expanded 1079   cost 2400.00                        │
  │  astar      expanded  276   cost 2400.00   ← 3.9× fewer, SAME   │
  └─────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases in this repo.** Two:
1. **The benchmark** runs Dijkstra and A* over the same pairs to *prove* the win
   (`bench/run.ts:36-42`). This is the portfolio artifact.
2. **The mobile app routes for real** with `directedAstar` (grade-aware A*) on
   every render where endpoints are set (`MapScreen.tsx:143-154`). The heuristic
   pruning is what keeps that synchronous render-time search cheap.

**The seam — one engine, the heuristic swapped** (`features/routing/astar.ts`):

```
  features/routing/astar.ts  (lines 8-9, 136-143)

  export const zeroHeuristic: HeuristicFn = () => 0;                  ← Dijkstra's h
  export const haversineHeuristic: HeuristicFn =                      ← A*'s h
    (node, goal) => haversine(node, goal);
  ...
  export function dijkstra(graph, startId, goalId): SearchResult {
    return search(graph, startId, goalId, Infinity,
                  distanceCost, zeroHeuristic);                       ← h ≡ 0 → flood
  }
  export function astar(graph, startId, goalId): SearchResult {
    return search(graph, startId, goalId, Infinity,
                  distanceCost, haversineHeuristic);                  ← h = haversine → cone
       │
       └─ identical call EXCEPT the last arg. That arg is the entire
          difference between the flood and the cone. Strip the heuristic
          (pass zeroHeuristic) and you've thrown away the optimization —
          same answer, 3.9× more nodes expanded (measured).
  }
```

**The priority — where `f = g + h` is formed** (`features/routing/astar.ts`):

```
  features/routing/astar.ts  (lines 44-46, 64-74)

  g.set(startId, 0);                                       ← g of start = 0
  open.push(startId, heuristicFn(graph.nodes[startId], goal));  ← f = 0 + h
  ...
  for (const edgeId of graph.adjacency[current] ?? []) {
    const edge = byId.get(edgeId)!;
    const next = otherEnd(edge, current);
    if (closed.has(next)) continue;                        ← don't relax finalized nodes
    const tentative = g.get(current)! + costFn(edge, current, userMax);   ← new g[next]
    if (tentative < (g.get(next) ?? Infinity)) {           ← relaxation: cheaper?
      g.set(next, tentative);
      came.set(next, { edge, prev: current });
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  ← f = g + h
      pushes++;                                            ← instrumentation
    }
  }
       │
       └─ `tentative + heuristicFn(...)` IS f = g + h. The costFn is what
          makes it grade-aware (gradeCostDirected), the heuristicFn is what
          makes it A* instead of Dijkstra. Two orthogonal knobs, one loop.
```

**The expansion counter — what the bench reads** (`features/routing/astar.ts`):

```
  features/routing/astar.ts  (lines 48-62)

  while (!open.isEmpty()) {
    const current = open.pop()!;
    pops++;                                          ← every pop, incl. stale
    if (closed.has(current)) continue;               ← lazy-deletion skip (see 03)
    if (current === goalId) { ...return path... }    ← early exit on goal
    closed.add(current);
    nodesExpanded++;                                 ← THE metric the bench compares
       │
       └─ nodesExpanded counts FINALIZED nodes — the honest measure of search
          work, independent of machine speed. This is the number that drops
          1079 → 276 when you swap in the haversine heuristic. ms is noise on a
          graph this small; this counter is the real signal.
  }
```

## Elaborate

A* (Hart, Nilsson, Raphael, 1968) generalized Dijkstra by adding the heuristic
term; Dijkstra is literally A* with `h ≡ 0`, which is exactly how this repo
implements it — one `search()`, the heuristic swapped. The deeper idea is
**admissibility vs consistency**: admissibility (`h ≤ true remaining`) guarantees
optimality; *consistency* (the triangle inequality on `h`) additionally
guarantees you never need to re-open a closed node. Haversine on a metric graph is
consistent, which is why the closed-set skip here is safe. The bidirectional
variant (`bidirectional.ts:30-32`) needs a *balanced* potential (`pf`, `pr =
-pf`) precisely to keep both directions consistent so they can meet correctly —
that's the subtlety that makes bidirectional A* harder than it looks, and why the
bench shows it expanding slightly *more* than the single A* cone on a
near-Euclidean grid (noted honestly in `bench/run.ts:58-63`).

Read next: `02-instrumented-bench-harness.md` (how the win is measured),
`03-lazy-deletion-heap.md` (the open set), and the sibling
`.aipe/study-dsa-foundations/` for A* as pure DSA.

## Interview defense

**Q: "You said A* is faster than Dijkstra. Faster how — and does it find a worse
path?"**

The verdict: same path, fewer nodes expanded. A* is Dijkstra plus a heuristic
that estimates remaining cost; it's optimal *as long as the heuristic never
overestimates*. In my engine they're literally the same function — `search()` —
with the heuristic argument swapped from `() => 0` to `haversine`. Measured on a
40×40 grid, mid-interior pair: Dijkstra expands 1079 nodes, A* expands 276, and
**both return cost 2400.00**. The win is fewer expansions for the identical
answer.

```
  Dijkstra flood vs A* cone — same S, same G, same path

  Dijkstra: expand by g        A*: expand by g + h(→G)
     disk around S                cone aimed at G
   expanded: 1079               expanded: 276   (cost 2400 both)
```

Anchor: *the heuristic must never overshoot the true remaining cost — admissible
— or A* gets fast but wrong.*

**Q: "What's the most load-bearing part people forget?"**

Admissibility. Everyone remembers `f = g + h`; the part that's load-bearing and
forgotten is *the constraint on `h`*. If I'd used, say, Euclidean distance
*scaled up* to bias the search harder, it'd expand even fewer nodes — but it could
return a suboptimal route, because the inflated guess can make the search commit
early to a path that isn't actually shortest. Haversine is safe because the road
is never shorter than the straight line.

```
  guess ≤ truth → optimal (haversine)   |   guess > truth → fast but wrong
```

Anchor: *`g` is the truth you measured; `h` is a guess about the future — and the
guess is only allowed to help, never to lie upward.*

## Validate

Four levels, each anchored to real lines.

1. **Reconstruct.** From memory, write the priority a node is pushed with in
   `search()` and name which argument turns Dijkstra into A*. (Check against
   `astar.ts:72` and `astar.ts:137,142`.)
2. **Explain.** Why does `bench/run.ts:17-21` use interior pairs instead of
   corner-to-corner? What would happen to the A*-vs-Dijkstra expanded counts if
   the goal were the farthest corner? (Hint: the heuristic can't prune when the
   goal is the most distant node.)
3. **Apply.** The slider sets `userMax`, which feeds `directedAstar`
   (`MapScreen.tsx:147`). Does changing `userMax` change *which heuristic* runs?
   (No — `userMax` feeds the **cost** function, not the heuristic; trace
   `astar.ts:156-163`.) What *does* it change about the search?
4. **Defend.** Someone proposes multiplying the haversine heuristic by 1.5 to
   "make routing faster." Argue for or against, citing the admissibility
   contract in `docs/flattr-spec.md` §14 and the measured cost-equality in the
   bench (`00-overview.md`).

## See also

- `02-instrumented-bench-harness.md` — how `nodesExpanded` is counted and compared.
- `03-lazy-deletion-heap.md` — the open set that A* pops from.
- `04-render-thread-search-debounce.md` — where `directedAstar` runs in the app.
- `06-linear-nearest-node-scan.md` — the O(N) snap that finds the start/goal ids.
- `.aipe/study-dsa-foundations/` — A* and Dijkstra as reusable algorithms.
