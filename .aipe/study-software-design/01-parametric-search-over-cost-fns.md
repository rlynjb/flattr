# Parametric search over cost functions

> **Strategy pattern / dependency injection / higher-order function**
> — Industry standard. The deep module is APOSD-specific framing.

## Zoom out, then zoom in

You've got four algorithms to ship: Dijkstra, A\*, grade-aware A\*, and
directional grade A\*. The naive repo has four search functions, each ~60
lines, each re-implementing the frontier, the closed set, and the path
reconstruction. flattr has *one*. The four "algorithms" are just different
arguments handed to it.

Here's where that one function sits.

```
  Zoom out — where search() lives

  ┌─ UI layer (mobile) ─────────────────────────────────┐
  │  MapScreen.tsx  →  directedAstar(graph, a, b, max)   │
  └───────────────────────────┬──────────────────────────┘
                              │  (graph, start, goal, userMax)
  ┌─ Core: features/routing ──▼──────────────────────────┐
  │  ★ search(graph, start, goal, max, costFn, heur) ★    │ ← we are here
  │       uses: pqueue.ts · graph.ts · cost.ts           │
  └───────────────────────────┬──────────────────────────┘
                              │  costFn(edge, from, max) → number
  ┌─ cost.ts ─────────────────▼──────────────────────────┐
  │  distanceCost · gradeCostAbs · gradeCostDirected      │
  └───────────────────────────────────────────────────────┘
```

Zoom in: this is the **deepest module in the repo** — big behavior (four
optimal-pathfinding algorithms) behind a small interface (one function
signature). The trick is that the *algorithm* (Dijkstra vs A\* vs grade A\*)
isn't four implementations — it's two parameters: a cost function and a
heuristic. Change the arguments, change the algorithm. That's the strategy
pattern, and it's why `astar.ts` is 163 lines instead of 500.

## Structure pass

**Layers.** Three nested levels, all in `astar.ts`:
- *Generic*: `search()` — the frontier loop, agnostic to what it minimizes.
- *Configured*: the stage wrappers `dijkstra`/`astar`/`gradeAstar`/
  `directedAstar` — each binds one `(costFn, heuristic)` pair.
- *Domain*: the cost functions themselves live in `cost.ts` (pattern `02`).

**Axis — "who decides what counts as cheap?"** Trace it down:

```
  axis = "who decides edge cost?"

  ┌─ search() loop ────────────┐  doesn't decide — CALLS costFn
  └──────────┬──────────────────┘
             │  seam: CostFn type (types.ts:40)
  ┌─ stage wrapper ───────────┐  decides WHICH costFn to bind
  └──────────┬──────────────────┘
             │
  ┌─ cost.ts ─────────────────┐  decides the actual number
  └─────────────────────────────┘

  control of "what is cheap" flips at the CostFn seam
```

**Seam.** The load-bearing boundary is the `CostFn` type (`types.ts:40`):
`(edge, fromNodeId, userMax) => number`. Above it, the search loop knows
only "smaller is better." Below it, the whole grade domain. Control flips:
the loop *calls*, the cost fn *decides*. That's a real contract, and it's why
you can study the search loop without ever reading `cost.ts`.

## How it works

### Move 1 — the mental model

You already know this shape from React: a `<List>` component that takes a
`renderItem` prop. The list owns the iteration, the keys, the virtualization
— all the hard generic machinery — and delegates "what does one row look
like?" to a function you pass in. `search()` is the same move: it owns the
frontier, the closed set, the relaxation, the reconstruction — and delegates
"what does one edge cost?" to a function you pass in.

```
  the pattern — one engine, swappable cost

           ┌──────────────────────────────┐
  costFn ─►│         search()             │
  heur   ─►│  frontier · closed · relax   │─► Path
           │  reconstruct · summarize     │
           └──────────────────────────────┘
                       ▲
        same engine, four behaviors:
          (distanceCost, zero)        = Dijkstra
          (distanceCost, haversine)   = A*
          (gradeCostAbs, haversine)   = grade A*
          (gradeCostDirected, haversine) = directional A*
```

In one sentence: **the algorithm is data — a pair of functions — not code.**

### Move 2 — the step-by-step walkthrough

#### The generic engine never names a domain concept

This is the load-bearing part. Open `search()` and search it for the word
"grade." It isn't there. The loop talks about `g` (cost-so-far), `tentative`,
`closed`, `open` — pure pathfinding vocabulary.

```ts
// astar.ts:64-74 — the relaxation step, annotated
for (const edgeId of graph.adjacency[current] ?? []) {   // expand neighbors
  const edge = byId.get(edgeId)!;                         // O(1) via index
  const next = otherEnd(edge, current);                   // graph.ts — endpoint
  if (closed.has(next)) continue;                         // skip finalized
  const tentative = g.get(current)! + costFn(edge, current, userMax);
  //                                  └── the ONLY domain touchpoint ──┘
  if (tentative < (g.get(next) ?? Infinity)) {            // better path?
    g.set(next, tentative);
    came.set(next, { edge, prev: current });
    open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
  }
}
```

The whole grade domain enters through one expression: `costFn(edge, current,
userMax)`. Everything else is Dijkstra's relaxation. **What breaks if you
remove the indirection?** You'd inline grade math here, and now every
algorithm variant has to re-implement it — change amplification across four
functions instead of one.

#### The stage wrappers are partial application, not duplication

```ts
// astar.ts:136-163 — four "algorithms", each one line of real logic
export function dijkstra(g, start, goal) {
  return search(g, start, goal, Infinity, distanceCost, zeroHeuristic);
}
export function directedAstar(g, start, goal, userMax) {
  return search(g, start, goal, userMax, gradeCostDirected, haversineHeuristic);
}
```

Each wrapper binds a `(costFn, heuristic)` pair and names the result. The
name *is* the abstraction: "directional A\*" is precisely "search with the
directed-grade cost and the haversine heuristic." A reader who sees
`directedAstar` in `MapScreen.tsx` knows exactly what runs without reading
`search()`. **What breaks if you remove the wrappers?** Nothing structural —
but every call site would have to pass four functions correctly, and "which
heuristic pairs with which cost?" would leak up to the UI. The wrappers pull
that decision down (APOSD: pull complexity downward — see `audit.md` Lens 5).

#### Heuristic is the second injected strategy — and it must stay honest

The heuristic is the other parameter. `zeroHeuristic` (`astar.ts:8`) turns
A\* into Dijkstra (no guidance). `haversineHeuristic` (`astar.ts:9`)
estimates straight-line distance to the goal.

```
  layers-and-hops — what each injected function sees

  ┌─ search() ─────────────────────────────────────────────┐
  │  per edge:  cost  = costFn(edge, from, userMax)         │
  │  per node:  bound = heuristicFn(node, goal)             │
  │  priority = cost-so-far + bound                         │
  └───────┬───────────────────────────┬────────────────────┘
          │ hop: edge + from + max     │ hop: node + goal
          ▼                            ▼
   ┌─ cost.ts ──────┐          ┌─ lib/geo.ts ────┐
   │ returns ≥ 0    │          │ haversine ≤ true │
   └────────────────┘          │ remaining dist   │
                               └──────────────────┘
```

The contract on the heuristic is **admissibility**: it must never
*overestimate* remaining cost, or A\* can return a non-optimal path. Haversine
is a straight-line lower bound on graph distance — admissible by geometry.
The matching contract on the cost function is that the penalty is `≥ 0`
(`cost.ts` `penalty` returns 0 for downhill), so adding grade penalty only
*increases* cost and never breaks the haversine lower bound. **What breaks if
the heuristic overestimates?** A\* prunes a node it shouldn't and returns a
suboptimal route — silently. That's why `project context` lists "heuristic
must stay admissible" as a must-not-change constraint.

#### One reconstruction, shared by both search shapes

`summarizePath` (`astar.ts:110-131`) is itself injected with `costFn` — it
re-sums the exact traversed edges and flags `steepEdges`. Crucially, both
`search()` *and* `bidirectional()` call it (`bidirectional.ts:6`), so the
"turn a node list into a Path" logic exists once. **What breaks if removed?**
The two search algorithms would each grow their own summarizer and could
drift — one counting climb differently than the other.

### Move 3 — the principle

When variants of a thing differ only in a *decision*, make the decision a
parameter and write the thing once. The depth of a module is functionality
hidden per unit of interface; injecting the cost function lets `search()`
hide four algorithms behind one signature. The general lesson: **the
algorithm is often data.** Resist writing the fifth near-copy — find the
parameter that already separates the four.

## Primary diagram

The whole pattern in one frame: one engine, two injected strategies, four
named configurations, one shared summarizer.

```
  parametric search — the complete picture

  ┌─ UI ───────────────────────────────────────────────────────┐
  │  MapScreen → directedAstar(graph, start, goal, userMax)     │
  └───────────────────────────┬─────────────────────────────────┘
                              │ binds (gradeCostDirected, haversine)
  ┌─ Core: astar.ts ──────────▼─────────────────────────────────┐
  │  ┌─ stage wrappers ─────────────────────────────────────┐   │
  │  │ dijkstra · astar · gradeAstar · directedAstar        │   │
  │  └───────────────────┬───────────────────────────────────┘   │
  │  ┌─ search() ────────▼───────────────────────────────────┐   │
  │  │  PQueue frontier → pop → closed check → relax via      │   │
  │  │  costFn → push → goal? → reconstruct → summarizePath   │   │
  │  └────────┬───────────────────────────┬──────────────────┘   │
  └───────────┼───────────────────────────┼─────────────────────┘
        costFn│                      heur  │
   ┌─ cost.ts ▼──────┐          ┌─ lib/geo.ts ▼──┐
   │ ≥ 0 penalty     │          │ admissible LB  │
   └─────────────────┘          └────────────────┘
```

## Elaborate

This is the strategy pattern (GoF) and, equivalently, plain dependency
injection via higher-order functions. The deep-module framing is APOSD: the
value isn't the pattern name, it's that one small interface hides a lot of
behavior, so callers reason about routing without reasoning about the loop.

It connects directly to pattern `02` (the cost function as the domain seam —
*what* gets injected) and pattern `04` (the `PQueue` the engine uses — itself
a deep module that knows nothing of grades). The benchmark harness (`bench/`)
exploits this exact seam: it runs the same `search()` across all four
configurations to chart the algorithm progression, which only works *because*
the configurations are arguments.

To go deeper on deep modules and information hiding, read the matching
chapters in `read-aposd`. For the algorithm correctness (admissibility,
optimality), see `study-dsa-foundations/`.

## Interview defense

**Q: "Why one `search()` with parameters instead of four readable, explicit
functions? Isn't a dedicated `gradeAstar` clearer than threading a cost
function?"**

The clearest version is *both*, and that's what the code does: there's one
generic `search()` *and* four named wrappers (`astar.ts:136-163`). Callers
get the readable name `directedAstar`; the engine gets written once. If I
split into four full implementations, the frontier loop, closed set, and path
reconstruction would be copy-pasted four times — and a bug fix in
reconstruction (like the parallel-edge fix at `astar.ts:80-84`) would have to
land in four places or silently fix only one. The parameter *is* the
difference between the algorithms; making it a parameter makes the difference
explicit instead of buried in four near-identical bodies.

```
  four copies            vs        one engine + four configs
  ┌────────────┐                   ┌────────────┐
  │ dijkstra   │ ← bug             │  search()  │ ← fix once
  │ astar      │ ← bug fixed       └─────┬──────┘
  │ gradeAstar │ ← bug not fixed         │ 4 configs
  │ directed   │ ← bug not fixed    ┌────┴────┐
  └────────────┘                   wrappers (1 line each)
```

*Anchor: the algorithm is data — a `(costFn, heuristic)` pair — so write the
engine once and name the configurations.*

**Q: "What's the load-bearing invariant that makes this safe?"**

Admissibility of the heuristic *and* non-negativity of the cost penalty. The
heuristic must be a lower bound on remaining cost (haversine is, by
geometry), and the grade penalty must be `≥ 0` (`cost.ts` returns 0 for
downhill). Break either and A\* can return a suboptimal path with no error.
That's the part people forget — they remember "A\* needs a heuristic" but not
"and it must never overestimate, and the cost it guides over must stay
monotone."

*Anchor: A\* is only correct while the heuristic never overestimates and the
penalty never goes negative.*

## See also

- `02-penalty-as-the-domain-seam.md` — *what* gets injected as the cost.
- `04-lazy-deletion-priority-queue.md` — the frontier the engine pops from.
- `05-blocked-as-large-finite.md` — how the cost fn handles "too steep."
- `audit.md` Lens 2 (deepest module), Lens 5 (pull complexity down).
- `study-dsa-foundations/` — A\* optimality and admissibility proofs.
