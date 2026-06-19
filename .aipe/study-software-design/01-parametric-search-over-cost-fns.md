# Parametric search over cost functions
### Strategy pattern / dependency injection over a graph search — Language-agnostic, applied here as the repo's deepest module

## Zoom out, then zoom in

Here's the whole engine as bands. The box we care about is the one search
function that every routing call goes through.

```
  Zoom out — where parametric search lives

  ┌─ UI layer (mobile/src) ──────────────────────────────────────┐
  │  MapScreen.tsx → directedAstar(graph, startId, endId, userMax)│
  └───────────────────────────┬──────────────────────────────────┘
                              │ one call
  ┌─ Engine layer (features/routing) ▼───────────────────────────┐
  │  dijkstra  astar  gradeAstar  directedAstar  ← 4 thin wrappers│
  │            ╲        │        ╱                                │
  │             ▼       ▼       ▼                                 │
  │        ★ search(graph, s, goal, max, costFn, heuristicFn) ★   │ ← we are here
  │             uses ▼          ▼ uses                            │
  │        cost.ts (penalty)   geo.ts (haversine)  pqueue.ts      │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** You know how a `fetch()` doesn't care what URL you hand it — same
machinery, different argument, different result? `search()` is that, for graph
algorithms. It's one traversal engine. Dijkstra, A*, grade-aware A*, and
directional A* aren't four implementations — they're four *arguments* to the
same function. The pattern is **Strategy injected as function parameters**:
pull the parts that vary (how to cost an edge, how to estimate remaining
distance) out as `(costFn, heuristicFn)` and the body stays identical. This is
the deepest module in flattr, and the reason the whole grade product is so
small.

## Structure pass

Before the mechanics, read the skeleton.

**Layers.** Two nested levels inside the engine: the **wrapper layer**
(`dijkstra`/`astar`/`gradeAstar`/`directedAstar`) and the **engine layer**
(`search`). The wrappers are policy ("use distance + no heuristic"); `search`
is mechanism ("relax edges, pop the cheapest frontier node").

**Axis — "who decides the cost of an edge?"** Hold that question constant and
move down the layers:

```
  One question, held constant down the layers

  "who decides what an edge costs?"  — trace downward

  ┌──────────────────────────────────────┐
  │ wrapper: directedAstar               │  → CHOOSES the policy
  │   (picks gradeCostDirected)          │     (which costFn)
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ engine: search()                 │  → DOESN'T KNOW; just calls
      │   tentative = g + costFn(edge…)  │     costFn(edge, from, max)
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ strategy: cost.ts penalty()  │  → ACTUALLY DECIDES the number
          └──────────────────────────────┘

  the answer flips at each altitude — that contrast IS the design
```

**Seam.** The load-bearing boundary is the `CostFn` type
(`features/routing/types.ts:40`): `(edge, fromNodeId, userMax) => number`. The
control axis flips across it — above the seam `search` owns traversal; below it
`cost.ts` owns the domain. A seam where an axis flips is load-bearing; this one
is the spine of the engine. The `HeuristicFn` seam (`types.ts:43`) is the
second one.

## How it works

### Move 1 — the mental model

The shape is a search that takes its two opinions as arguments. Picture the
frontier loop with two holes punched in it, and the holes are filled by
whatever functions you passed in.

```
  Pattern — one engine, two injected holes

        ┌─────────────────────────────────────────┐
        │  pop cheapest frontier node              │
        │  for each neighbor:                      │
        │      cost  = [ costFn ]  ← hole 1         │
        │      est   = [ heuristicFn ] ← hole 2     │
        │      priority = g + cost + est           │
        │      push neighbor with priority         │
        └─────────────────────────────────────────┘
              ▲                         ▲
        distanceCost?            zeroHeuristic?
        gradeCostDirected?       haversineHeuristic?
        (caller decides)         (caller decides)
```

Fill hole 1 with `distanceCost` and hole 2 with `zeroHeuristic` → that's
Dijkstra. Fill them with `gradeCostDirected` and `haversineHeuristic` → that's
the flat router. Same body.

### Move 2 — the walkthrough

**The frontier loop (the kernel).** Bridge from BFS, which you've built: BFS
pops from a FIFO queue; this pops from a *priority* queue ordered by
`g + heuristic`. You dequeue the cheapest-known node, finalize it, and relax
its edges.

```
  Execution trace — search on the flat-vs-steep fixture (gradeGraph)
  S--(steep, via H)--G   vs   S--(flat, longer, via L)--G

  step  pop   g[pop]   relax            frontier (node:priority)
  ────  ───   ──────   ──────────────   ─────────────────────────
   1     S      0      S→H costly,      H:~high, L:~low
                       S→L cheap
   2     L      g_L    L→G cheap        G(via L):low, H:high
   3     G      g_G    goal reached     → reconstruct S,L,G
```

The steep edge through H got a high cost from `penalty()`, so L's branch won —
the engine never had to know *why*, only that L's edges were cheaper.

**Injecting the strategy (the seam in action).** The body never branches on
"am I doing Dijkstra or grade-A*." It calls `costFn(edge, current, userMax)` and
trusts the number. Here's the relax step as pseudocode:

```
  for each edgeId in adjacency[current]:
      edge = index[edgeId]                 // O(1), not a scan
      next = otherEnd(edge, current)       // directed-traversal helper
      if next in closed: skip
      tentative = g[current] + costFn(edge, current, userMax)   // ← injected
      if tentative < g[next] (or unseen):
          g[next] = tentative
          came[next] = {edge, prev: current}
          push next with priority tentative + heuristicFn(next, goal)  // ← injected
```

The boundary condition that bites if you're careless: the heuristic must be
**admissible** (never overestimate). `haversine` is a straight-line lower bound
on real road distance, and `penalty ≥ 0` keeps grade cost ≥ distance, so the
estimate stays ≤ true cost. Break admissibility and A* returns wrong paths.

**Lazy deletion (the part people forget).** There's no decrease-key. When a
node's cost improves, the loop just pushes it *again* with the better priority.
Stale copies still sit in the heap. The guard `if (closed.has(current))
continue` (the first thing the loop does after a pop) throws away the stale
ones. Drop that guard and you re-expand finalized nodes — still correct, but
slow.

**The wrappers (policy on top of mechanism).** Each named algorithm is one
line: pick the `(costFn, heuristicFn)` pair, pass `Infinity` for `userMax` when
grade doesn't apply. That's it. Adding a fifth algorithm = adding a fifth
wrapper, zero changes to `search`.

### Move 3 — the principle

When several "different" things share a body and differ only in one or two
decisions, the deep move is to **make those decisions parameters, not
branches.** You don't get four algorithms by writing four functions; you get
them by writing one function and four argument lists. The interface shrinks
while the capability grows — that's depth.

## Primary diagram

The full picture: four wrappers feeding one engine, two injected strategies,
two helpers.

```
  Parametric search — the whole module (features/routing)

  ┌─ wrappers (policy) ───────────────────────────────────────────┐
  │ dijkstra         astar          gradeAstar      directedAstar  │
  │ (dist,zero)      (dist,haver)   (gradeAbs,haver)(gradeDir,haver)│
  └───────┬──────────────┬───────────────┬──────────────┬──────────┘
          └──────────────┴───────┬───────┴──────────────┘
                                 ▼
  ┌─ engine (mechanism) ─ search(graph, s, goal, max, costFn, heuristicFn) ─┐
  │  PQueue<string> open   g:Map   came:Map   closed:Set   index:Map        │
  │  loop: pop → if closed skip → if goal reconstruct →                     │
  │        relax edges via costFn → push via +heuristicFn                   │
  └───────┬───────────────────────────────────────────┬────────────────────┘
          │ calls                                       │ calls
  ┌───────▼─────────┐                          ┌───────▼──────────┐
  │ cost.ts         │                          │ geo.ts haversine │
  │ penalty()/Cost  │                          │ + zeroHeuristic  │
  └─────────────────┘                          └──────────────────┘
```

## Implementation in codebase

**Use cases.** Every route in the app is `directedAstar` (`MapScreen.tsx:147`).
The benchmark harness (`bench/`) runs all four wrappers over the same fixtures
to chart "nodes expanded per algorithm" — the whole Dijkstra→A*→grade→
directional progression is *measurable* precisely because they're one function
with swapped strategies. Tests inject hand-built `CostFn`s against `fixtures.ts`
graphs.

**The engine — `features/routing/astar.ts:22–78`.**

```
  astar.ts  (lines 22–78, condensed)

  export function search(graph, startId, goalId, userMax,
                         costFn, heuristicFn): SearchResult {
    const open = new PQueue<string>();           ← frontier, ordered by f
    const g = new Map<string, number>();          ← best-known cost to each node
    const came = new Map();                        ← back-pointers for reconstruct
    const closed = new Set<string>();              ← finalized nodes
    const byId = indexEdges(graph);                ← O(1) edge lookup (line 34)
    ...
    open.push(startId, heuristicFn(start, goal));  ← f(start) = 0 + h
    while (!open.isEmpty()) {
      const current = open.pop()!;
      if (closed.has(current)) continue;           ← lazy-deletion guard (line 51)
      if (current === goalId) { ...reconstruct... } ← line 52, early exit
      closed.add(current);
      for (const edgeId of graph.adjacency[current] ?? []) {
        const edge = byId.get(edgeId)!;
        const next = otherEnd(edge, current);       ← directed helper (line 65)
        if (closed.has(next)) continue;
        const tentative = g.get(current)! + costFn(edge, current, userMax);  ← INJECTED (68)
        if (tentative < (g.get(next) ?? Infinity)) {  ← relax
          g.set(next, tentative);
          came.set(next, { edge, prev: current });
          open.push(next, tentative + heuristicFn(graph.nodes[next], goal)); ← INJECTED (72)
        }
      }
    }
    return { path: null, ... };                     ← disconnected → null
  }
       │
       └─ lines 68 and 72 are the only places strategy enters. Everything
          else is fixed mechanism. That's why one body is four algorithms.
```

**The wrappers — `features/routing/astar.ts:136–163`.**

```
  astar.ts  (lines 136–163)

  export function dijkstra(g, s, goal) {
    return search(g, s, goal, Infinity, distanceCost, zeroHeuristic);
  }                                          ← distance, no heuristic
  export function astar(g, s, goal) {
    return search(g, s, goal, Infinity, distanceCost, haversineHeuristic);
  }                                          ← distance + admissible h
  export function directedAstar(g, s, goal, userMax) {
    return search(g, s, goal, userMax, gradeCostDirected, haversineHeuristic);
  }                                          ← the flat router the app ships
       │
       └─ each wrapper is the *entire* difference between the algorithms.
          Strip them and the engine is unchanged; you'd just call search()
          with the args inline.
```

The `CostFn`/`HeuristicFn` types (`types.ts:40,43`) are the seam declarations —
the contract that lets `search` not care which strategy it got.

## Elaborate

This is the **Strategy pattern**, but expressed the functional way: instead of
a `CostStrategy` interface with subclasses, flattr passes plain functions
typed as `CostFn`. In a class-heavy language you'd inject an object; in
TypeScript a function value is lighter and just as substitutable — and it
dodges the "classitis" red flag (audit Lens 2). The same idea is dependency
injection: the dependency (how to cost an edge) is handed in, not hard-wired.

Where to read next: `02-penalty-as-the-domain-seam.md` walks what lives *behind*
the `CostFn` hole; `04-lazy-deletion-priority-queue.md` walks the `PQueue` the
loop pops from; `03-directed-traversal-over-undirected-storage.md` walks
`otherEnd`/`directedGrade`. For the algorithm itself as a reusable primitive,
see `.aipe/study-dsa-foundations/`.

## Interview defense

**Q: Why one `search` instead of four functions? Isn't that over-abstracted?**
The four algorithms share 95% of their body — the frontier loop, relax, closed
set, reconstruct. Writing them separately means four copies of the lazy-deletion
bug-prone part. One function with `(costFn, heuristicFn)` parameters means the
tricky mechanism exists once and is tested once. The four wrappers
(`astar.ts:136–163`) make the policy explicit and named. Abstraction that
*removes duplicated mechanism* is the good kind.

```
  4 functions (shallow, duplicated)   vs   1 + 4 wrappers (deep)
  ┌────────┬────────┬────────┐             ┌──────────────────┐
  │ loop   │ loop   │ loop   │  ← bug ×3    │   loop (once)     │ ← bug ×1
  │ relax  │ relax  │ relax  │             └────────┬─────────┘
  └────────┴────────┴────────┘                 4 one-line wrappers
```

**Q: What's the load-bearing part people forget?** The `if (closed.has(current))
continue` guard right after the pop (`astar.ts:51`). Without it, the
no-decrease-key design re-expands every node that was ever improved. The path
is still correct; the search just does redundant work. Naming that guard
signals you understand *why* lazy deletion works, not just that the heap pops in
order.

**Anchor:** "One engine, two injected holes — `costFn` and `heuristicFn`. The
four named algorithms are argument lists, not implementations."

## Validate

1. **Reconstruct:** from memory, write the `search` frontier loop in pseudocode
   — pop, lazy-deletion guard, goal check, relax via `costFn`, push via
   `+heuristicFn`. Check against `astar.ts:48–76`.
2. **Explain:** why does `gradeAstar` pass a real `userMax` but `astar` passes
   `Infinity`? (`astar.ts:142` vs `152`.)
3. **Apply:** you want a "prefer well-lit streets" router. What do you change?
   (Answer: write one new `CostFn` reading an edge property, add one wrapper;
   `search` is untouched.)
4. **Defend:** a teammate wants to inline the wrappers and branch inside
   `search` on an `algorithm: string` argument. Why is that worse? (It puts
   policy back inside mechanism, re-grows the interface, and adds a branch the
   hot loop runs every edge.)

## See also

- `02-penalty-as-the-domain-seam.md` — what fills the `costFn` hole.
- `04-lazy-deletion-priority-queue.md` — the frontier the loop pops from.
- `03-directed-traversal-over-undirected-storage.md` — `otherEnd` inside relax.
- `05-blocked-as-large-finite.md` — why a costFn returns a number, never throws.
- `audit.md` Lens 2 (deep modules), Lens 8 (red flags).
- `.aipe/study-dsa-foundations/` — A* as a reusable algorithm.
