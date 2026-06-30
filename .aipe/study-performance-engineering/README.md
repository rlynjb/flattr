# study-performance-engineering — flattr

The measurement-and-optimization view of flattr: what's measurably slow or
expensive, why, and which change improves it without moving the bottleneck.

This is an **audit-style** guide. Pass 1 (`audit.md`) walks 8 fixed performance
lenses across the repo. Pass 2 (`01-` … `06-`) is one concept file per
performance pattern the repo actually exercises.

## Reading order

1. **`00-overview.md`** — the one-page map, the verdict, ranked findings,
   `not yet exercised` notes.
2. **`audit.md`** — Pass 1. The 8-lens audit, every claim grounded in `file:line`,
   ending in a ranked red-flags ladder.
3. **Pass 2 — discovered pattern files:**
   - `01-heuristic-pruning.md` — A* vs Dijkstra, the one **measured** win
     (3.9–7.4x fewer expansions, real bench numbers).
   - `02-single-flight-pump.md` — concurrency=1 backpressure against free APIs.
   - `03-linear-nearest-node-scan.md` — the O(N) snap, a latent scaling cliff.
   - `04-zones-percentile-sort.md` — full sort where quickselect is O(n).
   - `05-elevation-dedup-and-cache.md` — the real rate-limit defense.
   - `06-debounced-throttled-fetch.md` — the debounce/throttle layer.

## How to re-measure

```
npm run bench    # tsx bench/run.ts — prints expanded/pushes/pops/ms per stage
```

All numbers in this guide come from running that on this machine. Re-run it; the
ratios (A* vs Dijkstra) are stable, the absolute ms will vary by host.

## Cross-links to neighboring guides

- `study-runtime-systems` — the JS-thread execution model behind A*-in-`useMemo`.
- `study-system-design` — the build-time/run-time split and single-flight boundary.
- `study-dsa-foundations` — A*, binary heaps, k-d trees as algorithms.
- `study-networking` — retry/backoff/timeout against the elevation API.
- `study-database-systems` — `not yet exercised` here (graph is a static artifact,
  no DB); see that guide for why.
