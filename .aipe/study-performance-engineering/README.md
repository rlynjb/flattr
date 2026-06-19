# Study — Performance Engineering (flattr)

This guide measures and optimizes the **flattr** routing engine: a hand-rolled,
grade-aware A* router over a street graph, plus an Expo/React Native map app. The
performance story is the whole point of the project (`docs/flattr-spec.md`
§15.2/§15.3): a real benchmark harness measures a deliberate algorithm
progression — Dijkstra → A* → grade-A* → directional → bidirectional — by **nodes
expanded**, **queue pushes/pops**, **wall-clock ms**, and **path cost**.

## Reading order

1. **`00-overview.md`** — the repo-grounded map, ranked findings, what's measured
   vs illustrative, and `not yet exercised` notes. Start here.
2. **`audit.md`** — Pass 1. The 8-lens performance audit, one section per lens,
   each grounded in `file:line` or marked `not yet exercised`.
3. **Pattern files** (Pass 2) — one per significant performance pattern the repo
   actually exercises:
   - `01-heuristic-pruning.md` — the Dijkstra→A* node-expansion win. The
     load-bearing latency optimization. **Measured.**
   - `02-instrumented-bench-harness.md` — how the win is *proven*: in-search
     counters + the comparison table.
   - `03-lazy-deletion-heap.md` — the binary min-heap and why it skips stale
     entries instead of doing a decrease-key.
   - `04-render-thread-search-debounce.md` — the synchronous A* on the single JS
     thread, plus the debounce + single-flight pump that bounds the work.
   - `05-elevation-batching-and-dedup.md` — batch the I/O, dedup to DEM
     resolution, degrade to flat under throttling.
   - `06-linear-nearest-node-scan.md` — the O(N) un-indexed snap. A latent
     scaling cost, named honestly.

## Cross-links to neighboring guides

This guide keeps its lens on **optimization** — what's measurably slow/expensive,
why, and which change improves it. The mechanisms underneath belong to siblings:

- **`.aipe/study-dsa-foundations/`** — the *algorithms themselves* (Dijkstra, A*,
  binary heap, bidirectional search) as reusable DSA. This guide cites the
  node-expansion numbers; that guide teaches the traversal.
- **`.aipe/study-debugging-observability/`** — shares the bench surface, but for
  **evidence/visibility** (what the counters reveal about behavior). This guide
  reads the same counters as an **optimization** signal.
- **`.aipe/study-runtime-systems/`** — the **single JS thread** cost: why a
  synchronous `useMemo` search blocks rendering. This guide names the symptom;
  that guide owns the execution model.
- **`.aipe/study-system-design/`** — the **scale limit**: bbox bounding, graph
  footprint, why the design caps at neighborhood-scale. This guide measures the
  footprint; that guide owns the architecture tradeoff.
