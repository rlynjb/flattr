# Study — Software Design (APOSD applied to flattr)

This guide audits the **flattr** repo through the design primitives in John
Ousterhout's *A Philosophy of Software Design* (APOSD) — deep modules,
information hiding, complexity, layering, error handling, readability — and
grounds every finding in real files at real line ranges.

> **Source note.** The primitives taught here come from *A Philosophy of
> Software Design*, John Ousterhout. This guide teaches the ideas in original
> words and spends its weight on findings about *your* code. Read the book for
> the full conceptual treatment; this guide is the application.

## The through-line

> **Complexity is the enemy. Deep modules are the weapon.**

A module is *deep* when it hides a lot of behaviour behind a small interface —
big body, small surface. It's *shallow* when its interface is nearly as
complex as what it does. flattr's engine is unusually deep for a hand-rolled
project: one `search()` function (`features/routing/astar.ts:22`) covers four
graph algorithms because all the variation lives behind two function-typed
parameters, `CostFn` and `HeuristicFn`. The whole grade-aware product is one
`penalty()` function (`features/routing/cost.ts:16`) behind that seam. That is
the design lesson of this repo, and most of the pattern files below are
variations on it.

The opposite end — the place complexity actually piled up — is the mobile
data-loading hook (`mobile/src/useTileGraph.ts`), where build-time concerns
(Overpass, elevation, rate limits) leaked up into a React hook. That's the
module nobody wants to touch, and the audit names why.

## Reading order

1. `00-overview.md` — one-page orientation: the layers, the central seam, the
   ranked verdict (deepest module, shallowest interface, biggest complexity
   risk).
2. `audit.md` — Pass 1. The 8-lens APOSD audit. Every lens walked against the
   real files, with `not yet exercised` named honestly where a primitive has
   little to bite on.
3. The pattern files (Pass 2) — one per design *move* the repo makes
   deliberately:
   - `01-parametric-search-over-cost-fns.md` — the deepest module: one
     `search()`, four algorithms, all variation behind `CostFn`/`HeuristicFn`.
   - `02-penalty-as-the-domain-seam.md` — the entire grade product as one pure
     `penalty()` function behind the `CostFn` interface.
   - `03-directed-traversal-over-undirected-storage.md` — `otherEnd` /
     `directedGrade` hide that edges are stored once but traversed both ways.
   - `04-lazy-deletion-priority-queue.md` — a generic heap that hides its
     array and its "skip stale entries" trick from the search loop.
   - `05-blocked-as-large-finite.md` — an error (no flat route) defined out of
     existence by making it a number, not an exception.
   - `06-single-flight-graph-pump.md` — the complexity hotspot: build-time
     pipeline concerns pulled into a React hook, with best-effort degradation.

## Cross-links

- `.aipe/study-dsa-foundations/` — the heap and A* as reusable algorithms
  (the *what*; here we judge the *interface around* them).
- `.aipe/study-system-design/` — the build-time vs run-time boundary, the
  static-artifact architecture (the *altitude above* module design).
- `.aipe/study-testing/` — `fixtures.ts`, the `CostFn`/`ElevationProvider`
  seams as test injection points.
- `.aipe/study-data-modeling/` — the `Node`/`Edge`/`Graph` schema that the
  signed-grade convention rides on.
- `read-aposd` (book reader) — the full conceptual chapters this guide applies.
