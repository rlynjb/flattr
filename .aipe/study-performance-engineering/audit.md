# Performance audit — flattr

Pass 1 of the performance-engineering study guide. One `##` section per lens.
Every claim is grounded in a `file:line` range. Where the repo has no evidence
for a lens, it says `not yet exercised` and names when the lens becomes
relevant. Inferences (runtime/on-device behavior not directly measured) are
labelled **[inference]**.

The one place this repo measures itself is `bench/run.ts`. The numbers below
come from `npm run bench` on this machine — they are real, not estimated, and
they are the spine of the whole guide.

```
  The measurement frontier of this repo

  ┌─ MEASURED ────────────────────────────────────────┐
  │  bench/run.ts — nodesExpanded / pushes / pops      │
  │  + performance.now() wall time, fixed node pairs   │
  │  → search efficiency is the ONE quantified surface │
  └────────────────────────────────────────────────────┘
  ┌─ NOT MEASURED ────────────────────────────────────┐
  │  on-device frame time · route latency on a phone   │
  │  · memory · bundle size · network p95 · cost/quota │
  │  → reasoned about in code comments, never timed    │
  └────────────────────────────────────────────────────┘
```

---

## 1. performance-budget

**No formal budget exists.** There is no stated target like "route in < 100ms"
or "60fps while panning" anywhere in the repo — not in `docs/flattr-spec.md`,
not in config, not in code. What exists instead is a set of **implicit budgets
encoded as constants**, each a guard against a specific blow-up:

- `mobile/src/useTileGraph.ts:67` — `MAX_CORRIDOR_SPAN_DEG = 0.12` (~13km):
  refuse to route endpoints farther apart than this. A hard ceiling on the
  graph size A* runs over.
- `mobile/src/useTileGraph.ts:69` — `MAX_LOAD_SPAN_DEG = 0.06`: don't fetch
  grade tiles when zoomed out past ~a few km. Caps fetch + build work per pan.
- `mobile/src/elevCache.ts:9` — `MAX_ENTRIES = 50000`: cap on the persisted
  elevation cache so it can't grow unbounded on disk.
- `pipeline/elevation.ts:62,85` — `GOOGLE_BATCH = 256`, `OPEN_METEO_BATCH = 100`:
  request-size ceilings matched to provider limits.

These are real budgets in the sense that crossing them changes behavior — but
they're **fail-safe limits, not performance targets**. Nothing measures whether
a route under 13km actually returns fast enough on a mid-range phone. That gap
is the honest headline of this audit. → see `01-heuristic-pruning.md` for the
one budget that *is* measured (search expansions).

## 2. measurement-baselines-and-profiling

**This is the repo's strongest lens — and it's narrow.** `bench/run.ts` is a
real instrumented benchmark: it runs five algorithm stages over three fixed
interior node pairs and prints expansions, pushes, pops, wall-ms, and path
cost (`bench/run.ts:36-56`). The instrumentation lives inside the search itself
— `search()` counts `nodesExpanded`, `pushes`, `pops` as it runs
(`features/routing/astar.ts:35-37,46,51,57-58,73`) and returns them on every
`SearchResult`. That's the right design: the metric is produced by the thing
being measured, not bolted on after.

Measured baseline (this machine, `npm run bench`):

```
  grid40 10,10->30,20 (mid interior)
  algorithm        expanded  pushes  pops    ms
  dijkstra            1079    1141   1080   1.45
  astar                276     341    277   0.33
  bidirectional        336     450    336   0.46
```

A* expands **3.9x fewer nodes than Dijkstra** here (1079/276); on the other two
pairs it's **6.3x** (203/32) and **7.4x** (74/10). This is a real before/after
with the heuristic as the independent variable. → see `01-heuristic-pruning.md`.

**What's missing:** the wall-ms is Node-on-laptop, not on-device. There is no
profiler config, no React DevTools profiling harness, no flame graph, no
on-device timer. `performance.now()` appears exactly once in the whole repo
(`bench/run.ts:24`). The mobile app never times its own A* call
(`mobile/src/MapScreen.tsx:151-162`), its graph builds, or its render. Profiling
the actual user-facing path is `not yet exercised`.

## 3. latency-throughput-and-tail-behavior

**No latency distribution is captured anywhere.** The bench prints a single
wall-ms per run (`bench/run.ts:25-26`), not a p50/p95/p99 over repeated runs, and
it runs on Node, not a device. There is no histogram, no tail analysis, no load
test.

Throughput *control* exists even though throughput isn't measured: the tile
pipeline is a **single-flight pump** — exactly one graph build runs at a time,
with the route corridor prioritized over the viewport
(`mobile/src/useTileGraph.ts:166-227`). That bounds concurrency to 1 against the
free Overpass/Open-Meteo APIs. It's the right backpressure shape, but its effect
(queue depth, wait time under rapid panning) is reasoned about in comments, never
timed. → see `02-single-flight-pump.md`.

The one tail-behavior fact worth naming: the elevation fetch has bounded retry
with exponential backoff (`pipeline/elevation.ts:108-119`, `retries` default 3,
sleep `delayMs * 2**(attempt+1)`), and the mobile caller deliberately sets
`retries: 1` (`mobile/src/useTileGraph.ts:191`) so a throttled build **fails fast
to flat-fallback** instead of stalling on doomed 429 backoffs. That's a
tail-latency decision (cap the worst case) made explicitly — but again,
unmeasured.

## 4. cpu-memory-and-allocation

**CPU:** the dominant CPU cost is the A* search, and it's the one thing that's
measured (lens 2). Two secondary CPU costs are visible and unoptimized:

- **Nearest-node snap is O(N)** — `features/routing/nearest.ts:8-15` scans every
  node with a haversine call to find the closest. The bundled base graph is
  **1621 nodes** (measured: `node -e` over `mobile/assets/graph.json`), and this
  runs inside a `useMemo` that re-fires whenever `graph` changes
  (`mobile/src/MapScreen.tsx:133-134`) — and `graph` is rebuilt on every tile
  merge. So a pan that loads a corridor re-snaps both endpoints over the now-larger
  merged node set. Latent scaling cliff. → see `03-linear-nearest-node-scan.md`.
- **Zones percentile via full sort** — `features/grade/zones.ts:5-14` sorts each
  cell's grade array to take p85, called per non-empty cell over a 16x16 grid
  (`mobile/src/MapScreen.tsx:23,125-128`). O(n log n) where a quickselect is O(n).
  → see `04-zones-percentile-sort.md`.

**Memory/allocation:** `indexEdges()` rebuilds a fresh `Map<string,Edge>` over
**all** graph edges on *every* search call (`features/routing/astar.ts:12-16,34`)
— allocated, used, thrown away each route. On the 1879-edge base graph that's a
1879-entry Map per A* run. Not yet a problem at this scale, but it's allocation
that scales with graph size, recreated per request. **[inference]** Garbage
collection behavior is not observed; RN/Hermes GC is not profiled.

There is no memory measurement of any kind — no heap snapshot, no retention
analysis.

## 5. io-network-and-database-bottlenecks

**No database.** The graph is a prebuilt static artifact
(`mobile/assets/graph.json`, 1621 nodes / 1879 edges) read once at startup
(`mobile/src/loadGraph.ts` via `MapScreen.tsx:28-34`). No SQL, no query layer.

The real I/O bottleneck is the **free elevation/Overpass APIs**, and the repo's
defenses against them are the most developed performance work after the bench:

- **Dedup to ~90m DEM cells** before fetching — `pipeline/elevation.ts:42-52`
  collapses all nodes in one `prec`-sized cell to a single query. Don't sample
  finer than the data's resolution.
- **Batching** — 100 points/request for Open-Meteo (`pipeline/elevation.ts:85`),
  256 for Google (`:62`).
- **Persistent AsyncStorage cache** keyed by DEM cell — `mobile/src/elevCache.ts`
  — so revisited areas need **zero** elevation requests and survive app restarts.
  This is the real rate-limit defense (`useTileGraph.ts:38-62` wraps the provider
  in `cachedElevation`). → see `05-elevation-dedup-and-cache.md`.
- **Best-effort degradation** — if elevation 429s, build with flat (0m) elevation
  rather than failing (`useTileGraph.ts:20-31`), then self-heal-retry later.

Network latency/throughput is not measured; the defenses are reasoned, the
external-data caveat (`.aipe/project/context.md`: Open-Meteo 429s under heavy
testing) confirms the throttle is real and hit in practice.

## 6. caching-batching-and-backpressure

The repo's densest performance lens. Every sub-pattern is present:

- **Caching** — persistent elevation cache (`elevCache.ts`), plus `coverage`
  checks that skip a fetch when an existing region already contains the bbox
  (`useTileGraph.ts:82-90,233-234`).
- **Batching** — elevation requests batched to provider limits
  (`elevation.ts:62,85`); cache writes debounced + batched
  (`elevCache.ts:8,39,42-57`).
- **Debounce/throttle** — autocomplete geocode debounced **400ms**
  (`MapScreen.tsx:73-89`), viewport grade-load debounced **600ms**
  (`useTileGraph.ts:64,254-255`), inter-batch elevation sleep 300-400ms
  (`elevation.ts:97,121`; `useTileGraph.ts:191`), cache persist debounced 4000ms
  (`elevCache.ts:8`). → see `06-debounced-throttled-fetch.md`.
- **Backpressure** — single-flight pump, concurrency = 1, corridor-priority
  (`useTileGraph.ts:166-227`); capped self-heal retries (`MAX_RETRIES = 6`,
  `:65,209`) so a sustained outage can't loop forever. → see
  `02-single-flight-pump.md`.

This lens is well-exercised *as design*. What's missing is the same gap as
everywhere: none of it is measured. No cache-hit-rate metric, no count of
requests saved, no queue-depth observation.

## 7. rendering-client-and-mobile-performance

The app is Expo / React Native with MapLibre (`mobile/src/MapScreen.tsx`). The
rendering-relevant performance facts:

- **A* runs on the JS thread, inside `useMemo`** — `MapScreen.tsx:151-162`. Every
  change to `graph`, `startId`, `endId`, or `userMax` recomputes the route
  synchronously on the render thread. No worker, no `InteractionManager`, no
  `requestIdleCallback`. **[inference]** On the measured 276-1079 expansion range
  at sub-2ms in Node, this is likely imperceptible on the base graph — but it's on
  the main thread, so a much larger merged graph would jank the UI. Unmeasured on
  device.
- **Heatmap/zones computed on demand only** — `MapScreen.tsx:121-129` gates
  `graphToGeoJSON` and `computeZones` behind `view === "edges"/"zones"`, so the
  default clean map does zero grade work. Good: work avoided is the cheapest work.
- **GeoJSON rebuilt in `useMemo`** keyed on the inputs that actually change
  (`MapScreen.tsx:121-129`), so React doesn't recompute the feature collections
  on unrelated renders.

No bundle-size analysis, no startup-time measurement, no frame-rate capture, no
`react-native-performance` instrumentation. Rendering performance is reasoned
about structurally (keep work off the default path, memoize) but never profiled.

## 8. performance-red-flags-audit

Ranked by consequence, with the evidence (or the missing measurement) named.

```
  Risk ladder — consequence × likelihood

  HIGH ┌──────────────────────────────────────────────┐
       │ R1  No on-device measurement at all           │
       │     evidence: performance.now() only in bench │
       │     → every device claim is [inference]        │
       ├──────────────────────────────────────────────┤
       │ R2  A* on JS thread in useMemo (MapScreen:151) │
       │     → janks UI if merged graph grows large     │
  MED  ├──────────────────────────────────────────────┤
       │ R3  O(N) nearest-node scan (nearest.ts:8)      │
       │     re-run per graph change; 1621→N nodes      │
       │     → latent cliff; k-d tree is the fix        │
       ├──────────────────────────────────────────────┤
       │ R4  indexEdges() rebuilt per search            │
       │     (astar.ts:34) → 1879-entry Map per route   │
  LOW  ├──────────────────────────────────────────────┤
       │ R5  zones p85 full sort (zones.ts:6)           │
       │     → O(n log n) vs O(n) quickselect           │
       └──────────────────────────────────────────────┘
```

**R1 — No on-device measurement (HIGH).** The bench measures search efficiency on
Node; nothing measures the user-visible path on a phone. Route latency, frame
time during pan, graph-build time, startup, memory — all unmeasured. Evidence:
`performance.now()` appears only at `bench/run.ts:24`. This is the honest top
finding: the optimization that *is* done (heuristic pruning) is proven; the
optimization that *would matter to a user* (does it feel fast on my phone?) is
unproven. The fix is cheap — wrap the `directedAstar` call and the `buildGraph`
call in a timer and log p50/p95 — and it's the single highest-leverage move.

**R2 — Synchronous A* on the render thread (MED, could be HIGH at scale).**
`MapScreen.tsx:151-162` runs `directedAstar` in a `useMemo` on the JS thread.
Measured cost on the base graph is tiny (sub-2ms in Node, lens 2), so it's
**[inference]** fine today. The risk is unbounded: the merged routing graph grows
with every loaded corridor/viewport tile (`useTileGraph.ts:132-145`), and there's
no cap on merged node count the way there's a cap on *span*. A 13km corridor in a
dense city could merge a much larger graph than the 1621-node base. Mitigated by
`MAX_CORRIDOR_SPAN_DEG`, not eliminated.

**R3 — O(N) nearest-node scan (MED).** `nearest.ts:8-15` is a linear scan, run in
two `useMemo`s (`MapScreen.tsx:133-134`) that re-fire on every `graph` rebuild.
At 1621 base nodes it's cheap; the cliff is that it scales linearly with the
merged graph and runs on the same render thread as R2. k-d tree or a spatial grid
is the standard fix. → `03-linear-nearest-node-scan.md`.

**R4 — `indexEdges()` per search (LOW).** `astar.ts:34` allocates a fresh
1879-entry `Map` on every search call. Cheap now, but it's per-request allocation
that scales with edge count. Could be built once and cached on the graph object.

**R5 — Zones percentile full sort (LOW).** `zones.ts:6` sorts to take p85;
quickselect is O(n). Only runs in zones view, over a 16x16 grid, so the per-cell
arrays are small. Lowest-priority; named for completeness. →
`04-zones-percentile-sort.md`.

**Where backpressure is correctly handled (not a red flag):** the single-flight
pump (`useTileGraph.ts:166-227`) and capped retries are the right shape and the
measured-by-design defenses against the only real external bottleneck (the free
elevation API). The gap there is measurement, not design.
