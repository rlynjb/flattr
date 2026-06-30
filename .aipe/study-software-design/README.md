# Study — Software Design (flattr)

This guide audits **flattr** through the design primitives in John
Ousterhout's *A Philosophy of Software Design* (APOSD): deep modules,
information hiding, complexity, layering, readability. Source for the
primitives: **A Philosophy of Software Design**, John Ousterhout — read
it; this guide teaches the ideas in original words and spends its weight
on findings about *your* code.

## The through-line

> Complexity is the enemy. Deep modules are the weapon.

A module is **deep** when it hides a lot of behaviour behind a small
interface. flattr's routing core is a small pile of deep modules: one
`search()` that knows nothing about grade, one `penalty()` that knows
nothing about search, one priority queue that knows nothing about
graphs. The interesting design work in this repo is the *seams between
them* — the boundaries chosen so each side can change without the other
noticing. This guide names those seams as patterns.

## Reading order

1. **`00-overview.md`** — one-page orientation: the layer map, the
   five seams, the through-line.
2. **`audit.md`** — Pass 1. The 8-lens APOSD audit. Every lens walked,
   `not yet exercised` named honestly where it doesn't bite. The
   `red-flags-audit` lens at the bottom is the actionable index.
3. **The pattern files** — Pass 2. One per design move flattr actually
   makes. Read in any order; each is self-contained.

```
  01-parametric-search-over-cost-fns.md   one search(), domain swapped by argument
  02-penalty-as-the-domain-seam.md         grade lives in ONE function
  03-directed-traversal-over-undirected-storage.md  derive, don't materialize
  04-lazy-deletion-priority-queue.md       simplicity bought with a stale-skip
  05-blocked-as-large-finite.md            "no flat route" ≠ "no route"
  06-single-flight-graph-pump.md           one build at a time, corridor first
  07-provider-interface.md                 elevation source behind one method
```

## The two findings worth fixing first

Both live in `audit.md`; the deep walks live in the pattern files they
touch.

1. **`edgeById` is O(E) inside a per-edge loop.** `features/routing/graph.ts:3`
   does `graph.edges.find(...)` — a linear scan — and it's called once
   per path edge in `summary.ts:14` and `geojson.ts:53`. That's
   O(path · E). `astar.ts` already solved this for itself with
   `indexEdges` (an id→edge `Map`); the route-summary and rendering
   paths never got the same treatment. → see `audit.md` lens 1.

2. **The DEM cell-key formula is written twice.** `pipeline/elevation.ts:42`
   and `mobile/src/useTileGraph.ts:36` both quantize a lat/lng to a
   ~90 m cell with `${Math.round(lat / prec)},${Math.round(lng / prec)}`.
   They must agree exactly or the elevation cache silently misses. Same
   knowledge, two edit sites — textbook information leakage. → see
   `audit.md` lens 3 and `07-provider-interface.md`.

## Cross-links

- **`read-aposd`** (if generated) — the book-style teaching of these
  primitives, abstract, not anchored to flattr.
- **`study-system-design/`** — the same repo at a different altitude:
  the build pipeline vs runtime split, the static-graph-artifact
  boundary, the mobile single-flight network discipline as a *system*
  concern rather than a module one.
- **`study-dsa-foundations/`** — the A*/Dijkstra/binary-heap algorithms
  themselves, taught as reusable data structures rather than as design
  seams.
- Sibling guides under `.aipe/`: `study-performance-engineering`
  (the O(E) finding as a latency cost), `study-testing` (the seams as
  the thing that makes the fixtures trivial), `study-frontend-engineering`
  (`useTileGraph` as a React hook).
