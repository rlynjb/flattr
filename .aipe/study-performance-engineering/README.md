# Study — Performance Engineering (flattr)

Measurement and optimization of flattr: what's measurably slow or expensive,
why, and which change improves it without moving the bottleneck.

This is an **audit-style** guide: one fixed audit walking 8 performance lenses,
plus discovered-pattern files for the patterns flattr actually exercises.

## Reading order

1. **`00-overview.md`** — the verdict, the map, ranked findings, the one measured baseline.
2. **`audit.md`** — Pass 1: the 8-lens audit, fully grounded in `file:line`.
3. Pattern files (Pass 2), in dependency order:
   - **`02-heuristic-pruning.md`** — A* vs Dijkstra; the measured win.
   - **`03-lazy-deletion-heap.md`** — the binary heap; pops vs expanded as the decrease-key trigger.
   - **`04-linear-nearest-node.md`** — O(N) snap; the latent scaling cliff; k-d tree fix.
   - **`05-single-flight-pump.md`** — bounded concurrency / backpressure.
   - **`06-percentile-via-sort.md`** — full sort for one percentile; quickselect upgrade.
   - **`07-elevation-batching-and-cache.md`** — dedup + batch + persistent cache; the rate-limit defense.
   - **`08-render-thread-search-and-debounce.md`** — debounce throttle + the JS-thread search risk.

## The 8 lenses (audit.md)

1. performance-budget — latent in constants, not stated as targets.
2. measurement-baselines-and-profiling — one instrument (`bench/run.ts`); no profiling, no device timing.
3. latency-throughput-and-tail-behavior — single-user; throughput `not yet exercised`.
4. cpu-memory-and-allocation — A* CPU, per-tile graph re-allocation.
5. io-network-and-database-bottlenecks — no DB; rate-limited free APIs are the bottleneck.
6. caching-batching-and-backpressure — the strongest area: all three present.
7. rendering-client-and-mobile-performance — JS-thread A*, unmeasured.
8. performance-red-flags-audit — ranked risks, evidence named.

## The honest headline

flattr **measures its algorithm** (the bench) and **defends its rate limits**
(cache + batch + backpressure) well. It does **not** measure on-device latency,
has **no formal budgets**, and runs **no profiler**. The optimization half is
strong; the measurement half is a named gap.

## Cross-links to neighboring guides

- **`study-runtime-systems`** — JS-thread execution, event loop, bounded work, cancellation.
- **`study-system-design`** — tile-coverage architecture, build-time vs device-time split.
- **`study-dsa-foundations`** — heap, A*, k-d tree, quickselect as standalone structures.
- **`study-networking`** — the retry/backoff/throttle behavior against Open-Meteo, Overpass, Nominatim.
- **`study-debugging-observability`** — the missing instrumentation this guide keeps flagging.
