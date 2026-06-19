# Performance Engineering — overview (flattr)

The verdict first: **flattr is the rare portfolio repo where the performance
story is the product.** It ships a real benchmark harness (`bench/run.ts`,
`bench/report.ts`) that runs a five-stage algorithm progression and prints a
comparison table keyed on the metric that actually matters for a search engine —
**nodes expanded** — alongside queue pushes/pops, wall-clock ms, and path cost.
The headline result is honest and reproducible: A* finds the *exact same optimal
path* as Dijkstra while expanding roughly **4–6× fewer nodes**. That's the whole
lesson of informed search, demonstrated on your own code, with numbers you can
re-run.

Everything else hangs off that spine.

## The repo in one diagram

The performance-relevant surfaces, by layer.

```
  flattr — where performance lives

  ┌─ Build-time (pipeline/) ─────────────────────────────────────┐
  │  osm → split → elevation (BATCH + DEDUP) → grade → graph.json │
  │  the I/O-bound stage; runs once, offline                      │
  └───────────────────────────────────┬───────────────────────────┘
                                       │  ships a 544 KB artifact
  ┌─ Core engine (features/routing/) ──▼───────────────────────────┐
  │  ★ search() — one parametric A* ★   ← the latency optimization │
  │  pqueue.ts (lazy-deletion heap)     nearest.ts (O(N) scan)      │
  │  instrumented: nodesExpanded / pushes / pops                   │
  └───────────────────────────────────┬───────────────────────────┘
        ┌──────────────────────────────┴───────────────┐
        │ measured by                    consumed by    │
  ┌─ bench/ ────────────────┐   ┌─ Mobile (mobile/src/) ▼──────────┐
  │ run.ts → comparison     │   │ MapScreen useMemo → directedAstar │
  │ table (expanded/ms/cost)│   │ SYNCHRONOUS on the single JS thread│
  └─────────────────────────┘   │ useTileGraph: debounce + pump      │
                                 └────────────────────────────────────┘
```

## Ranked findings

Ranked by consequence — the load-bearing optimization first, the latent risks
after.

**1. Heuristic pruning is the load-bearing latency win — and it's measured.**
`search()` in `features/routing/astar.ts:22-78` is one parametric engine; the
"stages" are just `(costFn, heuristicFn)` pairs. Swapping `zeroHeuristic` for
`haversineHeuristic` (`astar.ts:8-9`) turns Dijkstra's flood into A*'s cone.
Measured from `npm run bench` on this machine (grid40, mid-interior pair):
Dijkstra expands **1079** nodes, A* expands **276** — a **3.9× reduction for the
identical 2400.00 cost**. The win is fewer expansions for the same answer, never a
cheaper answer. → `01-heuristic-pruning.md`.

**2. The bench harness is a genuine measurement artifact, not a toy.** The
counters live *inside* the search loop (`astar.ts:35-37,51,57,72`), so they count
real work, not wall-clock noise. `bench/run.ts:17-21` deliberately picks
**interior** node pairs and explains why in a comment: corner-to-corner is
degenerate because the goal is the farthest node, so nothing can be pruned. That
comment is the sign of someone who understood *why* the benchmark is fair. →
`02-instrumented-bench-harness.md`.

**3. The priority queue uses lazy deletion — the right call, named explicitly.**
`PQueue` (`features/routing/pqueue.ts`) is a plain binary min-heap with **no
decrease-key**. Instead, `search()` pushes a duplicate with the better priority
and skips stale pops with `if (closed.has(current)) continue;`
(`astar.ts:51`). This trades a few extra heap entries (cheap: O(log n) push) for
dropping the value→index bookkeeping a decrease-key needs. → `03-lazy-deletion-heap.md`.

**4. The render-time search runs synchronously on the single JS thread — bounded
by a debounce + single-flight pump, but still a real ceiling.** `MapScreen.tsx:143-154`
runs `directedAstar` inside a `useMemo`, so the search blocks the JS thread on
every relevant render. On the current 1621-node graph this is sub-millisecond, so
it's fine *today*. The defenses are real: `useTileGraph.ts` debounces region
changes (`DEBOUNCE_MS = 600`, line 30), runs **one graph build at a time** via the
`pump()` single-flight (lines 89-129), and caps loadable span
(`MAX_LOAD_SPAN_DEG`, `MAX_CORRIDOR_SPAN_DEG`). → `04-render-thread-search-debounce.md`.

**5. Elevation I/O is batched, deduped to DEM resolution, and degrades to flat.**
The build-time hot path is network I/O, not CPU. `pipeline/elevation.ts` batches
100 points/request for Open-Meteo (line 85), dedups multiple nodes into one DEM
cell (`sampleElevations`, lines 42-59), throttles between batches, and retries
429s with exponential backoff (lines 108-119). The mobile layer wraps it in
`bestEffortElevation` (`useTileGraph.ts:18-28`) — build flat rather than fail. →
`05-elevation-batching-and-dedup.md`.

**6. `nearestNode` is an O(N) un-indexed scan — the latent scaling cost.**
`features/routing/nearest.ts:5-18` does a full linear scan over every node for
every snap, and it's called **twice per render** in `MapScreen.tsx:125-126`
(start + end, both inside `useMemo`s). At 1621 nodes this is invisible. It's the
first thing that breaks if the graph grows to city scale — the fix is a spatial
index (grid/k-d tree), explicitly a spec stretch goal, **not yet built**. →
`06-linear-nearest-node-scan.md`.

## Measured vs illustrative

- **Measured (this machine, `npm run bench`, 2026-06):** all node-expansion,
  pushes, pops, ms, and cost figures in `01` and `02` come from a real run. The
  exact table:

```
  grid40 10,10->30,20 (mid interior)
  algorithm         expanded   pushes     pops       ms        cost
  dijkstra              1079     1141     1080     1.47     2400.00
  astar                  276      341      277     0.32     2400.00
  bidirectional          336      450      336     0.47     2400.00
  gradeAstar             660      732      661     0.60     4465.00
  directedAstar          747      792      748     1.04     4465.00
```

  ms figures are illustrative-by-nature (they vary run to run, sub-2ms on a tiny
  graph); the **expanded/pushes/pops/cost columns are deterministic** and
  reproduce exactly. The graph footprint (1621 nodes / 1879 edges / 544 KB) is
  measured from `mobile/assets/graph.json`.
- **Illustrative:** any latency at city scale, any p95/p99 claim — there is no
  production traffic to measure.

## `not yet exercised`

Named honestly so the audit doesn't manufacture findings:

- **No flame-graph / sampling profiler setup.** The only profiling is the
  bench's `performance.now()` wall-clock and the in-search counters. No
  `--prof`, no Chrome DevTools trace, no React render profiler wired in.
- **No production performance monitoring.** No RUM, no APM, no metrics export.
  The app has no backend and no telemetry.
- **No spatial index** for `nearestNode` (grid/k-d tree/R-tree) — spec stretch
  goal, not built.
- **Contraction Hierarchies / ALT** — named in the spec as the scale-up path
  beyond bidirectional A*; **not built**.
- **No latency budget / p95 target** is written down anywhere. The implicit
  budget is "feels instant in the hand," defended by the small bounded graph,
  not by a number.
- **No memory profiling.** Per-search scratch (`g`, `came`, `closed`, the
  rebuilt `byId` index) is allocated per call and named in `04`, but never
  measured under load.
