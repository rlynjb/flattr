# Performance audit — flattr

Pass 1 of the two-pass study. One `##` per lens. Every claim is grounded in a
`file:line`. Where flattr does not exercise a lens, it says `not yet exercised`
and names when it would start to matter. Inferences about device/runtime
behavior are labelled **[inferred]** — flattr has no on-device timing, so any
claim about wall-clock latency on a phone is reasoning, not measurement.

The one piece of real instrumentation is `bench/run.ts`. Numbers below that
come from it are **[measured]** and reproduce with `npm run bench`.

```
  Where work happens in flattr — three time zones

  ┌─ BUILD TIME (once, offline) ──────────────────────────────┐
  │  pipeline/run-build.ts → graph.json (532 KB, 1621 nodes,  │
  │  1879 edges). OSM + elevation → static artifact.          │
  └───────────────────────────────────────────────────────────┘
  ┌─ BENCH TIME (CI / dev, instrumented) ─────────────────────┐
  │  bench/run.ts counts nodesExpanded / pushes / pops + ms   │
  │  over fixed interior grid pairs. The ONLY measurement.    │
  └───────────────────────────────────────────────────────────┘
  ┌─ DEVICE TIME (per interaction, NOT instrumented) ─────────┐
  │  MapScreen.tsx: A* in useMemo on the JS thread;           │
  │  useTileGraph.ts: debounced tile fetch + build;           │
  │  elevation/geocode network. No timing captured. [gap]     │
  └───────────────────────────────────────────────────────────┘
```

---

## 1. performance-budget

**No formal, written performance budget exists.** There is no "route in < X ms",
no "p99 < Y", no frame-budget constant, no bundle-size ceiling anywhere in the
repo. Grep for `budget|p95|p99|fps` returns nothing in source.

What exists instead are **implicit budgets encoded as constants** — limits chosen
to keep the app usable and under free-tier rate limits, but never written down as
targets with measured pass/fail:

- `MAX_LOAD_SPAN_DEG = 0.06` (`mobile/src/useTileGraph.ts:69`) — refuse to load
  grade tiles when zoomed out past ~a few km. A spatial work ceiling.
- `MAX_CORRIDOR_SPAN_DEG = 0.12` (`useTileGraph.ts:66`) — refuse routes wider than
  ~13 km. A bound on the largest graph A* will ever traverse.
- `MAX_ENTRIES = 50000` (`mobile/src/elevCache.ts:9`) — cap on the persisted
  elevation cache. A memory/storage ceiling.
- `DEBOUNCE_MS = 600` (`useTileGraph.ts:64`), 400 ms suggest debounce
  (`MapScreen.tsx:88`) — interaction-rate ceilings (see lens 6).

**Verdict:** budgets are *latent in constants*, not *stated as targets*. The gap:
nobody can say whether a route on the device meets a target, because there is no
target and no device measurement. The bench gives a CPU-work proxy (expansions),
not a wall-clock budget. → ranked in lens 8.

---

## 2. measurement-baselines-and-profiling

**One real instrument: `bench/run.ts`.** This is the strongest performance
artifact in the repo and the spine of this whole study.

- It runs five algorithm stages (`dijkstra`, `astar`, `bidirectional`,
  `gradeAstar`, `directedAstar`) over **three fixed interior node pairs** on
  grid fixtures of size 30 and 40 (`bench/run.ts:17-21`).
- It counts `nodesExpanded`, `pushes`, `pops` (threaded through
  `SearchResult` in `features/routing/astar.ts:35-37`, `48-77`) and wall-clock
  `ms` via `performance.now()` (`bench/run.ts:24-26`).
- It deliberately uses **interior pairs, not corner-to-corner**
  (`bench/run.ts:15-16`): corner-to-corner makes the goal the farthest node, so
  Dijkstra floods the whole graph and *nothing can be pruned* — a degenerate
  baseline that would hide A*'s win. Choosing a representative workload is itself
  the measurement discipline. → see `02-heuristic-pruning.md`.

**Measured baseline** (`npm run bench`, this machine, **[measured]**):

```
  grid40 10,10->30,20 (mid interior)
  algorithm        expanded  pushes  pops    cost
  dijkstra            1079    1141   1080    2400   ← baseline (no heuristic)
  astar                276     341    277    2400   ← 3.9x fewer expansions
  bidirectional        336     450    336    2400
```

Across the three pairs A* expands **3.9x–7.4x fewer** nodes than Dijkstra for the
*same* optimal cost. That ratio is the before/after evidence a heuristic change
should move.

**What's missing:** no profiler is ever run (no `--prof`, no React DevTools
profiler harness, no flame graphs), and **on-device timing is not captured at
all** — the `ms` column is Node on a dev machine, not the JS thread on a phone.
`performance.now()` appears only in the bench (`bench/run.ts:24`), never in
`mobile/`. So the bench measures *algorithmic work*, which is portable, but not
*device latency*, which is what the user feels. → ranked #1 gap in lens 8.

---

## 3. latency-throughput-and-tail-behavior

flattr is a **single-user, single-request-at-a-time** app. There is no server,
no concurrent request load, no RPS, so classical throughput / p95 / p99 over a
request population **is not yet exercised** — there is no population to take a
percentile of.

What *does* exist is tail behavior in two narrower senses:

- **Search-cost tail by query shape.** The bench's interior/corner distinction
  (`bench/run.ts:15`) is exactly a tail-vs-typical observation: the corner case
  is the worst case where the heuristic buys nothing. The `MAX_CORRIDOR_SPAN_DEG`
  guard (`useTileGraph.ts:66`) caps that tail by refusing the widest routes.
- **Lazy-deletion pop tail.** `pops` can exceed `nodesExpanded` because stale
  duplicate entries sit in the heap until popped and skipped
  (`astar.ts:51`). On the measured near-Euclidean grid pops barely exceed
  expanded (1080 vs 1079 — almost 1:1), so the tail is *not currently realized*;
  on a graph with heavy re-relaxation it would grow. The pops/expanded ratio is
  the trigger to consider decrease-key. → see `03-lazy-deletion-heap.md`.

**Throughput** in the sense that matters here is the **tile-build pipeline's
single-flight pump** (`useTileGraph.ts:166-227`): exactly one graph build runs at
a time, corridor before viewport. That bounds concurrency to 1, which is the
overload-control story (lens 6), not a throughput-maximization one. →
`05-single-flight-pump.md`.

---

## 4. cpu-memory-and-allocation

**CPU.** The dominant CPU cost is the A* search itself, run synchronously inside
a `useMemo` on the JS thread (`MapScreen.tsx:151-162`). Cost is governed by
`nodesExpanded` (lens 2). Secondary CPU costs, all per-interaction:

- `nearestNode` is a full **O(N) linear scan** over every node, run twice (start
  and end) on every endpoint or graph change (`features/routing/nearest.ts:8-15`,
  called at `MapScreen.tsx:133-134`). At 1621 nodes it's cheap; it's a scaling
  cliff, not a current cost. → `04-linear-nearest-node.md`.
- `computeZones` sorts each cell's grades via `percentile` →
  `[...values].sort()` (`features/grade/zones.ts:8`) — full sort to read one
  p85. O(n log n) where O(n) quickselect would do. → `06-percentile-via-sort.md`.
- `indexEdges` rebuilds the id→edge `Map` on **every** search call
  (`astar.ts:33`, built fresh each `search`) — O(E) per route. Deliberate
  (it makes expansion O(1) per edge instead of O(E)), but rebuilt rather than
  cached across calls.

**Memory / allocation.** The merged routing graph is rebuilt by value on every
tile change: `mergeGraphs` `Object.assign`s all nodes and spreads all edges
(`features/map/tiles.ts:89-108`), and `stitchGraph` copies the edge array and
adjacency again (`tiles.ts:55-57`). `prefixGraph` allocates a fresh copy of every
node and edge (`tiles.ts:21-38`). Each pan that loads a tile re-allocates the
whole merged graph. **[inferred]** at base size (1621 nodes) this is a sub-frame
allocation; it grows linearly with loaded area and is the allocation hotspot to
watch. The elevation cache is bounded at 50k entries (`elevCache.ts:9`).

**GC:** no manual GC management; standard JS engine GC. Not instrumented.

---

## 5. io-network-and-database-bottlenecks

**No database.** The graph is a prebuilt static artifact (`mobile/assets/graph.json`,
532 KB) read once via `loadGraph` (`mobile/src/loadGraph.ts`). No SQL, no query
plans — so DB bottlenecks are `not yet exercised`.

**The real bottleneck is external network I/O against free, rate-limited APIs.**
Three external dependencies, each with throttling as the binding constraint:

- **Open-Meteo elevation** (`pipeline/elevation.ts:92-126`): batches of 100
  points (`OPEN_METEO_BATCH = 100`, `elevation.ts:85`), `delayMs` throttle
  between batches, exponential backoff on 429 (`elevation.ts:114-117`). On the
  device this is wrapped in dedup + persistent cache + best-effort fallback
  (`useTileGraph.ts:36-62`, `20-31`). The persistent `AsyncStorage` cache
  (`elevCache.ts`) is the actual rate-limit defense — revisited areas make zero
  requests. → `07-elevation-batching-and-cache.md`.
- **Overpass (OSM streets)** (`pipeline/overpass.ts`, called
  `useTileGraph.ts:186`): one fetch per tile build, gated by the single-flight
  pump so at most one is in flight. → `05-single-flight-pump.md`.
- **Nominatim geocode** (`pipeline/geocode.ts`): ~1 req/sec policy
  (`geocode.ts:2`); the From/To geocodes are issued **sequentially** on purpose
  (`MapScreen.tsx:189` comment "Nominatim allows ~1 req/sec"), and autocomplete
  is debounced 400 ms (`MapScreen.tsx:80-88`).

The known operational failure mode is documented in project context: Open-Meteo
429s when quota is exhausted by heavy testing. The build degrades to flat (0 m)
elevation rather than failing (`useTileGraph.ts:20-31`) and self-heals on retry.

---

## 6. caching-batching-and-backpressure

This is flattr's **strongest** performance area — it has all three.

- **Caching:** two-layer elevation cache. In-memory `Map` + persistent
  `AsyncStorage`, keyed by ~90 m DEM cell so sub-cell points share a value
  (`elevCache.ts`, `useTileGraph.ts:36-62`). Writes debounced 4 s and batched
  (`elevCache.ts:8,39,42-57`). DEM values never change, so entries are valid
  forever — a near-ideal cache. → `07-elevation-batching-and-cache.md`.
- **Batching:** elevation requests batched 100/req (`elevation.ts:85`), and the
  build-time dedup collapses many graph nodes to one sample per ~90 m cell
  (`pipeline/elevation.ts:42-52`) — fewer points before they ever hit the
  network.
- **Debounce / throttle:** region pans debounced 600 ms (`useTileGraph.ts:64,
  254-255`); address autocomplete debounced 400 ms (`MapScreen.tsx:80-88`);
  inter-batch elevation throttle (`elevation.ts:97`). These are the knobs that
  keep the app usable while panning. → `08-render-thread-search-and-debounce.md`.
- **Backpressure / bounded work:** the **single-flight pump**
  (`useTileGraph.ts:166-227`) — one build at a time, corridor prioritized over
  viewport, next request drained in `finally`. Capped self-heal retries
  (`MAX_RETRIES = 6`, `useTileGraph.ts:65,209`). Spatial work ceilings
  (`MAX_LOAD_SPAN_DEG`, `MAX_CORRIDOR_SPAN_DEG`). → `05-single-flight-pump.md`.

---

## 7. rendering-client-and-mobile-performance

This is where flattr's biggest **[inferred]** risk lives, and it's honest to flag
it as unmeasured.

- **A* runs on the JS thread, synchronously, inside `useMemo`**
  (`MapScreen.tsx:151-162`). React Native has one JS thread; while
  `directedAstar` runs, nothing else on it runs — gestures queued, no frame
  callbacks. At base graph size (measured ~0.3–1.6 ms in Node for comparable
  expansion counts) this is invisible. On a large merged corridor graph on a
  mid-range phone it could blow the 16 ms frame budget. **There is no
  `InteractionManager`, no worklet, no measurement** — so this is reasoned, not
  observed. → `08-render-thread-search-and-debounce.md`.
- **GeoJSON regeneration:** `graphToGeoJSON` (heatmap) and `computeZones` +
  `zonesToGeoJSON` run in `useMemo`s gated on `view` so they only compute when
  their layer is visible (`MapScreen.tsx:121-129`). On-demand by default — the
  map stays clean and does no grade work when grades are off.
- **Bundle / startup:** 532 KB `graph.json` bundled as an asset
  (`mobile/assets/graph.json`), parsed once. No code-splitting, no startup
  timing measured. Standard Expo bundle; not analyzed.
- **MapLibre source keying:** distinct React `key` per view branch because
  MapLibre freezes source/layer `id` (`MapScreen.tsx:283-295`) — a correctness
  workaround with a re-mount cost, not currently a measured problem.

---

## 8. performance-red-flags-audit

Ranked by consequence. Each names its evidence — a measured baseline or an
explicitly missing measurement.

**1. No on-device latency measurement at all. [missing measurement — highest]**
The bench measures algorithmic work in Node; the JS-thread cost of A* on a phone
over a large merged graph is never timed. The whole "is it fast enough" question
is unanswerable today. Evidence: `performance.now()` appears only at
`bench/run.ts:24`, never in `mobile/`. Fix: wrap the `routed` useMemo and the
tile build in timing, log p50/p95 per session. Until then, lens 1 and lens 7
verdicts are inference.

**2. A* on the JS thread, synchronous, no yield. [inferred risk]** If a corridor
graph grows large, `directedAstar` (`MapScreen.tsx:155`) can exceed the 16 ms
frame budget and jank the map. Bounded today only by `MAX_CORRIDOR_SPAN_DEG`
(`useTileGraph.ts:66`), which limits graph size *indirectly*. No direct mitigation
(no chunking, no worklet). → `08-render-thread-search-and-debounce.md`.

**3. O(N) nearest-node scan. [latent scaling cliff]** `nearestNode`
(`nearest.ts:8-15`) scans every node, twice per route, on every graph change. At
1621 nodes it's free; at 100k+ it's the bottleneck. A k-d tree or grid index is
the known fix. Not a problem now — a problem the moment coverage scales. →
`04-linear-nearest-node.md`.

**4. Full sort to read one percentile. [measurable waste]** `percentile`
(`zones.ts:8`) sorts the whole array for p85; quickselect is O(n) vs O(n log n).
Per-cell arrays are small, so the absolute cost is low — flagged as the clean
O(n) upgrade, not a fire. → `06-percentile-via-sort.md`.

**5. Whole-graph re-allocation per tile load. [allocation pressure, unmeasured]**
`mergeGraphs` + `stitchGraph` + `prefixGraph` (`tiles.ts`) rebuild the entire
merged graph by value on every tile change. Linear in loaded area; fine at base
size, grows with panning. No allocation profiling done.

**6. `indexEdges` rebuilt per search. [minor, deliberate]** O(E) Map rebuild on
every `search` call (`astar.ts:33`). Bought O(1) edge lookup; could be cached
across calls on a stable graph. Lowest priority.

**Honest summary:** flattr's *batching, caching, and backpressure* are genuinely
well-built and the *algorithmic* progression is genuinely measured. The gap is
the other half of performance engineering — **no budgets, no profiling, no
on-device timing.** The bench proves A* beats Dijkstra in expansions; nothing
proves the app hits a frame or latency target on a real device.
