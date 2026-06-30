# Study — Debugging & Observability · flattr

How this repo reveals its own behavior: how you reproduce a wrong route, what
evidence exists when grades go wrong, and where the blind spots are.

The through-line: **when a route is wrong, what evidence exists to explain it
quickly and stop it coming back?**

flattr is a pure-TypeScript grade-aware A* router plus an Expo/React Native map.
There is no live backend, no log aggregator, no APM, no error tracker. The
observability surface is almost entirely *in-band*: search metrics the algorithm
counts as it runs, an optimality oracle the tests assert, and route-honesty
signals the UI paints. That shape — rich in-band signal, nothing persisted —
is the whole story here, and the audit names exactly where it leaves you blind.

## Reading order

1. `00-overview.md` — the evidence map, ranked findings, what's `not yet exercised`.
2. `audit.md` — Pass 1: the 8-lens debugging-&-observability audit, grounded `file:line`.
3. Pattern files (Pass 2), each a deep walk of one mechanism the repo actually runs:
   - `01-search-instrumentation-counters.md` — `nodesExpanded / pushes / pops` threaded through the search loop; the bench table that reads them.
   - `02-optimality-oracle.md` — A* asserted equal to Dijkstra; a differential correctness probe.
   - `03-degrade-and-surface.md` — elevation 429 → flat fallback → degraded flag → user-visible "Grades approximate" note.
   - `04-finite-blocked-as-diagnostic.md` — `BLOCKED = 1e9` (not `Infinity`) keeps "no flat route" distinct from "no route at all".
   - `05-curl-the-api-first.md` — the operational discipline: probe the external API before debugging your own pipeline.

## Cross-links to neighboring guides

- **`study-testing`** — owns *whether* the optimality oracle and fallback cases
  are covered as tests. This guide owns what those same checks reveal *as
  evidence* when behavior is wrong. The oracle file (`02-`) sits on that seam.
- **`study-performance-engineering`** — owns the bench harness as a *measurement*
  tool (latency, throughput, the algorithm progression). This guide borrows the
  same `nodesExpanded` counters as *diagnostic* evidence. Cross-link, don't re-teach.
- **`study-dsa-foundations`** — owns A*, Dijkstra, the binary heap, BFS-for-
  reachability as algorithms. This guide uses them as the thing being observed.
- **`study-networking`** — owns the 429/backoff/retry transport mechanics of the
  Open-Meteo and Overpass calls. This guide owns how a 429 becomes *visible*
  downstream.
- **`study-system-design`** / **`software-design`** — own the network seam and
  the fallback architecture as design. This guide owns the seam as an
  observability boundary.
