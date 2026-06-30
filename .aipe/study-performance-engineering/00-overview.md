# Performance Engineering — flattr, the one-page map

Here's the whole performance story of this repo in one frame, before any detail.

```
  flattr — where performance work actually lives

  ┌─ BUILD TIME (pipeline/, Node) ─────────────────────────────┐
  │  OSM → elevation → graph.json                              │
  │  ★ dedup to ~90m DEM cells · batch · backoff               │  ← I/O defense
  │     (pipeline/elevation.ts)                                 │
  └─────────────────────────────┬──────────────────────────────┘
                                │  ships graph.json (1621 nodes / 1879 edges)
  ┌─ CORE ENGINE (features/, pure TS) ─▼───────────────────────┐
  │  ★ A* heuristic pruning — MEASURED by bench/run.ts         │  ← the one
  │     3.9–7.4x fewer expansions than Dijkstra                │    quantified win
  │  · lazy-deletion heap (pqueue.ts)                          │
  │  · O(N) nearest-node scan (nearest.ts)  ← latent cliff     │
  └─────────────────────────────┬──────────────────────────────┘
                                │  imported by
  ┌─ MOBILE (mobile/src/, Expo + RN + MapLibre) ─▼─────────────┐
  │  ★ A* in useMemo on JS thread (MapScreen.tsx)             │  ← render-thread
  │  · single-flight pump, concurrency=1 (useTileGraph.ts)    │    search
  │  · 400ms geocode / 600ms viewport debounce                │  ← the throttle
  │  · persistent elevation cache (elevCache.ts)              │  ← rate-limit
  └────────────────────────────────────────────────────────────┘
```

## The verdict, first

flattr has **one measured performance win and a pile of well-reasoned-but-unmeasured
defenses**. The measured win is real and good: A* heuristic pruning, instrumented
by `bench/run.ts`, expands **3.9–7.4x fewer nodes than Dijkstra** over fixed
interior pairs (numbers from `npm run bench` on this machine). The defenses —
single-flight backpressure, elevation dedup + caching, debounced fetches, capped
retries — are all the right shapes for a self-powered routing app against free
APIs. But none of them is measured on a device. `performance.now()` lives in
exactly one file: `bench/run.ts`.

So the honest framing: **the optimization that's proven (search efficiency) isn't
the one a user feels; the one a user feels (route latency on a phone, jank while
panning) isn't proven.** That's the headline, and the cheapest high-leverage fix
in the whole repo.

## Ranked findings

1. **No on-device measurement** (HIGH) — `performance.now()` only in
   `bench/run.ts:24`. Every device-latency claim is `[inference]`. → `audit.md` R1.
2. **A\* on the JS render thread** (MED, scales to HIGH) — `MapScreen.tsx:151-162`,
   `useMemo`, no worker. Fine on the 1621-node base; unbounded as the merged graph
   grows. → `01-heuristic-pruning.md`, `audit.md` R2.
3. **O(N) nearest-node scan** (MED) — `nearest.ts:8-15`, re-run per graph rebuild.
   Latent scaling cliff; k-d tree fix. → `03-linear-nearest-node-scan.md`.
4. **`indexEdges()` rebuilt per search** (LOW) — `astar.ts:34`, 1879-entry Map per
   route. → `audit.md` R4.
5. **Zones p85 full sort** (LOW) — `zones.ts:6`, O(n log n) vs O(n) quickselect.
   → `04-zones-percentile-sort.md`.

## not yet exercised

- **Formal performance budgets** — no stated latency/fps targets; only fail-safe
  limit constants (`MAX_CORRIDOR_SPAN_DEG`, etc.). `audit.md` lens 1.
- **Latency distributions / p95 / p99** — single wall-ms per bench run, no
  histogram, no load test. `audit.md` lens 3.
- **Memory profiling** — no heap snapshot, no retention analysis. `audit.md` lens 4.
- **Bundle / startup / frame-rate measurement** — no RN performance
  instrumentation. `audit.md` lens 7.

## Reading order

1. `audit.md` — the 8-lens walk, every finding grounded in `file:line`.
2. `01-heuristic-pruning.md` — the measured win, with the bench numbers.
3. `02-single-flight-pump.md` — the backpressure shape.
4. `05-elevation-dedup-and-cache.md` — the real rate-limit defense.
5. `06-debounced-throttled-fetch.md` — the throttle layer.
6. `03-linear-nearest-node-scan.md` and `04-zones-percentile-sort.md` — the latent
   CPU cliffs.

## Cross-links to neighboring guides

- **`study-runtime-systems`** — owns the *execution mechanism* of the JS thread,
  the event loop, and `useMemo` timing. This guide measures the cost; runtime
  explains why A* on the render thread blocks paint.
- **`study-system-design`** — owns the architecture-scale tradeoff of the
  single-flight pump and the build-time/run-time split. This guide measures the
  bottleneck; system-design explains the boundary choice.
- **`study-dsa-foundations`** — owns A* / heaps / k-d trees as algorithms. This
  guide measures *which one wins on this graph*; dsa-foundations teaches the
  structures.
- **`study-networking`** — owns retry/backoff/timeout semantics against the
  elevation API. This guide measures the rate-limit defense; networking explains
  the protocol behavior.
