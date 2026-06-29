# Performance Engineering — flattr (overview)

The one-page map. Read this, then `audit.md`, then the pattern files in order.

## The verdict, first

flattr is **half a performance-engineering story, and it's the harder half that's
strong.** The optimization side — heuristic pruning, batching, caching,
backpressure — is real and, in one case, actually *measured*. The measurement
side — budgets, profiling, on-device timing — barely exists. There is exactly one
instrument in the repo (`bench/run.ts`) and it measures algorithmic work in Node,
not latency on a phone.

So the honest framing for an interview: *"I can prove A* expands 4–7x fewer nodes
than Dijkstra because I instrumented it. I cannot yet prove the app hits a frame
budget on a device, because I never measured that — and I know that's the gap."*

## Where performance work lives

```
  flattr performance surface — layers and the work in each

  ┌─ UI / render (JS thread) ─────────────────────────────────┐
  │  MapScreen.tsx                                             │
  │   • directedAstar() in useMemo  ← search ON the JS thread  │
  │   • heatmap/zones GeoJSON in useMemo (gated by view)       │
  │   • 400ms autocomplete debounce                            │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Coordination / backpressure ─────────────────────────────┐
  │  useTileGraph.ts                                           │
  │   • single-flight pump (one build at a time)              │
  │   • 600ms region debounce · spatial work ceilings         │
  │   • merge/stitch graph (re-alloc per tile)               │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Algorithm core (measured by bench) ──────────────────────┐
  │  features/routing/  astar.ts · pqueue.ts · nearest.ts     │
  │   • A* heuristic pruning   • lazy-deletion heap           │
  │   • O(N) nearest-node scan                                │
  │  features/grade/  zones.ts (percentile via full sort)     │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ I/O / external (rate-limited free APIs) ─────────────────┐
  │  elevation.ts (batch+backoff) · elevCache.ts (persist)   │
  │  overpass.ts · geocode.ts (~1 req/s)                      │
  └───────────────────────────────────────────────────────────┘
```

## Ranked findings (from `audit.md` lens 8)

| # | finding | evidence | file |
|---|---------|----------|------|
| 1 | No on-device latency measurement | `performance.now` only in bench | `bench/run.ts:24` |
| 2 | A* runs synchronously on JS thread | search in `useMemo`, no yield | `MapScreen.tsx:151` |
| 3 | O(N) nearest-node scan (latent cliff) | linear loop over all nodes | `nearest.ts:8` |
| 4 | Full sort to read one percentile | `[...v].sort()` for p85 | `zones.ts:8` |
| 5 | Whole-graph re-alloc per tile load | merge+stitch+prefix copy | `tiles.ts:89` |
| 6 | `indexEdges` rebuilt per search | O(E) Map per call (deliberate) | `astar.ts:33` |

## Measured baseline (the one real number)

`npm run bench`, **[measured]**, mid-interior grid40 pair:

```
  algorithm     expanded   cost      vs dijkstra
  dijkstra         1079    2400      1.0x  (baseline)
  astar             276    2400      3.9x fewer expansions
  bidirectional     336    2400      3.2x fewer
```

Across all three test pairs: A* is **3.9x–7.4x** fewer expansions than Dijkstra
for identical optimal cost. This is the before/after that any heuristic change
must move.

## What's `not yet exercised`

- **Throughput / p95 / p99 over a request population** — single-user app, no
  server, no request population to take a percentile of.
- **Database bottlenecks** — graph is a static 532 KB artifact; no DB, no queries.
- **Profiling** — no flame graphs, no `--prof`, no React profiler harness.
- **Formal budgets** — limits exist as constants, never as stated targets.

## Reading order

1. `audit.md` — the 8-lens walk, full grounding.
2. `02-heuristic-pruning.md` — the measured win. A* vs Dijkstra.
3. `03-lazy-deletion-heap.md` — the heap, and the pops/expanded decrease-key trigger.
4. `04-linear-nearest-node.md` — the latent scaling cliff and the k-d tree fix.
5. `05-single-flight-pump.md` — bounded concurrency / backpressure.
6. `06-percentile-via-sort.md` — the O(n) quickselect upgrade.
7. `07-elevation-batching-and-cache.md` — the rate-limit defense.
8. `08-render-thread-search-and-debounce.md` — the throttle that keeps it usable, and the JS-thread risk.

## Cross-links

- **`study-runtime-systems`** — the JS-thread execution model, the event loop the
  A* search blocks, bounded work and cancellation mechanics.
- **`study-system-design`** — the tile-coverage architecture and build-time vs
  device-time split at scale.
- **`study-dsa-foundations`** — the heap, A*, and k-d tree as data structures in
  their own right (you've built the heap and Dijkstra already).
