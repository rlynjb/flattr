# Study — Debugging & Observability (flattr)

How flattr reveals its own behavior in development and (eventually) production:
reproduction, evidence, logs, metrics, traces, state snapshots, incidents, and
prevention. Audited against an 8-lens inventory, then deep-walked for the
patterns the repo actually exercises.

flattr's defining trait here: **the evidence is in the return values, not a side
channel.** No Sentry, no logger, no metrics backend — and yet the search hands
back the counters that explain its work, the route hands back its compromises,
and the degraded build hands back a flag saying its grades are fake. That makes
this a short but unusually clean observability story.

## Reading order

1. **`00-overview.md`** — the repo-grounded map, ranked findings, the four
   `not yet exercised` gaps with triggers, and the curl-first habit.
2. **`audit.md`** — Pass 1. The 8-lens audit. Each lens grounded in `file:line`
   or marked `not yet exercised` honestly. Final lens ranks the blind spots.
3. **`01-in-band-search-instrumentation.md`** — the `nodesExpanded / pushes /
   pops` counters: where they live, where they increment, how the bench reports
   them across five stages.
4. **`02-optimality-oracle-probe.md`** — A* vs Dijkstra as a correctness probe.
   Compute the answer a second way; disagreement localizes the bug to the
   heuristic.
5. **`03-route-honesty-signals.md`** — `BLOCKED`-finite, `steepEdges`, and the
   three-state `RouteSummaryCard`. How the router never lies about its answer.
6. **`04-degrade-and-surface-seam.md`** — 429 → flat fallback → `degraded` flag
   → "Grades approximate" note → self-heal retry. The "all grades green"
   incident, end to end.

## Neighboring guides (cross-links, not duplicated here)

- **`study-testing`** — owns the optimality oracle *as a release gate*. This
  guide borrows it as a *debugging probe*. Same mechanism, different posture.
- **`study-performance-engineering`** — owns the bench counters *as a budget*.
  This guide reads them *as a diagnosis*.
- **`study-system-design`** — `04-honest-fallback-routing.md` and
  `05-elevation-provider-fallback.md` describe the architecture that the
  honesty and degrade signals ride on.
