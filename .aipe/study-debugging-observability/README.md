# Study — Debugging & Observability (flattr)

How this repo reveals its own behavior — in development, in the
benchmark harness, and in the running mobile app. This is the
*evidence* lens: when a route is wrong, slow, or missing, what can
you observe to explain it, and what can't you observe yet?

flattr has **no logging framework, no metrics backend, no tracing,
no APM, no alerting, no incident tooling.** That is not a gap to
apologize for — it's a single-binary routing engine plus a static
graph and an Expo app. What it *does* have is a sharp, purpose-built
visibility surface around the one thing that matters: route quality
and search efficiency. This guide maps that surface honestly and
names every production-observability concept that is `not yet
exercised`, plus the trigger that would introduce it.

## Reading order

1. **`00-overview.md`** — the repo-grounded evidence map, ranked
   findings, and the `not yet exercised` list in one page. Start here.
2. **`audit.md`** — Pass 1. The 8-lens debugging/observability audit,
   one section per lens, each grounded in `file:line` or marked
   `not yet exercised`.
3. **Pass 2 — discovered pattern files** (the visibility surfaces
   that actually carry weight in this repo):
   - **`01-search-instrumentation-counters.md`** — the in-algorithm
     counters (`nodesExpanded` / `pushes` / `pops`) and the bench
     table that turns them into evidence.
   - **`02-optimality-oracle.md`** — the Dijkstra-vs-A* equal-cost
     assertion as the correctness reproduction loop.
   - **`03-route-honesty-signal.md`** — `BLOCKED` as large-finite,
     `steepEdges`, `routeSummary`, and the three-state summary card:
     domain-level observability of route *quality*.
   - **`04-degrade-and-surface.md`** — best-effort elevation, the
     `loadingStep` progress string, and `routeError` states: how the
     app makes network/runtime failure visible without crashing.

## Where this sits — neighbors

This guide owns **evidence and visibility**. It cross-links rather
than re-teaches:

- **`../study-testing/`** — owns the test suite as a *correctness
  gate*. This guide borrows the same tests but reads them as a
  *reproduction loop* (evidence you can re-run). When the question is
  "does this catch regressions before release," that's testing's lens;
  when it's "what re-runnable experiment explains this behavior," it's
  ours. The optimality oracle (`02-`) lives on that seam.
- **`../study-performance-engineering/`** — owns *optimization* of the
  bench numbers (how to make A* prune harder). This guide keeps its
  lens on the bench harness as an *instrumentation/evidence surface*
  (how the numbers get measured and reported), not on tuning them.
  `01-` is the shared file, read from the visibility side.
- **`../study-dsa-foundations/`** — owns what the counters *measure*
  (heap operations, closed-set expansion, the A* frontier). When you
  want the algorithm theory behind `pushes`/`pops`, go there; here we
  treat the counters as observable signals.
