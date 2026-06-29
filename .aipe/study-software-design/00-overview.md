# Overview — software design in flattr

One page to orient before the audit. The whole repo is a routing engine
plus a thin map UI, and almost every interesting design decision is about
*where grade knowledge is allowed to live*. Hold that one question and the
architecture reads itself.

## The layers

flattr splits cleanly into build-time and run-time, with a pure core that
both share. Here's the whole system as bands, with the design seams marked.

```
  flattr — the layers, with the design seams marked

  ┌─ UI layer (mobile/, Expo + RN) ───────────────────────────────┐
  │  MapScreen.tsx · GradeSlider · AddressBar · RouteSummaryCard   │
  │  useTileGraph.ts  ← single-flight pump (07)                    │
  └─────────────────────────────┬──────────────────────────────────┘
                                │  Graph (in-memory), userMax (number)
  ┌─ Core: features/routing (pure, framework-free) ────────────────┐
  │  astar.ts   search()  ← parametric over (costFn, heuristic) (01)│
  │  bidirectional.ts                                              │
  │  pqueue.ts  ← lazy-deletion heap (04)                          │
  │  cost.ts    ← THE domain seam: penalty, BLOCKED (02, 05)       │
  │  graph.ts   ← directedGrade: derive, don't store (03)          │
  └─────────────────────────────┬──────────────────────────────────┘
                                │  Graph artifact (graph.json) OR
                                │  on-device tile build
  ┌─ Build pipeline (pipeline/, build-time + on-device tiles) ─────┐
  │  osm → split → sampleElevations → grade → buildAdjacency       │
  │  elevation.ts  ← ElevationProvider interface (06)              │
  └────────────────────────────────────────────────────────────────┘
```

The dependency arrow points **inward**: UI and pipeline both depend on the
pure core (`features/routing/types.ts` is the shared vocabulary); the core
depends on nothing but `lib/geo.ts`. `build-graph.ts:2` even refuses to
import `node:fs` so the pipeline can bundle into the mobile app for on-device
tile building. That inward-pointing arrow is the single most important
structural fact in the repo.

## The one axis that makes the design pop

Pick one question and trace it through every layer: **who knows what "grade"
means?**

```
  axis traced = "who knows the grade domain?"

  ┌─ search loop (astar.ts) ──┐  knows: cost is a number to minimize
  │  costFn(edge, from, max)  │  knows NOTHING about grade
  └─────────────┬──────────────┘
                │  seam: the CostFn type
  ┌─ cost.ts ───▼──────────────┐  knows: penalty curve, BLOCKED, userMax,
  │  penalty(), gradeCost*     │         downhill-is-free
  └─────────────┬──────────────┘
                │  seam: directedGrade(edge, from)
  ┌─ graph.ts ──▼──────────────┐  knows: sign flips with travel direction
  │  directedGrade()           │  knows NOTHING about penalty/cost
  └────────────────────────────┘

  three layers, three disjoint pieces of knowledge — no overlap
```

The answer flips cleanly at every seam, and — this is the win — **no two
layers know the same fact**. The search loop never mentions grade. `cost.ts`
never mentions the frontier. `graph.ts` knows the sign convention but not the
penalty. That's information hiding working as designed.

## The seams (where to study before the internals)

| Seam | Contract | Axis that flips | Deep walk |
|------|----------|-----------------|-----------|
| `CostFn` type (`types.ts:40`) | `(edge, fromNodeId, userMax) → number` | domain knowledge: agnostic → grade-aware | `01`, `02` |
| `directedGrade` (`graph.ts:17`) | signed grade in travel direction | undirected storage → directed query | `03` |
| `BLOCKED` (`cost.ts:5`) | large-finite, not Infinity | "too steep" → "disconnected" | `05` |
| `ElevationProvider` (`elevation.ts:7`) | `sample(points) → number[]` | which DEM source / cache / fallback | `06` |
| `PQueue` (`pqueue.ts:4`) | `push(item, priority)` / `pop()` | knows graph → knows nothing | `04` |

## What the audit concluded

- **Strengths (named with files):** `search()` is the deepest module in the
  repo — four algorithm stages behind one signature. `cost.ts` is a clean
  domain seam, 33 lines holding the entire grade model. `PQueue` knows
  nothing about graphs. Comments explain *why* (`cost.ts:4`, `useTileGraph.ts:18`).
- **The two real smells:** `nearestNode` (`nearest.ts:5`) is an O(n) scan
  over every node on every tap; `edgeById` (`graph.ts:3`) is an O(E)
  `.find()` that `summarizePath` and `routeSummary` call in a loop. Both are
  correctness-fine and speed-suboptimal — see `audit.md` Lens 1 and Lens 8.
- **Honest gaps:** error handling is thin by design (the core is pure
  functions that return `null` paths, not exceptions); there's no
  configuration-explosion problem because there's almost no configuration.
  These lenses get "lightly exercised" verdicts, not invented findings.

Start with `audit.md` for the full lens walk, then drop into whichever
pattern file the audit cross-links to.
