# Performance audit — flattr (Pass 1)

Eight lenses, one section each. For each: what the codebase actually does, with
`file:line` grounding, or `not yet exercised`. Significant findings cross-link to
their Pass 2 pattern file.

---

## 1. performance-budget

There is **no written budget** — no p95 target, no ms ceiling, no bundle-size
limit in any config. The implicit budget is two things, both defended by
*bounding the input* rather than by a number:

- **"A route feels instant in the hand."** Defended by capping the graph to a
  neighborhood. The bundled artifact (`mobile/assets/graph.json`) is **1621
  nodes / 1879 edges / 544 KB** — small enough that `directedAstar` finishes
  sub-millisecond on a tiny grid (see the measured bench table in
  `00-overview.md`). The search runs synchronously in `MapScreen.tsx:143-154`,
  so "instant" is held by the graph being small, not by async work.
- **"Don't melt the free API tiers."** Defended by hard span caps:
  `MAX_LOAD_SPAN_DEG = 0.06` (`useTileGraph.ts:34`) refuses to load when zoomed
  out past a few km; `MAX_CORRIDOR_SPAN_DEG = 0.12` (~13 km, line 31) refuses
  routes that are too far apart. These are the budget made into code.

The honest read: the budget is real but **unstated as a number**. The right next
move is to write down "route resolves in < X ms at the bundled graph size" and
assert it in the bench, so a regression is caught.

## 2. measurement-baselines-and-profiling

**This is the repo's strongest lens.** It has a real harness, real instrumentation,
and a baseline-vs-improvement comparison built in.

- **Instrumentation lives inside the search loop**, so it counts logical work,
  not noisy wall-clock: `nodesExpanded` increments at `astar.ts:62`, `pushes` at
  `astar.ts:46,73`, `pops` at `astar.ts:50`. These ride out on every
  `SearchResult` (`types.ts:45-51`).
- **The baseline is Dijkstra; the improvement is A*.** `bench/run.ts:36-42` runs
  all five stages over fixed pairs; `bench/report.ts:19-37` prints them as an
  aligned comparison table. `bench/report.test.ts` asserts the table renders.
- **The workload is chosen to be fair.** `bench/run.ts:16-21` uses *interior*
  node pairs and documents why corner-to-corner would be degenerate (the goal is
  the farthest node → nothing can be pruned → A* can't win). That's a real
  understanding of what makes a search benchmark honest.
- **Profiler:** only `performance.now()` wall-clock (`bench/run.ts:23-27`). **No
  flame graph, no sampling profiler, no React render profiler** — `not yet
  exercised`.

→ The deep walk: `02-instrumented-bench-harness.md`. The thing being measured:
`01-heuristic-pruning.md`.

## 3. latency-throughput-and-tail-behavior

Single-user, single-shot. There is **no throughput dimension** (no concurrent
queries, no request queue, no server) and therefore **no p95/p99 tail** to
measure — `not yet exercised` for tail behavior.

What *is* present is per-query latency expressed as **nodes expanded**, which is
the input-size-independent proxy for latency in a graph search. Measured (grid40
mid-interior): Dijkstra 1079 expanded / 1.47 ms; A* 276 / 0.32 ms; the ~4× fewer
expansions is the latency win. Tail behavior in the *app* is shaped not by the
search but by the **network builds** (Overpass + Open-Meteo), which are serialized
one-at-a-time through the `pump()` (`useTileGraph.ts:89-129`) — so the worst case
is "one build in flight, others queued," bounded by design, not measured.
→ `01-heuristic-pruning.md`, `04-render-thread-search-debounce.md`.

## 4. cpu-memory-and-allocation

CPU: the search is the only meaningful CPU consumer, and it's bounded by nodes
expanded (lens 3). One real per-call cost worth naming: **`indexEdges` rebuilds
the id→edge `Map` on every search** (`astar.ts:33` calls `indexEdges` at
`astar.ts:12-16`), and `bidirectional` does the same (`bidirectional.ts:27`). For
1879 edges that's negligible, but it's recomputed scratch, not cached on the
graph.

Memory: per-search scratch is `g`, `came`, `closed`, `open` plus the rebuilt
`byId` index (`astar.ts:30-36`). All are bounded by graph size and freed when the
search returns — no retention, no leak surface. The biggest standing allocation
is the merged graph itself: `mergeGraphs` + `stitchGraph` (`tiles.ts:45-108`)
rebuild whole node/edge/adjacency objects in a `useMemo` (`useTileGraph.ts:72-85`)
every time a tile loads, and `prefixGraph` (`tiles.ts:21-38`) clones every node
and edge to re-key ids. **No GC tuning, no allocation profiling** — `not yet
exercised`. → `04-render-thread-search-debounce.md`, `06-linear-nearest-node-scan.md`.

## 5. io-network-and-database-bottlenecks

No database. The I/O bottleneck is **build-time network**: Overpass (street
geometry) and the Open-Meteo elevation API. This is the dominant cost of growing
coverage, and it's the most carefully optimized I/O path in the repo:

- **Batching:** Open-Meteo at 100 points/request (`elevation.ts:85`), Google at
  256/request (`elevation.ts:62`).
- **Dedup to DEM resolution:** `sampleElevations` (`elevation.ts:42-59`) collapses
  nodes that fall in the same ~90 m grid cell into a single query — don't sample
  finer than the data resolution, and stay under request limits.
- **Throttle + backoff:** `delayMs` between batches, exponential backoff on 429
  (`elevation.ts:108-121`).
- **Degrade, don't fail:** `bestEffortElevation` (`useTileGraph.ts:18-28`)
  returns flat (0 m) elevation if the API throttles, so streets still render and
  routing still connects.
- **Geocode serialized:** `MapScreen.tsx:181` resolves From then To sequentially
  with a comment "Nominatim allows ~1 req/sec."

→ `05-elevation-batching-and-dedup.md`.

## 6. caching-batching-and-backpressure

All three present, in the mobile tile layer:

- **Caching (coverage memoization):** `covers()` / `bboxContains()`
  (`useTileGraph.ts:45-53`) skip a fetch when the base graph or current viewport
  already contains the requested bbox (`useTileGraph.ts:140-142`,
  `ensureBbox:160`). The bundled base graph is itself a cache — the common area
  never hits the network.
- **Batching:** elevation (lens 5) and the whole-viewport-in-one-build decision
  (`useTileGraph.ts:1-7` comment) — one graph build for the visible screen
  instead of dozens of per-tile round-trips.
- **Backpressure / bounded work:** the **`pump()` single-flight**
  (`useTileGraph.ts:89-129`) runs exactly one build at a time and drains the next
  from a pending slot; the **debounce** (`DEBOUNCE_MS = 600`, line 30, applied at
  `onRegionDidChange:138-148`) collapses a burst of pan events into one fetch;
  the **span caps** (lens 1) refuse oversized work outright. The corridor request
  gets **priority** over the viewport (lines 92-100) so a pending route isn't
  starved by panning.

→ `04-render-thread-search-debounce.md`, `05-elevation-batching-and-dedup.md`.

## 7. rendering-client-and-mobile-performance

The client is Expo / React Native (`mobile/`), rendering with
`@maplibre/maplibre-react-native`. The performance-relevant rendering facts:

- **GeoJSON is rebuilt on `userMax` change.** `heatmap` (`MapScreen.tsx:116-119`)
  re-runs `graphToGeoJSON` whenever `userMax` or `graph` changes — it maps over
  every edge (`geojson.ts:20-34`). `zonesFC` (`MapScreen.tsx:121`) re-runs on
  `userMax` too. Moving the slider re-derives the whole edge collection. On 1879
  edges this is cheap; it's the rebuild-on-knob-turn pattern to watch as the graph
  grows. `zoneCells` is correctly memoized on `graph` alone (line 120) so it
  doesn't recompute on slider moves.
- **The route search is synchronous on the JS thread** (`MapScreen.tsx:143-154`)
  — see lens 4 and `04`.
- **Distinct source `key` per view branch** (`MapScreen.tsx:265-275` comment):
  MapLibre freezes source/layer ids, so React must unmount/remount on toggle.
  This is correctness, with a re-mount cost on every edges↔zones toggle.
- **No bundle-size analysis, no startup-time measurement, no FPS/jank profiling**
  — `not yet exercised`.

→ `04-render-thread-search-debounce.md`.

## 8. performance-red-flags-audit

Ranked by consequence, each with its evidence or its explicitly-missing
measurement.

1. **O(N) `nearestNode` scan, called twice per render** — `nearest.ts:5-18`,
   invoked at `MapScreen.tsx:125-126`. *Evidence:* linear in node count; **no
   measurement of the snap cost in isolation** (it's folded into render). Latent:
   fine at 1621 nodes, the first wall at city scale. Fix (spatial index) **not
   built**. → `06-linear-nearest-node-scan.md`.
2. **Synchronous render-time A* on the single JS thread** — `MapScreen.tsx:143-154`.
   *Evidence:* sub-ms today (measured bench, tiny graph); **no main-thread
   blocking measured** under a large graph. Mitigated by graph bounding + debounce.
   → `04-render-thread-search-debounce.md`.
3. **Per-search index rebuild** (`indexEdges` at `astar.ts:33`,
   `bidirectional.ts:27`) and **per-merge graph clone** (`prefixGraph` /
   `mergeGraphs` / `stitchGraph`, `tiles.ts:21-108`, in a `useMemo` at
   `useTileGraph.ts:72-85`). *Evidence:* recomputed scratch; **no allocation
   profiling**. Cheap now, grows with edge count.
4. **GeoJSON rebuild on every `userMax` change** — `MapScreen.tsx:116-119`.
   *Evidence:* full edge map per slider move; cheap at 1879 edges, **unmeasured**
   at scale.
5. **No written latency budget and no profiler** — lens 1, lens 2. *Evidence:*
   absence. The risk is regression invisibility: a future change that doubles
   expansions wouldn't fail any check, because the bench prints a table but
   **asserts nothing about the numbers** (`report.test.ts` only checks
   formatting).
