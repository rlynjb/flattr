# Complexity & Cost Models

**Industry names:** asymptotic analysis / Big-O · amortized analysis · cost
function design. **Type:** Industry standard.

## Zoom out, then zoom in

Every primitive in flattr's router gets chosen because of a cost class. The
heap is a heap and not a sorted array because `O(log n)` push beats `O(n)`
insert. The `byId` index exists because the alternative is `O(E)` per
expansion. And the routing *cost* — the number `search()` minimizes — is its
own designed function, separate from the *complexity* of computing it. This
file is about both meanings of "cost": how expensive an operation is to run,
and what number the algorithm is trying to make small.

```
  Zoom out — "cost" lives at two layers in flattr

  ┌─ Algorithm layer ─────────────────────────────────────────┐
  │  search()  minimizes  Σ costFn(edge)   ← COST AS OBJECTIVE │ ★ here
  │     each loop iteration is O(log n)     ← COST AS RUNTIME  │ ★ here
  └────────────────────────────┬──────────────────────────────┘
                               │ calls
  ┌─ Structure layer ──────────▼──────────────────────────────┐
  │  PQueue.push  O(log n)   Map.get  O(1)   adjacency  O(deg) │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: two questions. First, what's the runtime of one `search()` run?
Second, what makes `cost.ts`'s `penalty()` a *good* objective — and why is
`BLOCKED = 1e9` (not `Infinity`) a correctness decision, not a rounding
choice?

## The structure pass

Three layers, and we trace one axis — **cost** — down through all of them. But
"cost" forks into two questions, so trace each.

```
  One axis (cost), traced two ways down the layers

  layer            runtime cost           objective cost
  ─────────────    ──────────────────     ──────────────────────
  search() loop    O((V+E) log V)         Σ costFn over the path
  PQueue           push/pop O(log n)       (carries priorities, not cost)
  cost.ts          penalty() O(1)          length × (1 + penalty)
  graph.ts         adjacency[id] O(deg)    (no objective; pure structure)
```

**The seam that matters:** the boundary between `search()` and `cost.ts`.
On the algorithm side, cost is an *objective* to minimize. On the `cost.ts`
side, cost is a *formula* — `lengthM × (1 + penalty(grade, max))`. The
contract across that seam: the formula must stay **non-negative** (so the
haversine heuristic stays admissible) and **finite** (so a steep-only route
still returns). Break either and the search either returns wrong paths or
returns `null` where a path exists. That's the load-bearing joint.

## How it works

### Move 1 — the mental model

Two shapes, held side by side. **Runtime cost** is how the work grows with
input size — you already feel this every time a `.map()` over 10 items is fine
and over 100,000 items janks the UI. **Objective cost** is the number a search
is trying to minimize — for plain Dijkstra it's meters; for grade routing it's
"penalized meters." The trick in flattr is that the *objective* is a designed
function with a deliberately weird constant in it.

```
  The cost function's shape — penalty(g, max) as g climbs

  penalty
    │                                          ╱ BLOCKED = 1e9
    │                                         ╱   (vertical jump
    │                                    quad╱     at g > max)
    │                              ______╱
    │                        ____╱  ← k2·(g−½max)²  (steep band)
    │                  ____╱
    │        ____╱          ← k1·g  (moderate band)
    │  _____╱
    └──┴──────────┴──────────────┴──────────────► g (grade %)
    g≤0          0.5·max          max
   (free)      (linear)        (quadratic)   (g>max → BLOCKED)
```

The curve is flat-free below zero (downhill costs nothing extra), linear
through the moderate band, quadratic through the steep band, and then a cliff
to a large-but-finite wall once you exceed the user's max.

### Move 2 — the walkthrough

#### Runtime cost of one search() run

Bridge from what you know: you've analyzed Dijkstra before in reincodes
(`Graph2.ts` supports it). The complexity is the textbook
`O((V + E) log V)` with a binary heap — and flattr earns exactly that, with one
subtlety from lazy deletion.

```
  Execution trace — where each cost term comes from

  per node popped (V of them, plus stale dups):
    open.pop()              → O(log n)   siftDown
    closed.has(current)     → O(1)       Set membership
  per edge relaxed (E total, both directions):
    byId.get(edgeId)        → O(1)       Map lookup   ← astar.ts:65
    costFn(edge,…)          → O(1)       penalty math
    g.get(next) ?? Infinity → O(1)       Map lookup
    open.push(…)            → O(log n)   siftUp        ← astar.ts:72

  total: O((V + E) log V)   with lazy-deletion duplicates
         bounded by total pushes, so heap size ≤ E
```

The `byId` index is the part people skip. Look at `astar.ts:11-16`:

```ts
// astar.ts:11-16 — build id→edge once, O(E) setup
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);  // one pass, O(E)
  return m;                                      // every later lookup O(1)
}
```

Without it, every expansion at `astar.ts:65` (`byId.get(edgeId)`) would be a
`graph.edges.find(...)` — `O(E)` per edge — turning the whole search from
`O((V+E) log V)` into `O(V·E·log V)`. The index trades one `O(E)` setup pass
for `O(1)` forever after. That's amortized thinking: pay once, save every time.

#### Amortized cost — why "per operation" can lie

Bridge: think of a JS array's `push`. Most pushes are `O(1)`, but occasionally
the runtime reallocs and copies — `O(n)` that one time. Averaged over many
pushes, it's still `O(1)` *amortized*. The heap's `siftUp` is the same story:
worst case it walks the full height `O(log n)`, but most pushes settle after one
or two swaps. You measure the algorithm by the amortized bound, not the rare
worst case.

```
  Amortized vs worst-case — siftUp on a push

  worst case:  new item smaller than every ancestor
               → swap all the way to root → O(log n)
  typical:     new item lands near a leaf
               → 1–2 swaps → O(1)
  amortized:   over a full search, total swaps bounded by
               total pushes × avg depth → stays O(log n) per op
```

#### Objective cost — the penalty function

Now the second meaning of cost: the number `search()` minimizes. Here's the
core, `cost.ts:16-22`:

```ts
// cost.ts:16-22 — penalty multiplier for a signed grade g vs max
export function penalty(g: number, max: number, k1 = 0.4, k2 = 1.0): number {
  if (g <= 0) return 0;                       // downhill/flat: free
  if (g > max) return BLOCKED;                // over the user's limit: wall
  const half = 0.5 * max;
  if (g <= half) return k1 * g;               // moderate band: linear
  return k2 * (g - half) ** 2 + k1 * half;    // steep band: quadratic
}
```

Walk it one branch at a time:

- **`g <= 0` → `0`.** Downhill and flat add no penalty. The route cost is just
  `lengthM`. This is what makes the directed router prefer the downhill
  direction (`cost.ts:32-33`).
- **`g > max` → `BLOCKED`.** Over the user's comfort grade, slam the cost to
  `1e9`. We'll come back to why it's `1e9` and not `Infinity`.
- **moderate band (`g ≤ half`) → `k1 * g`.** Linear ramp.
- **steep band → quadratic.** `(g - half)²` grows fast, so a 9% grade hurts
  much more than a 5% grade — the router *strongly* avoids the steep band.

The continuity detail matters: at `g = half`, the linear branch gives
`k1 * half` and the quadratic branch gives `k2 * 0 + k1 * half` — same value.
The function is continuous at the boundary by construction (the doc comment at
`cost.ts:14` calls this out). A discontinuity there would create a cliff the
search could exploit, producing jittery routes around the 0.5·max grade.

#### The BLOCKED = 1e9 invariant — the surprising choice

This is the most important single line in `cost.ts`. Here's the constant,
`cost.ts:4-5`:

```ts
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

Why not `Infinity`? Because of what it does to the search's two failure modes,
which the codebase insists must stay distinct:

```
  Two "no" answers that must not collapse into one

  ┌─ "no FLAT route" ──────────┐   ┌─ "no route AT ALL" ────────┐
  │ steep edge is the only     │   │ start & goal in different   │
  │ way through                │   │ connected components        │
  │                            │   │                             │
  │ cost = 1e9 (finite)        │   │ never reached → null        │
  │ → path RETURNED, steep     │   │ → path === null             │
  │   edge flagged in          │   │                             │
  │   steepEdges[]             │   │ honest "I can't get there"  │
  └────────────────────────────┘   └─────────────────────────────┘
        large-finite keeps                  unreachable stays
        this path alive                     genuinely null
```

If `BLOCKED` were `Infinity`, the tentative-cost comparison at `astar.ts:69`
(`tentative < (g.get(next) ?? Infinity)`) could never *improve* on the default
`Infinity`, so a steep-only edge would never relax — the node would stay
unreached and the search would return `null`. The user would see "no route"
when the truth is "no *flat* route, but here's a steep one." The test at
`astar.test.ts:82-89` pins exactly this: filter the graph down to only the
steep `xy` edge, and the directed router still returns a path with `xy` in
`steepEdges`. The pqueue test at `pqueue.test.ts:101-106` confirms the heap
orders `1e9` to the back (after a priority-10 item) — large-finite sorts last
without being unorderable.

### Move 3 — the principle

Complexity analysis tells you which structure to reach for; cost-function
design tells you what the algorithm will actually *do*. They're different
axes, and flattr keeps them clean: the heap and the index are runtime-cost
decisions, the penalty curve and `BLOCKED` are objective-cost decisions. The
generalizable lesson is the `1e9` trick — when "rejected" and "impossible"
are different answers, encode rejection as an expensive-but-reachable value,
not an unreachable one. `Infinity` collapses the distinction; large-finite
preserves it.

## Primary diagram

The full picture: runtime cost feeding structure choice, objective cost
feeding route choice, both meeting in `search()`.

```
  flattr's two cost models, end to end

  ┌─ RUNTIME COST (how expensive to compute) ─────────────────┐
  │  search() loop: O((V+E) log V)                            │
  │    ├─ byId index   O(E) once  → O(1) per expansion        │
  │    ├─ PQueue       O(log n) push/pop                      │
  │    └─ Map/Set      O(1) g, came, closed                   │
  └────────────────────────────────────────────────────────────┘
                          meet in search()
  ┌─ OBJECTIVE COST (what the search minimizes) ──────────────┐
  │  Σ  lengthM × (1 + penalty(grade, userMax))               │
  │    ├─ g≤0        → 0          (downhill free)             │
  │    ├─ moderate   → k1·g       (linear)                    │
  │    ├─ steep      → quadratic  (strongly avoided)          │
  │    └─ g>max      → BLOCKED=1e9 (finite wall, still routes)│
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Asymptotic analysis comes from Knuth-era algorithm analysis; the point is to
compare algorithms independent of hardware. Amortized analysis (Tarjan, 1985)
formalizes "average over a sequence" so you don't over-pessimize structures
like dynamic arrays and lazy heaps. The cost-function side is closer to
operations research: you're shaping an objective so the optimizer's
mathematically-optimal answer matches the human-desirable answer. flattr's
penalty curve is a small instance of that — the quadratic steep band exists so
the router doesn't treat a barely-tolerable hill the same as a flat detour.

Read next: `03` (the heap whose `O(log n)` justifies all of this) and `05`
(the search loop that spends the cost).

## Interview defense

**Q: What's the time complexity of your A* search, and where does it come from?**

`O((V + E) log V)`. Walk it: each node is finalized once (`closed` set,
`astar.ts:61`), each edge relaxed at most a constant number of times, and every
push/pop is `O(log n)` on the binary heap. The `byId` index keeps each
expansion's edge lookup `O(1)` instead of `O(E)`.

```
  V nodes × O(log V) pops  +  E edges × O(log V) pushes
  = O((V + E) log V)
```

Anchor: "lazy deletion means I push duplicates, so heap size is bounded by
total pushes, not V — but the log factor is unchanged."

**Q: Why is BLOCKED `1e9` instead of `Infinity`?**

Because "no flat route" and "no route" are different answers and the product
needs both. Finite `1e9` lets a steep-only edge still relax at `astar.ts:69`,
so the path returns and the steep edge gets flagged in `steepEdges`.
`Infinity` would make that node unreachable and return `null` — a lie.

```
  Infinity:  steep edge never relaxes → null ("no route", wrong)
  1e9:       steep edge relaxes, costs a lot → path + steepEdges (honest)
```

Anchor: "encode *rejected* as expensive-reachable, *impossible* as
unreachable — `1e9` vs the absence of a `g` entry."

## See also

- `03-stacks-queues-deques-and-heaps.md` — the `O(log n)` heap operations.
- `02-arrays-strings-and-hash-maps.md` — the `O(1)` Map lookups (`byId`, `g`).
- `05-graphs-and-traversals.md` — where both cost models meet in `search()`.
- `06-sorting-searching-and-selection.md` — the `O(M log M)` sort in `zones.ts`.
