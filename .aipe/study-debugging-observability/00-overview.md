# Overview — the evidence map for flattr

The one-page orientation. Where can you observe behavior in this
repo, ranked by how load-bearing it is, plus the honest list of what
isn't here.

## The whole picture — observation points across the system

flattr is three programs sharing one engine: a CLI build pipeline, a
benchmark harness, and an Expo app. Here's every place behavior
becomes *observable*, by layer.

```
  Observability map — where evidence appears, by layer

  ┌─ Build-time (CLI) ──────────────────────────────────────────┐
  │  pipeline/run-build.ts                                       │
  │    console.log  "Fetching OSM…", "Building graph…",          │
  │    "Wrote data/graph.json: N nodes, M edges."  ← progress    │
  │    console.warn "Elevation: FLAT (0m)…"        ← config echo │
  │    console.error(err) + process.exitCode=1     ← crash trace │
  └────────────────────────────┬─────────────────────────────────┘
                               │ writes graph.json
  ┌─ Dev / bench (CLI) ────────▼─────────────────────────────────┐
  │  bench/run.ts → formatTable                                  │
  │    nodesExpanded · pushes · pops · ms · cost   ← METRICS      │
  │  *.test.ts (vitest)                                          │
  │    Dijkstra==A* cost assertion                 ← ORACLE       │
  │    pqueue.checkInvariant()                     ← STATE CHECK  │
  └────────────────────────────┬─────────────────────────────────┘
                               │ same engine, bundled into app
  ┌─ Runtime (Expo app) ───────▼─────────────────────────────────┐
  │  RouteSummaryCard.tsx   clean / ⚠flattest / "No route"       │
  │                                              ← DOMAIN SIGNAL  │
  │  useTileGraph.loadingStep  "Fetching streets" ← progress     │
  │  MapScreen.routeError  "From not found" / …   ← user error   │
  │  bestEffortElevation: catch → 0m              ← silent degrade│
  └──────────────────────────────────────────────────────────────┘

  NOT PRESENT at any layer: structured logs, log levels, correlation
  IDs, metrics aggregation/dashboards, distributed traces/spans,
  SLI/SLO/alerts, error-reporting service, incident tooling.
```

## Ranked findings — the real visibility surfaces

**1. In-algorithm search counters → the bench table (the strongest
surface).** `features/routing/astar.ts:35-37,46,50,73` increment
`nodesExpanded`, `pushes`, `pops` inside the one parametric `search`
loop; `bench/run.ts:44-56` runs five algorithm variants over fixed
interior pairs and `bench/report.ts:19-37` aligns them into a
comparison table. This is the closest thing to a metrics system: it
makes "is A* actually pruning the flood" a number you can read, not a
claim. → `01-search-instrumentation-counters.md`.

**2. The Dijkstra-vs-A* optimality oracle (the reproduction loop).**
`features/routing/astar.test.ts:38-45` asserts A* returns the *same*
cost as Dijkstra; `bidirectional.test.ts:8-38` does the same for
bidirectional. A second, slower, provably-optimal algorithm is the
oracle that proves the fast one didn't cut a corner. This is how you
reproduce and explain a "wrong route" bug. → `02-optimality-oracle.md`.

**3. Route honesty: `BLOCKED` finite + `steepEdges` + the three-state
card (domain observability).** `cost.ts:5` sets `BLOCKED = 1e9`
(large but *finite*) so an only-steep route is still returned and
flagged, distinct from a genuinely disconnected one (`null`).
`astar.ts:126-128` records `steepEdges`; `summary.ts:11-20` totals
distance/climb/steepCount; `RouteSummaryCard.tsx:15-41` renders the
three states. This is observability of *route quality* — the product's
core signal. → `03-route-honesty-signal.md`.

**4. Degrade-and-surface at the network seam.** `useTileGraph.ts:18-28`
catches elevation failure and returns flat 0m rather than failing the
build; `:105,126` drive a `loadingStep` progress string; `MapScreen.tsx`
`:166-198` maps geocode failures to user-visible `routeError` strings.
This is how runtime failure becomes visible (or deliberately invisible)
in the app. → `04-degrade-and-surface.md`.

**5. Pipeline progress + crash output (weakest, but real).**
`run-build.ts:25-51` narrates the build over `console.log`; `:54-57`
prints the stack and sets a non-zero exit code on failure. Plain, but
it's the only "what is the build doing right now" signal there is.

## What's `not yet exercised` — and the trigger for each

These are genuinely absent. The audit names each; here's the
shortlist with the event that would introduce it.

- **Structured logs / levels / correlation IDs** — every log is a raw
  `console.*` string. *Trigger:* a hosted backend serving routes to
  many users, where you need to grep one request out of thousands.
- **Metrics aggregation / dashboards / time series** — the bench
  counters are printed once and discarded; nothing stores or trends
  them. *Trigger:* CI that fails when `nodesExpanded` regresses, or a
  served API emitting per-request route latency.
- **Distributed traces / spans** — there is no cross-service call to
  trace; the engine is one synchronous function. *Trigger:* splitting
  geocode → corridor-build → route into separate services.
- **SLIs / SLOs / alerts / error budgets** — nothing defines "good"
  numerically or pages on breach. *Trigger:* an availability promise
  on a hosted endpoint.
- **Error-reporting service (Sentry-style) / incident tooling /
  runbooks** — failures vanish into `catch {}` or the device console.
  *Trigger:* real users hitting crashes you can't reproduce locally.

The honest read: flattr's visibility is **batch and local** — you run
the bench, you run the tests, you read the card. The moment it becomes
a *served, multi-user* system, items 1–4 above become the wiring it
would need. The audit (`audit.md`) walks all eight lenses against the
current code and says exactly where each one stands today.
