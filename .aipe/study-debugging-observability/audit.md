# Audit — Debugging & Observability lenses · flattr

Pass 1. Eight lenses, walked in order against the actual repo. Each names what
flattr does with `file:line` grounding, or says `not yet exercised` and names
the trigger. Significant findings cross-link to their Pass 2 pattern file rather
than restating the mechanism.

Verdict up front: flattr's observability is **in-band and ephemeral**. Behavior
is richly visible *while it runs* — the search counts its own work, the tests
assert an optimality oracle, the UI paints route honesty — but nothing is
*persisted*. There is no structured log, no metric store, no trace, no error
tracker. For a pre-backend single-artifact app that's a defensible shape; the
moment it ships to a real device, the persistence gap is the whole risk.

---

## 1. observability-map

**What can be observed at each boundary.** Three runtimes, three regimes.

- **Build-time** (`pipeline/run-build.ts`): stdout narration only —
  `console.log("Fetching OSM…")` (`run-build.ts:43`), `console.log("Wrote
  data/graph.json: N nodes, M edges")` (`run-build.ts:49-51`), `console.warn`
  on the FLAT-elevation path (`run-build.ts:29`), `console.error(err)` at the
  top-level catch (`run-build.ts:54-56`). Human-readable, not machine-parseable,
  not persisted.
- **Test/bench** (`bench/run.ts`, `*.test.ts`): the richest evidence surface.
  The search engine counts `nodesExpanded / pushes / pops` as it runs
  (`astar.ts:35-37, 46-77`) and the bench prints them in a comparison table
  (`bench/run.ts:46-56`, `bench/report.ts:19-37`). The tests assert behavioral
  invariants (optimality, symmetry, fallback). → see `01-` and `02-`.
- **Runtime** (`mobile/src/`): in-band UI signals only. `degraded` flags on
  flat-fallback regions (`useTileGraph.ts:75`), three route states in
  `RouteSummaryCard.tsx` (`:21, :32`), the "Grades approximate" note
  (`MapScreen.tsx:375`). No console output, no telemetry. → see `03-`.

The map's defining feature: **the boundary between "instrumented" and "blind" is
the boundary between dev-time and runtime.** Everything before the app is well-
observed; the app itself observes only through pixels.

## 2. reproduction-and-evidence

**Minimal repro, hypotheses, controlled experiments.** This is flattr's
strongest lens, because the core is pure and deterministic.

- **Deterministic fixtures.** `features/routing/fixtures.ts` builds grid graphs
  with a pure elevation function; `fixtureProvider` (`elevation.ts:13-19`) makes
  elevation `a pure function of lat/lng`. A wrong route is reproducible from a
  graph + start + goal + `userMax`, with no network, no clock, no randomness.
- **Controlled experiments via the bench.** `bench/run.ts:36-42` runs five
  algorithm variants over the *same* fixed interior pairs — a controlled
  comparison where only the (costFn, heuristicFn) changes. That's a designed
  experiment: hold the input constant, vary one factor, read the counters.
- **The two documented debugging stories** are both repro-first:
  - *"no route between those points"* — disconnected graph components from
    viewport-only tiling. Diagnosed with a reachability/BFS probe
    (instrument-before-fix), fixed by corridor loading (`MapScreen.tsx:136-148`,
    `useTileGraph.ts:269-280`). → `04-`.
  - *"all grades green"* — Open-Meteo throttled → flat fallback masked real
    grades. Diagnosed by curling the API and excluding degraded regions from
    display (`useTileGraph.ts:150-162`). → `03-`, `05-`.

## 3. structured-logs-and-correlation

**Events, levels, context, correlation IDs, redaction, searchable fields.**

`not yet exercised.` There is no structured logging anywhere. The only logging
is raw `console.*` in two build-time scripts (`run-build.ts`, `bench/run.ts`) —
unleveled (`.log`/`.warn`/`.error` used as plain output, not a level system),
unstructured (interpolated strings, not JSON fields), uncorrelated (no request
or build ID), and not persisted. The runtime app logs *nothing* —
errors are swallowed by bare `catch {}` (`useTileGraph.ts:219`,
`MapScreen.tsx:86`).

**Becomes relevant when:** the app ships to real devices. The first time a user
reports "it routed me up a hill," there is currently zero evidence trail —
no log of the graph state, the `userMax`, or whether elevation was degraded.
Minimum viable: a structured log line at the route call carrying
`{startId, endId, userMax, found, steepCount, corridorDegraded}`.

## 4. metrics-slis-slos-and-alerts

**Signals, SLIs, SLOs, alerts, actionable thresholds.**

`not yet exercised` as production telemetry — but the *raw material* exists. The
search already computes the exact counters a metric system would want:
`nodesExpanded`, `pushes`, `pops` (`types.ts:46-51`), plus per-run `ms` and
`cost` in the bench (`bench/run.ts:46-54`). These are printed to a table, never
aggregated, never thresholded, never alerted on. → see `01-` for the mechanism.

There is one *implicit* objective enforced in code, worth naming: the optimality
oracle (`astar.test.ts:38`) is effectively an SLO on correctness — "A* cost must
equal Dijkstra cost" — checked in CI rather than monitored in prod. → `02-`.

**Becomes relevant when:** fallback rate or route latency needs a threshold.
E.g. "if >5% of corridor builds degrade to flat over 5 min, the elevation quota
is exhausted — page." Today `corridorDegraded` is a per-render boolean
(`useTileGraph.ts:285`); it would need to be counted and windowed to alert.

## 5. traces-and-request-lifecycles

**Request lifecycles, spans, causal chains, latency attribution.**

`not yet exercised` in the distributed sense — no service boundary, no
multi-hop request, nothing to trace across processes. The closest thing is the
build pipeline's phase narration: `buildGraph` accepts an `onPhase` callback
(`useTileGraph.ts:196-197`, `build-graph.ts`) that drives `setLoadingStep`
("Fetching streets" → later phases) so the UI shows which stage a build is in.
That's a single-process progress trace, surfaced to the user, not a span tree.

Latency *is* attributed, but only in the bench: `time()` wraps each algorithm
(`bench/run.ts:23-27`) and reports `ms` per stage. Single-process, dev-time.

**Becomes relevant when:** a backend is introduced and one route request fans
out (geocode → Overpass → elevation → build → search) across services. Today
that chain runs in-process in `handleRoute` (`MapScreen.tsx:174-199`) and
`useTileGraph`'s `pump`; a span per hop would attribute where a slow route went.

## 6. state-snapshots-and-debugging-boundaries

**State inspection, network traces, error output, before/after snapshots.**

Partially exercised, and well-suited to it because the engine is functional.

- **State is snapshottable by construction.** A `Graph` is a plain serializable
  object (`types.ts:22-28`); `graph.json` *is* a state snapshot — the exact
  artifact the app reads. You can diff two builds, or feed a captured graph back
  into `search()` to reproduce a route offline.
- **The merged-graph seam is the key debugging boundary.** `useTileGraph` keeps
  two derived graphs side by side: `graph` (routing — includes degraded
  regions, `:132-145`) and `displayGraph` (heatmap — *excludes* degraded
  regions, `:150-162`). That split is itself a debugging insight made
  structural: the "all green" bug was the display graph painting bogus flat
  grades, so the fix was to snapshot routing-state and display-state separately.
- **Network errors are observable at the seam but then dropped.**
  `bestEffortElevation` (`useTileGraph.ts:20-31`) catches the throttle, flips
  `degraded`, returns flat — the *fact* of failure is captured as a boolean, but
  the error object (status, body) is discarded by the bare `catch`.

**Gap:** no network trace is retained. When Open-Meteo 429s, the code knows
*that* it failed (sets `degraded`) but keeps no record of the response — which
is exactly why the human discipline is "curl it yourself" (`05-`).

## 7. incident-analysis-and-prevention

**Root cause, contributing conditions, remediation, regression guards.**

Two real incidents are documented and both were closed with a structural
prevention, not just a patch — the strongest signal in this lens.

- **"No route between those points."** *Root cause:* viewport-only tiling
  produced disconnected graph components — a distant start and goal landed in
  separate components (spec §14.2, `MapScreen.tsx:136-138` comment). *Diagnosis:*
  a reachability/BFS probe (instrument-before-fix) confirmed the goal was
  unreachable, not merely steep. *Remediation:* bulk-load the corridor spanning
  both endpoints + a tile of margin so they share one component
  (`MapScreen.tsx:139-148`, `useTileGraph.ts:269-280`). *Regression guard:*
  `astar.test.ts:91` — "returns null only when genuinely disconnected, not when
  merely steep." → `04-`.
- **"All grades green."** *Root cause:* Open-Meteo throttled → flat (0 m)
  fallback → every grade computed as 0 → all-green heatmap masking real grades.
  *Contributing condition:* the fallback was silent. *Diagnosis:* curl the API
  (got the 429), then realize the display graph was including degraded regions.
  *Remediation:* exclude degraded regions from `displayGraph`
  (`useTileGraph.ts:150-162`) and self-heal via capped retries
  (`:209-218`). *Surfaced:* "Grades approximate" note (`MapScreen.tsx:375`). →
  `03-`, `05-`.

**Runbook:** the curl-first discipline (`05-`) is the closest thing to a runbook
— a documented "before you debug the pipeline, probe the external API" step
captured in `.aipe/project/context.md` and user memory.

## 8. debugging-observability-red-flags-audit

**Ranked blind spots, by consequence.**

1. **Runtime errors are swallowed silently.** `catch {}` at
   `useTileGraph.ts:219` (Overpass build failure) and `MapScreen.tsx:86`
   (transient/rate-limit) discard the error entirely. *Consequence:* on a real
   device, a persistent Overpass outage looks identical to "nothing loaded" —
   no signal reaches anyone. This is the highest-consequence gap because it's an
   *active* silencing, not just a missing feature. Mitigated only by the
   `degraded` flag covering the *elevation* path; the *streets* path has no
   equivalent surfaced signal beyond the stale-region keepalive.
2. **No persisted evidence at runtime.** Every diagnostic signal the app
   produces is a transient React render (`degraded`, the route states). Close
   the app, lose the evidence. *Consequence:* no post-hoc debugging of a user
   report is possible.
3. **Degraded state is per-region boolean, not counted.** `corridorDegraded`
   (`useTileGraph.ts:285`) tells you *this* corridor is flat, but there's no
   running count of how often the quota is being hit — so quota exhaustion has
   no trend signal until everything is green. → relates to lens 4.
4. **The "all green" failure is only caught by display exclusion, not asserted.**
   The `displayGraph`/`graph` split (`:132-162`) prevents the bug structurally,
   but there's no test asserting degraded regions stay out of the display graph
   — the regression guard is architectural, not verified. (Verification is
   `study-testing`'s lens; flagged here as a diagnostic risk.)
5. **Build-time logs are unleveled and unstructured.** `console.log`/`.warn`/
   `.error` in `run-build.ts` aren't a level system you can filter — fine for a
   hand-run CLI, a problem the moment builds run unattended (CI/cron).

None of these are wrong *for the current scope*. They are the precise list of
what to instrument first when flattr grows a backend or ships to real users.
