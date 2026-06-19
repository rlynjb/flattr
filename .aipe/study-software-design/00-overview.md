# Overview — the design shape of flattr
## one-page orientation for the software-design audit

flattr is a hand-rolled grade-aware A* router. The design question that
matters here isn't "does it find paths" — it's "where does the complexity
live, and what hides it." This page puts you on the map before the audit and
the pattern files zoom in.

## The layers

Here's the whole system as bands, with the module-design hotspots marked.

```
  flattr — layers, with the design-relevant boxes marked

  ┌─ UI layer (mobile/src) ──────────────────────────────────────┐
  │  MapScreen.tsx   AddressBar   GradeSlider   Legend            │
  │  useTileGraph.ts   ★ complexity hotspot ★                     │ ← deepest
  └───────────────────────────┬──────────────────────────────────┘   leak risk
                              │ calls (run-time)
  ┌─ Engine layer (features/) ▼──────────────────────────────────┐
  │  routing/astar.ts   ★ deepest module: one search(), 4 algos ★ │ ← the point
  │  routing/cost.ts    ★ the domain seam: penalty() ★            │   of the repo
  │  routing/pqueue.ts  routing/graph.ts  routing/summary.ts      │
  │  grade/classify.ts  grade/zones.ts   map/geojson.ts  tiles.ts │
  └───────────────────────────┬──────────────────────────────────┘
                              │ consumes the artifact / shares modules
  ┌─ Pipeline layer (pipeline/) ▼────────────────────────────────┐
  │  osm  overpass  elevation  split  grade  build-graph          │ ← build-time
  │  build-graph.ts  ★ clean orchestrator: 5 stages, 1 call ★     │   (mostly)
  └───────────────────────────┬──────────────────────────────────┘
                              │ depends on
  ┌─ Utility layer (lib/) ────▼──────────────────────────────────┐
  │  geo.ts  (haversine)                                          │
  └───────────────────────────────────────────────────────────────┘
```

## The central seam — trace one axis

Pick the axis **"who decides the cost of an edge?"** and trace it across the
engine. The whole design turns on where the answer flips.

```
  Axis: "who decides what an edge costs?" — traced across the seam

  ┌─ search() in astar.ts ────┐   CostFn seam   ┌─ cost.ts ──────────┐
  │ does NOT know about grade │ ═══════╪═══════►│ penalty() decides  │
  │ just calls costFn(edge…)  │   (it flips)    │ grade vs distance  │
  └───────────────────────────┘                 └────────────────────┘
         ▲                                              ▲
         └────────── same axis, two answers ────────────┘
            search() owns the traversal; cost.ts owns the domain.
            That seam is why one function is four algorithms.
```

That `CostFn` seam (`features/routing/types.ts:40`) is the load-bearing
design decision in the repo. Everything in Pass 2 either lives behind it
(`01`, `02`, `05`), supports it (`03`, `04`), or is the place the discipline
broke down (`06`).

## The ranked verdict

Per the verdict-first rule, here's the call before the long audit:

- **Deepest module:** `features/routing/astar.ts` — one `search()`
  (lines 22–78) over a substantial body (lazy-deletion A*, closed set,
  reconstruct, summarize) behind a tiny surface. Four public algorithms
  (`dijkstra`, `astar`, `gradeAstar`, `directedAstar`, lines 136–163) are
  one-line wrappers that just pick a `(costFn, heuristicFn)` pair. This is the
  best deep-module example in the repo. → `01`.

- **Shallowest / leakiest interface:** `mobile/src/useTileGraph.ts` — a React
  hook whose interface (`graph`, `loadingStep`, `onRegionDidChange`,
  `ensureBbox`) is small, but whose body leaks build-time knowledge
  (Overpass, Open-Meteo, batch sizes, rate-limit backoff, DEM resolution) up
  into the UI layer. The hook *looks* deep but its complexity is borrowed from
  layers below it. → `06`.

- **Biggest complexity risk:** also `useTileGraph.ts` — the `pump()` function
  (lines 89–129) carries a single-flight mutex, two pending slots with
  priority ordering, ref/state duplication, and a fire-and-forget async IIFE
  with a swallowed catch. This is the change-amplification and unknown-unknowns
  hotspot: a bug here is hard to even reproduce. → `06`.

## What this repo does *not* exercise

Honest gaps, so the audit doesn't manufacture findings:

- **Deep inheritance / classitis at scale** — the codebase is almost entirely
  pure functions and one tiny class (`PQueue`). There's no class hierarchy to
  critique. APOSD's "classitis" red flag barely fires.
- **Scattered exception handling** — errors are mostly *defined out*
  (`BLOCKED`) or thrown at one obvious place (`otherEnd`, `nearestNode`). The
  "try/except everywhere" red flag fires only in the mobile layer.
- **Pass-through layering smell** — the engine layers earn their place. The
  one borderline case is `build-graph.ts`, and it's defensible (see audit
  Lens 4).

Read `audit.md` next for the full lens-by-lens walk.
