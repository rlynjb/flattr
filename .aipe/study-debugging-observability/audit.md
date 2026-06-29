# Debugging & Observability — the 8-lens audit (flattr)

> Pass 1. One section per lens. Each names what the repo actually does, grounded
> in `file:line`, or says `not yet exercised` with the trigger that flips it on.
> Where a finding earns a deep walk, it cross-links to a Pass 2 pattern file.

The headline: flattr's observability is **in-band** — it travels as return-value
data, not as a logging/metrics/tracing side channel. That makes the
"data-shaped" lenses (1, 2, 6) rich and the "infrastructure-shaped" lenses
(3, 4, 5, 7) mostly `not yet exercised`. Both are honest signals about a
pure-engine + on-device app with no server.

---

## 1. observability-map — what can be observed at each boundary

The strongest lens in the repo. Walk the boundaries and ask "what evidence
crosses here?"

```
  flattr's evidence map — what's observable at each seam

  ┌─ BUILD-TIME (pipeline/) ────────────────────────────────────┐
  │  Open-Meteo HTTP boundary → res.status (429 visible)         │ elevation.ts:114
  │  console.log progress at each phase                          │ run-build.ts:43-49
  │  console.error on build failure                              │ run-build.ts:55
  └─────────────────────────────────────────────────────────────┘
  ┌─ ENGINE (features/routing/) ────────────────────────────────┐
  │  every search returns nodesExpanded / pushes / pops          │ types.ts:45-51
  │  every path returns steepEdges (compromise list)             │ types.ts:36
  │  path === null  ⇔  genuinely disconnected (not just steep)   │ astar.ts:77
  └─────────────────────────────────────────────────────────────┘
  ┌─ BENCH (bench/) ────────────────────────────────────────────┐
  │  counters tabulated across 5 stages, side by side            │ run.ts:44-56
  └─────────────────────────────────────────────────────────────┘
  ┌─ MOBILE (mobile/src/) ──────────────────────────────────────┐
  │  degraded flag per region (grades are fake)                  │ useTileGraph.ts:75
  │  routed.found flag (route exists / doesn't)                  │ MapScreen.tsx:156-160
  │  user-visible note: "Grades approximate…"                    │ MapScreen.tsx:376
  └─────────────────────────────────────────────────────────────┘
```

Every important boundary emits *something the caller can inspect*. The gap: none
of it is persisted or aggregated over time — it's observable in the moment, not
after the fact. → deep walk in `01-in-band-search-instrumentation.md`.

---

## 2. reproduction-and-evidence — minimal repro, hypotheses, controlled experiments

Exercised, and well. The repo's whole testing posture is "reproduce on a tiny
deterministic graph, then assert."

- **Minimal repros as fixtures.** `makeGridGraph(12)` and hand-built graphs
  (`diamondGraph`, `directionalGraph`) in the routing tests are the minimal
  reproductions — a 12×12 grid is small enough to reason about by hand, big
  enough to expose a wrong heuristic (`features/routing/astar.test.ts:38-52`).
- **Controlled experiment = the second computation.** The optimality probe runs
  the *same input* through two algorithms and compares
  (`astar.test.ts:38-46`) — a controlled experiment where the control is
  Dijkstra. → `02-optimality-oracle-probe.md`.
- **Injectable dependencies for hypothesis isolation.** `openMeteoProvider`
  takes a `fetchImpl` parameter (`pipeline/elevation.ts:90`), so a test can feed
  a fake 429 response and reproduce the rate-limit path deterministically
  (`pipeline/elevation.test.ts:66-70`). This is the seam that lets you reproduce
  a network failure without the network.
- **The documented repro habit.** Project memory + `context.md:78-80`:
  `curl` Open-Meteo before debugging the pipeline, because a 429 produces
  all-flat grades that mimic a grade-bug. Instrument the upstream before
  suspecting your code. → the "all grades green" incident in
  `04-degrade-and-surface-seam.md`.

---

## 3. structured-logs-and-correlation — events, levels, context, correlation IDs, redaction

**not yet exercised.** There is no structured logging. The entire logging
surface is **8 `console.*` calls**, all build-time or bench:

- `pipeline/run-build.ts:25,32,43,45,49` — phase progress (`console.log`)
- `pipeline/run-build.ts:55` — build failure (`console.error`)
- `bench/run.ts:56,58` — table output (`console.log`)

No levels, no JSON fields, no correlation IDs, no redaction. No logging library
in either `package.json` (root has only `tsx`, `typescript`, `vitest`, `@types/node`).

**Trigger:** the first time a `build:graph` run fails in CI and the plain
`console.error(err)` (`run-build.ts:55`) doesn't carry enough context to
reproduce — which bbox, which phase, which provider. At that point a leveled
logger with the bbox + phase as structured fields earns its place. No correlation
IDs are needed until there's more than one in-flight request to correlate, which
requires a server (lens 5).

---

## 4. metrics-slis-slos-and-alerts — signals, indicators, objectives, thresholds

**Partially exercised — as ad-hoc measurement, not as monitored metrics.**

The bench harness *computes* exactly the signals you'd turn into SLIs: per-stage
`nodesExpanded`, `pushes`, `pops`, and wall-clock `ms`
(`bench/report.ts:2-9`, `bench/run.ts:44-52`). But they're printed to a console
table once per manual `npm run bench` run — there is no time series, no
objective, no alert threshold, nothing that pages.

The closest thing to an SLI *defined* anywhere is implicit in the assertions:
"A* expands no more nodes than Dijkstra" (`astar.test.ts:48-52`) is a
correctness objective enforced at test time, and the bench narrative documents
the expected shape — A* prunes the flood to a cone, bidirectional meets in the
middle (`bench/report.ts:59-63`). That's a documented baseline, not a live SLO.

**Trigger:** first real deploy. The two SLIs that matter — p95 route-compute
latency and **degraded-region rate** (how often elevation falls back to flat) —
both have their raw signal already (`ms` in the bench; the `degraded` flag in
`useTileGraph.ts:75`). What's missing is collection over time and a threshold
that alerts. → the counters are deep-walked in
`01-in-band-search-instrumentation.md`.

---

## 5. traces-and-request-lifecycles — spans, causal chains, latency attribution

**not yet exercised** as distributed tracing; the *causal chains exist* but are
all in-process and observable by reading the code.

The longest lifecycle is the build pipeline: `osm → split → elevation → grade →
build-graph` (`pipeline/run-build.ts`). It's a fixed, single-process sequence
with no spans and no IDs — you attribute latency by reading the `console.log`
phase markers, not a trace. The on-device tile lifecycle
(`useTileGraph.ts` viewport-change → fetch OSM → elevation → build → merge →
render) is similarly single-process.

**Trigger:** the moment any of these phases moves behind a network hop to a
separate service. The instant elevation is a remote service you call per request
(rather than a build-time batch), you'd want a span around it with a correlation
ID so a slow build can be attributed to the elevation hop vs the graph build.
Today there's nothing to correlate across — one process, one timeline.

---

## 6. state-snapshots-and-debugging-boundaries — state inspection, network traces, before/after

Exercised through three mechanisms:

- **The search result is a state snapshot.** `SearchResult`
  (`types.ts:45-51`) is a frozen snapshot of the search's work: how many nodes
  it finalized, how many pushes/pops it took. Two snapshots side by side (A* vs
  Dijkstra) *are* a before/after comparison of search efficiency
  (`bench/run.ts:44-56`).
- **The network boundary is inspectable by injection.** `fetchImpl` injection
  (`elevation.ts:90`) lets a test substitute a recorded `Response` — a network
  trace you control. `pipeline/elevation.test.ts:66-70` snapshots the 429 path.
- **The `degraded` flag is a region-level state snapshot.** Each `Region`
  carries `{ bbox, graph, degraded }` (`useTileGraph.ts:75`); the display graph
  *excludes* degraded regions while the routing graph *includes* them
  (`useTileGraph.ts:139-162`) — the flag is the state that drives two different
  downstream views. → `04-degrade-and-surface-seam.md`.

---

## 7. incident-analysis-and-prevention — root cause, remediation, regression guards, runbooks

Exercised informally, through project history — two real incidents, each
diagnosed and guarded.

- **Incident A — "no route between those points."** Root cause: viewport-only
  tiling produced disconnected graph components, so two real points had no path
  between them. Found by a reachability probe (instrument-before-fix:
  confirm the graph is disconnected before touching the router). The prevention
  is structural and now load-bearing: `BLOCKED = 1e9` is **finite, not
  Infinity** (`cost.ts:4-5`) so "only-steep path" stays distinct from
  "disconnected → null", and the routing graph deliberately includes degraded
  regions so excluding them can't reintroduce disconnection
  (`useTileGraph.ts:135-145`). Regression guard:
  `astar.test.ts:91-96` ("returns null only when genuinely disconnected, not
  when merely steep"). → `03-route-honesty-signals.md`.
- **Incident B — "all grades green."** Root cause: Open-Meteo throttled (429),
  the flat fallback returned 0 m elevation everywhere, and the all-flat grades
  painted the whole map green — masking the real grades. Diagnosed by
  `curl`-ing the API (confirming the 429 was upstream, not a grade-compute bug).
  Remediation: tag the region `degraded` and *exclude degraded regions from the
  display graph* so fake grades don't paint over real ones
  (`useTileGraph.ts:147-162`), plus a self-heal retry
  (`useTileGraph.ts:209-218`). Runbook-as-memory:
  "curl before debugging" (`context.md:78-80`). → `04-degrade-and-surface-seam.md`.

What's missing: these runbooks live in commit history and project memory, not a
written incident doc or `RUNBOOK.md`. **Trigger:** a third person joining the
project, at which point the curl-first habit needs to be written down where they
can find it, not learned by hitting the 429.

---

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by what behavior the repo would currently fail to explain.

```
  blind spot                       consequence                    severity
  ───────────────────────────────  ─────────────────────────────  ────────
  1. no error tracking / crash     a user-side crash is invisible  HIGH once
     reporting (no Sentry/dep)      — you learn from store reviews  shipped
                                    or nothing. MapScreen.tsx has
                                    no error boundary surfacing
                                    crashes to any backend.

  2. degraded-rate is computed      you can't tell whether grades   HIGH once
     but never collected            are routinely fake in prod —    shipped
     (useTileGraph.ts:75)           the signal exists per-region,
                                    nothing aggregates it.

  3. console.error(err) loses       a CI build failure may be       MEDIUM
     context (run-build.ts:55)      unreproducible — no bbox/phase
                                    captured with the error.

  4. nearestNode is O(n) and        a tap that snaps to a far/wrong MEDIUM
     silent (nearest.ts:5-18)       node gives a baffling route
                                    with no log of WHICH node it
                                    snapped to — hard to diagnose
                                    "why did it route from there?"

  5. no latency signal in prod      bench measures ms offline;      LOW until
     (bench-only)                   on-device route-compute time    deployed
                                    is unmeasured on real hardware.
```

The top two are the same root issue: **flattr observes itself beautifully
in-band but persists nothing.** Every signal needed to debug production already
exists as a return value — `degraded`, `found`, `steepEdges`, the counters. The
missing layer is collection, not instrumentation. That's the cheapest possible
production-observability story to bootstrap, because the hard part (deciding what
to measure) is already done.
