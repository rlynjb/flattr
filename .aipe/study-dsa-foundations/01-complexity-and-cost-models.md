# Complexity & Cost Models

**Industry names:** asymptotic analysis (Big-O), amortized analysis, cost
functions. **Type:** Industry standard.

---

## Zoom out — where this concept lives

Complexity isn't a file — it's the lens you hold over every other file.
But flattr has one place where a *cost model decision* is written into the
code as a constant, and that's the thing to anchor on.

```
  Zoom out — cost models across the routing stack

  ┌─ Snap layer ────────────────────────────────────────────────┐
  │  nearest.ts   nearestNode()      → O(N) per snap            │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Search layer ──────────────────────────────────────────────┐
  │  astar.ts     search()           → O(E log V)              │
  │  pqueue.ts    push/pop           → O(log n) amortized       │
  │  cost.ts      ★ BLOCKED = 1e9 ★  → a finite-cost decision   │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Aggregate layer ───────────────────────────────────────────┐
  │  zones.ts     percentile()       → O(N log N) full sort     │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Two questions this file answers. First: what does each
operation in flattr actually *cost*, in Big-O, and where's the slack?
Second — the one that's specific to this repo — why is "blocked" encoded
as `1e9` and not `Infinity`? That second one is a *cost-model* decision,
and it's the most interesting thing in the file.

---

## Structure pass — one axis across the layers

Layers: **snap → search → aggregate**. The axis worth tracing is **cost
per unit of work** — and specifically *what dominates as the graph grows*.

```
  Axis: "what dominates as N (nodes) and E (edges) grow?"

  ┌─ snap ──────────┐   N grows → linear scan dominates
  │  O(N)           │   the seam: no spatial index
  └─────────────────┘
  ┌─ search ────────┐   E grows → heap ops dominate
  │  O(E log V)     │   the seam: lazy deletion vs decrease-key
  └─────────────────┘
  ┌─ aggregate ─────┐   N grows → full sort dominates
  │  O(N log N)     │   the seam: sort vs selection
  └─────────────────┘
```

The seam at each layer is the same shape: **a linear or log-linear
operation sitting where a smarter structure would cut the exponent or
the log.** That's the through-line of this whole guide — flattr's
algorithms are *correct* everywhere; the slack is in the *cost model
choices*, not in bugs.

---

## How it works

### Move 1 — the mental model

You already do this every time you pick `.find()` vs a `Map`. Big-O is
just "how does the work grow when the input doubles?" The picture is a
curve, and the only curves that matter for flattr are these four:

```
  The cost curves that appear in flattr

  work
   │                                    O(N²)  ← never (would be naive A*)
   │                               .
   │                          .
   │                     .          O(N log N) ← zones.ts sort
   │                .  ___------    O(N)        ← nearest.ts scan
   │           . _--
   │       ._--      ____________   O(log N)    ← one heap op
   │    .--______----
   │ .-‾                            O(1)        ← one Map lookup
   └────────────────────────────────────► input size N
```

flattr lives almost entirely in the bottom three curves. The `O(N²)`
curve is the one A* *avoids* — and it avoids it precisely because of the
heap (`O(log N)` pops) and the hash maps (`O(1)` lookups). Drop either
and the whole search slides up to `O(N²)`.

### Move 2 — the cost model that's actually written into the code

#### The `BLOCKED` constant — a cost model, not an error code

Here's the one that trips people up. A too-steep edge isn't *forbidden* —
it's *expensive*. And the difference between "expensive" and "impossible"
is the whole reason this is a finite number.

```ts
// features/routing/cost.ts:5
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

```ts
// features/routing/cost.ts:16-22
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;          // downhill/flat: free
  if (g > max) return BLOCKED;   // over userMax: 1e9, NOT Infinity
  const half = 0.5 * max;
  if (g <= half) return k1 * g;  // moderate: linear
  return k2 * (g - half) ** 2 + k1 * half; // steep: quadratic
}
```

Trace what `Infinity` would do versus `1e9`:

```
  Comparison — BLOCKED as Infinity vs 1e9

  ┌─ if BLOCKED were Infinity ──────────┐  ┌─ BLOCKED = 1e9 (actual) ──────────┐
  │ steep edge cost = Infinity          │  │ steep edge cost = ~1e9 * length    │
  │ tentative = g + Infinity = Infinity │  │ tentative = g + 1e9 = large finite │
  │ Infinity < Infinity → false         │  │ 1e9 < Infinity → true: edge relaxed│
  │ edge NEVER relaxed                  │  │ edge IS relaxed, path found        │
  │ → "all routes steep" == "no route"  │  │ → "all steep" path returned +      │
  │   (user can't tell them apart)      │  │    flagged in steepEdges (honesty) │
  └─────────────────────────────────────┘  └────────────────────────────────────┘
```

This is the product's "honesty" requirement encoded as a number. The
relaxation test in `astar.ts:69` is `tentative < (g.get(next) ?? Infinity)`.
A finite `1e9` *passes* that test; an `Infinity` cost would tie with the
`Infinity` default and fail it. So a city where every route to the goal
crosses one steep block still returns a route — with that block listed in
`steepEdges` — instead of returning `null` ("no route"). `null` is
reserved for *genuinely disconnected* (`astar.test.ts:91-96`).

**What breaks if you remove the finiteness:** the user can no longer
distinguish "there's a path but it's steep" from "there's no path." Two
very different answers collapse into one.

#### Amortized analysis — why one heap push is "O(log n)"

A single `siftUp` can climb the whole tree height — `log n` swaps. But
most pushes don't. Amortized analysis says: average the expensive
operations over the cheap ones across a whole sequence.

```
  Amortized: cost spread over a sequence of pushes

  push 1:  ●                    0 swaps
  push 2:  ●─┐                  1 swap
  push 3:  ● ●                  0 swaps
  push 4:  ●─┐                  1 swap
  ...
  push n:  rare full climb      log n swaps  ← the worst case
           ────────────────────────────────
           total over n pushes ≈ O(n), so   O(1) amortized per push
           (worst single push still O(log n))
```

For flattr's purposes the honest bound is **O(log n) per push and per
pop**, because A* can push the same node many times (lazy deletion — see
file 03). The amortized framing matters when you reason about the *whole
search*: `O(E log V)` total, because each edge can trigger at most one
push.

#### Choosing the right cost model — distance vs grade

flattr has *four* cost functions, and the choice of which to plug in
changes what "optimal" even means:

```
  cost.ts — the cost model IS a parameter

  distanceCost        → cost = lengthM           (shortest path)
  gradeCostAbs        → cost = lengthM*(1+pen)   (flattest, symmetric)
  gradeCostDirected   → cost = lengthM*(1+pen)   (flattest, A→B ≠ B→A)
                                    ▲
                              penalty(grade, userMax)
```

The complexity is identical across all four — same `O(E log V)`. What
changes is the *number that gets minimized*. This is the cleanest example
in the repo of "the algorithm and the cost model are separable": you swap
the cost model and reuse the entire search engine (file 05 walks this).

### Move 3 — the principle

Cost models are decisions, not facts. `BLOCKED = 1e9` looks like a magic
number; it's actually a product requirement ("always show a route, flag
the steep parts") expressed in the only language the algorithm
understands — a finite, large cost. When you see a constant that *could*
be `Infinity` but isn't, ask what distinction the finiteness is
preserving.

---

## Primary diagram

The full cost picture: where each operation sits, and where the slack is.

```
  flattr — complexity at every layer (★ = optimization slack)

  ┌─ Snap (nearest.ts) ─────────────────────────────────────────┐
  │  nearestNode: scan all N nodes, haversine each   → O(N)  ★  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ startId, goalId
  ┌─ Search (astar.ts + pqueue.ts) ─────────────────────────────┐
  │  per pop:   heap pop          → O(log V)                    │
  │  per edge:  g/closed lookup   → O(1)                        │
  │             heap push         → O(log V)                    │
  │  total:     O(E log V)                                       │
  │  cost.ts:   penalty()         → O(1), BLOCKED=1e9 finite    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ Path
  ┌─ Aggregate (zones.ts) ──────────────────────────────────────┐
  │  percentile: full sort then index  → O(N log N)         ★  │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Big-O comes from Bachmann/Landau (1890s number theory), pulled into CS by
Knuth. Amortized analysis is Tarjan's (1985) — the same Tarjan behind
union-find (a gap noted in file 05/08). The `1e9`-not-`Infinity` trick is
folklore in routing engines: OSRM and Valhalla both use large finite
"blocked" weights for exactly flattr's reason — distinguishing
*penalized* from *impossible*. flattr can't use those engines (the spec
forbids it — `docs/flattr-spec.md` §14), so it re-derives the trick. Read
file 03 next for the heap that the `O(log V)` claim rests on.

---

## Interview defense

**Q: Why is `BLOCKED` `1e9` and not `Infinity`?**

```
  Infinity → relaxation test fails → edge unreachable → null
  1e9      → relaxation test passes → path returned + flagged
```

*Model answer:* "Because `null` means disconnected and a steep path means
'expensive but possible' — two different answers the product must keep
distinct. The relaxation test is `tentative < (g ?? Infinity)`. A finite
`1e9` passes it, so an all-steep route is still found and its bad edges
land in `steepEdges`. `Infinity` would tie with the default and fail the
test, collapsing 'steep' into 'no route.'"

*Anchor:* `cost.ts:5` — large-finite is honesty, not a hack.

**Q: What's the time complexity of one route query end to end?**

*Model answer:* "`O(N)` to snap the endpoints — that's the linear scan in
`nearest.ts`, the weakest link — plus `O(E log V)` for the A* itself: each
edge relaxes at most once, each push/pop is `O(log V)` against the binary
heap. On a city graph `E ≈ 2-3·V`, so the search is effectively
`O(V log V)`. The snap can dominate on a big graph, which is why a spatial
index is the first thing I'd add."

*Anchor:* snap is `O(N)`, search is `O(E log V)` — the snap is the gap.

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the `O(log n)` heap ops.
- `05-graphs-and-traversals.md` — the `O(E log V)` search this all serves.
- `06-sorting-searching-and-selection.md` — the `O(N log N)` zones sort.
- sibling **performance-engineering** — the `bench/` harness that measures
  these bounds empirically.
