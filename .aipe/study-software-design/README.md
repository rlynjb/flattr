# Study — Software Design (flattr)

A code-level design audit of **flattr** through the primitives in John
Ousterhout's *A Philosophy of Software Design* (APOSD): deep modules,
information hiding, complexity, layering, readability. Every finding is
grounded in a real file and line range. Read the book for the framework;
this guide is the findings about *your* code.

> Source: John Ousterhout, *A Philosophy of Software Design* (2nd ed.).
> The conceptual lead-ins here are paraphrased and short on purpose — go
> read the book for the full treatment of each primitive.

## The through-line

Complexity is the enemy; **deep modules** are the weapon. A deep module
hides a lot of behavior behind a small interface. flattr's router is a
near-textbook example: one `search()` function (small interface — a graph,
two node ids, a cost function, a heuristic) hides Dijkstra, A\*, grade-aware
A\*, and directional A\* (large behavior). The whole design pivots on a
single seam — the **cost function** — and the grade domain lives behind it,
never inside the search loop.

```
  flattr's design in one picture

  ┌─ what the search loop knows ──────────────┐
  │  graph, frontier, closed set, costFn      │   ← domain-AGNOSTIC
  └──────────────────────┬─────────────────────┘
                         │  costFn(edge, from, userMax)   ← THE seam
  ┌─ what cost.ts knows ─▼─────────────────────┐
  │  grade, penalty curve, BLOCKED, userMax    │   ← the ENTIRE domain
  └────────────────────────────────────────────┘
```

## Reading order

1. **`00-overview.md`** — one-page orientation: the layers, the one axis
   that makes the design pop (where does grade knowledge live?), the seams.
2. **`audit.md`** — Pass 1. The 8-lens APOSD audit, every lens walked
   against real files, `not yet exercised` named honestly. Start here for
   the diagnostic; it cross-links to the pattern files for deep walks.
3. **The pattern files** — Pass 2. One per design move flattr actually
   makes. Each uses the full concept-file template (zoom out → structure
   pass → how it works → interview defense).

   - `01-parametric-search-over-cost-fns.md` — one `search()`, four stages
     as arguments. The deepest module in the repo.
   - `02-penalty-as-the-domain-seam.md` — grade logic lives ONLY in
     `cost.ts`; the search loop never says "grade."
   - `03-directed-traversal-over-undirected-storage.md` — store one signed
     grade, derive the travel-direction sign. Don't materialize both.
   - `04-lazy-deletion-priority-queue.md` — skip decrease-key; tolerate
     stale entries and discard on pop. Simplicity bought with a cheap check.
   - `05-blocked-as-large-finite.md` — `BLOCKED = 1e9`, not `Infinity`, so
     "no flat route" stays distinct from "no route at all."
   - `06-provider-interface.md` — `ElevationProvider`: a one-method
     interface that hides Google vs Open-Meteo vs fixture vs cache vs
     fallback behind `sample(points)`.
   - `07-single-flight-graph-pump.md` — one network build at a time,
     corridor beats viewport. Bounded concurrency in a React hook.

## Cross-links to sibling guides

- **`study-system-design/`** — the same router at a higher altitude:
  build-time pipeline vs runtime, the static-graph-artifact boundary,
  on-device tile fetching. System boundaries, not module interfaces.
- **`study-dsa-foundations/`** — the algorithms themselves (A\*
  admissibility, binary heap mechanics, bidirectional search). This guide
  treats them as *modules to design well*; that guide teaches them as
  *algorithms to implement correctly*.
- **`study-performance-engineering/`** — the elevation cache, the dedup,
  the rate-limit budget, the single-flight pump as throughput controls.
- **`study-testing/`** — the provider interface and `fixtureProvider` as
  the seam that makes the pipeline deterministically testable.

## A note on what this audit found

flattr is small (~3,300 lines including tests) and unusually clean. The
modules are deep, the comments explain *why* not *what*, and the one
load-bearing seam (the cost function) is honored everywhere. The audit
names the genuine strengths with files, and it names the two real smells
(a linear `nearestNode` scan, an `edgeById` linear lookup that an index
would erase). It does not manufacture problems to seem thorough.
