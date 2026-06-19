# Complexity & cost models

**Industry names:** asymptotic analysis · Big-O / Big-Θ · amortized analysis ·
the cost model. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

Every other file in this guide makes a *speed* or *space* claim — "A\* expands
fewer nodes than Dijkstra," "the heap pops in `O(log n)`," "`percentile` sorts in
`O(n log n)`." This file is the ruler those claims are measured against. It sits
underneath all of them.

```
  Zoom out — where cost analysis lives

  ┌─ The claims every other file makes ───────────────────────────┐
  │  03 heap: push/pop O(log n)                                    │
  │  05 A*:   fewer nodes expanded than Dijkstra                   │
  │  06 sort: percentile() is O(n log n)                           │
  │  06 scan: nearestNode() is O(V)                                │
  └─────────────────────────┬──────────────────────────────────────┘
                            │ all measured against...
  ┌─ ★ THIS FILE ───────────▼──────────────────────────────────────┐
  │  the cost model: what counts as "one unit of work"?            │
  │  input size n · time vs space · worst vs amortized · constants  │
  └──────────────────────────────────────────────────────────────────┘
                            │ the repo's own measuring stick:
  ┌─ bench/run.ts ──────────▼──────────────────────────────────────┐
  │  nodesExpanded · pushes · pops · wall-clock ms                  │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a cost model is the answer to one question — *what do you count, and as
a function of what?* Pick the wrong unit and your analysis is fiction. `flattr`
is unusually disciplined here because it ships its own cost model: the
`SearchResult` type (`features/routing/types.ts:46-51`) counts `nodesExpanded`,
`pushes`, and `pops` — the engine *reports its own complexity* every time it runs.

---

## The structure pass

**Layers.** Three altitudes of "cost" stack up in this repo, and they get
confused with each other constantly:

```
  One question — "what does cost mean here?" — down the layers

  ┌──────────────────────────────────────────────┐
  │ outer: ROUTING cost (cost.ts)                  │  → a domain weight:
  │   path.cost = Σ length*(1+penalty)             │     "how much effort?"
  └────────────────────┬───────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ middle: ALGORITHMIC cost                  │  → operations:
       │   nodesExpanded, pushes, pops             │     "how much work?"
       └───────────────┬─────────────────────────┘
           ┌───────────▼───────────────────────┐
           │ inner: WALL-CLOCK cost (bench)      │  → time/space:
           │   ms, memory                        │     "how long / how big?"
           └─────────────────────────────────────┘

  the word "cost" means three different things — the lesson is keeping them apart
```

**Axis = cost.** Hold the question "what's expensive?" constant and the answer
flips at every layer. At the outer layer the expensive thing is *climbing a hill*
(`penalty()` inflates it). At the middle layer the expensive thing is *expanding a
node* (popping it and relaxing its neighbors). At the inner layer it's
*milliseconds*. A reviewer who conflates these — "A\* is faster because it has a
lower path cost" — has mixed two layers. Path cost is identical for Dijkstra and
A\* (`astar.test.ts:38-45`); only the *work* differs.

**Seams.** The load-bearing seam is between the middle and inner layers:
`nodesExpanded` is a *machine-independent* proxy for `ms`. That's why the bench
harness records it — `ms` varies with your laptop, `nodesExpanded` doesn't. The
seam is where a portable complexity claim becomes a wall-clock measurement.

---

## How it works

### Move 1 — the mental model

You already do this every time you reason about a `.map()` over an array: "this
is `O(n)` because it touches each element once." Big-O is just that habit made
formal — **strip the constants, keep the growth shape, express it as a function
of the input size.** The only hard part is naming *n* correctly.

```
  The shape of asymptotic growth (n = input size)

  cost
   ▲                                        O(n²)  ← double n → 4× cost
   │                                  ●
   │                            ●
   │                      ●                 O(n log n) ← sort
   │                ●                ○
   │           ●            ○                O(n)   ← linear scan
   │       ●         ○            ╌╌╌╌       O(log n) ← heap op, binary search
   │   ● ○      ╌╌╌╌╌╌╌╌╌╌╌                  O(1)   ← hash lookup
   └───────────────────────────────────────► n
       the curve you're on matters more than the constant in front
```

### Move 2 — the moving parts

**Naming the input size `n`.** This is the whole game and the most common
mistake. For a graph algorithm there is no single `n` — there's `V` (vertices)
and `E` (edges), and they grow differently. Dijkstra/A\* over a binary heap is
`O((V + E) log V)`: every vertex gets popped once (`V log V` for the pops), every
edge gets relaxed and may trigger a push (`E log V` for the pushes). Say "`O(n
log n)`" for a graph search and you've already lost — *which* n?

```
  Trace the cost of one node expansion (astar.ts:48-75)

  pop current ............... O(log V)   sift-down restores heap
  for each incident edge .... deg(current) iterations
     otherEnd, cost ......... O(1) each
     maybe push ............. O(log V)   sift-up

  total over the whole run: Σ deg = 2E relaxations, V pops
  = O(E log V + V log V) = O((V + E) log V)
```

**Worst case vs the case you actually hit.** Worst case for A\* is "no better
than Dijkstra" — when the heuristic gives no information, A\* expands every node.
That's not a bug; it's the corner case `bench/run.ts:17-21` deliberately avoids
by using *interior* pairs. Corner-to-corner, the goal is the farthest node, so
nothing can be pruned and A\* degenerates to the Dijkstra flood. Naming the worst
case *and* the case you designed for is the senior move.

**Amortized cost — why `push` is `O(log n)` "on average".** A single `push`
might sift all the way up (`O(log n)`); most pushes sift up one level or none.
Amortized analysis says: across a sequence of operations, the *average* cost per
op is what matters, even if one op is occasionally expensive. The PQueue's array
backing (`pqueue.ts:1`) is the classic example — a dynamic array's `push` is
`O(1)` amortized even though an occasional resize copies everything.

**Space cost is a separate axis — don't forget it.** A\* holds four structures
in memory simultaneously (`astar.ts:31-34`): `open` (the heap), `g` (best-known
cost per node), `came` (the came-from map), `closed` (the finalized set). That's
`O(V)` space — and on a city-sized graph that's the constraint that bites first,
which is exactly why the spec (§12) talks about *tiling* the graph rather than
loading all of Seattle.

### Move 3 — the principle

**Complexity analysis is choosing what to count.** The number falls out once
you've named the unit and the input size. `flattr`'s discipline — counting
`nodesExpanded` rather than trusting `ms` — is the lesson generalized: pick a
machine-independent unit, measure growth against the right `n`, and your claim
survives a change of laptop, language, or compiler.

---

## Primary diagram

The three cost layers and the single seam that makes complexity portable.

```
  flattr's three cost models and the portability seam

  ROUTING cost          ALGORITHMIC cost           WALL-CLOCK cost
  (domain weight)       (machine-independent)      (machine-dependent)
  ┌──────────────┐      ┌──────────────────┐       ┌──────────────┐
  │ Σ len*(1+pen)│      │ nodesExpanded     │  seam │ ms           │
  │ cost.ts:16   │      │ pushes / pops     │ ════► │ bench/run.ts │
  │              │      │ types.ts:46-51    │       │ :23-27       │
  └──────────────┘      └──────────────────┘       └──────────────┘
   "how much effort      "how much work"            "how long"
    to climb?"            O((V+E) log V)             varies by host
        │                                                 ▲
        └─── does NOT change between Dijkstra & A* ───────┘
             (only the middle layer does — that's the win)
```

---

## Implementation in codebase

**Use cases.** The repo reaches for cost analysis in three concrete places:
(1) the `SearchResult` metrics that every search returns, (2) the bench harness
that compares stages, and (3) the `BLOCKED = 1e9` constant, which is a
*numeric-precision* cost decision.

```
  features/routing/types.ts  (lines 46-51)

  export type SearchResult = {
    path: Path | null;
    nodesExpanded: number;  ← V-term proxy: nodes finalized (closed)
    pushes: number;         ← E-term proxy: heap insertions
    pops: number;           ← includes STALE pops (lazy-deletion overhead)
  };
       │
       └─ pops > pushes is impossible; pops can exceed nodesExpanded because
          stale duplicates are popped and skipped (astar.ts:51). The gap
          between pops and nodesExpanded IS the measured cost of choosing
          lazy deletion over decrease-key.
```

The `BLOCKED` constant is a cost-model decision hiding in plain sight:

```
  features/routing/cost.ts  (line 5)

  export const BLOCKED = 1e9;   ← large but FINITE
       │
       └─ why not Infinity? Because path.cost sums these (astar.ts:124).
          Σ of a few 1e9 stays a finite, comparable number, so the heap can
          still ORDER an all-steep path behind a clean one (pqueue.test.ts:101-106)
          instead of producing NaN/Infinity arithmetic. The cost model has to
          stay a total order — that's the constraint 1e9 satisfies and
          Infinity breaks (Infinity - Infinity = NaN, and push() rejects NaN,
          pqueue.ts:24).
```

---

## Elaborate

Big-O came from number theory (Bachmann, Landau, 1890s) and was imported into
algorithm analysis by Knuth in the 1960s precisely to make claims portable
across the wildly different machines of the era — the same reason `flattr` counts
`nodesExpanded` instead of trusting `ms`. Amortized analysis (Tarjan, 1985) is
the tool that justifies the dynamic-array and lazy-deletion-heap choices here:
both are "occasionally expensive, cheap on average." The natural next read is
**03** (where `O(log n)` heap ops are derived) and **05** (where `O((V+E) log
V)` is the search cost that everything else hangs on). For the wall-clock end of
the seam, go to `.aipe/study-performance-engineering/` — the bench harness is a
performance artifact built on this file's vocabulary.

---

## Interview defense

**Q: "Why does the benchmark count `nodesExpanded` instead of milliseconds?"**

Because `ms` is machine-dependent and `nodesExpanded` is the portable proxy for
the algorithmic cost. A\* and Dijkstra return the *same* path cost — the win is
purely fewer expansions, and that win survives a change of laptop. Milliseconds
would muddy the comparison with JIT warmup and host noise.

```
  Dijkstra ●●●●●●●●●●●●●●●●  expanded ~203  (floods)
  A*       ●●●●●            expanded  ~50   (cones to goal)
  same cost, different WORK — that's the only axis that matters here
  anchor: types.ts:46-51 reports it; bench/run.ts:51-53 tabulates it
```

**Q: "What's the time complexity of `search()` and what's `n`?"**

`O((V + E) log V)`. Not "`O(n log n)`" — a graph has two sizes. Every vertex is
popped once (`V log V`), every edge relaxed at most a constant number of times
(`E log V`). The `log V` factor is the heap. Anchor: `astar.ts:48-75`, the pop +
neighbor-relax loop.

---

## Validate

1. **Reconstruct:** State the time and space complexity of `search()` in
   `astar.ts:22-78` in terms of `V` and `E`, and name the data structure
   responsible for the `log V` factor.
2. **Explain:** Why can `pops` exceed `nodesExpanded` in a `SearchResult`
   (`types.ts:49`)? What design choice does that gap measure?
3. **Apply:** `bench/run.ts:17-21` uses interior pairs. Walk the worst case for
   A\* and explain why corner-to-corner triggers it.
4. **Defend:** Argue why `BLOCKED = 1e9` (`cost.ts:5`) rather than `Infinity`,
   in terms of keeping the cost model a total order the heap can sort.

---

## See also

- **03-stacks-queues-deques-and-heaps.md** — where `O(log n)` heap ops are derived.
- **05-graphs-and-traversals.md** — the `O((V+E) log V)` search this all measures.
- **06-sorting-searching-and-selection.md** — `O(n log n)` sort in `percentile`.
- `.aipe/study-performance-engineering/` — the wall-clock end of the seam.
