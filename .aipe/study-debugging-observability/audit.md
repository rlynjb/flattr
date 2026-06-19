# Audit — debugging & observability lenses (flattr)

Pass 1. Eight lenses walked against the actual code. Each is grounded
in `file:line` or marked `not yet exercised` with the trigger that
would change that. Significant findings cross-link to a Pass 2 pattern
file rather than restating it.

The honest frame up front: flattr is a hand-rolled routing engine
(`features/`), a build pipeline (`pipeline/`), and an Expo app
(`mobile/`). There is no server, no database, no logging framework, no
metrics/tracing/alerting stack. So several lenses below are `not yet
exercised` — and that's the correct answer, not a hole to fill with
invented infrastructure.

---

## 1. observability-map — what can be observed at each boundary

**What the repo does.** Behavior becomes observable at three boundaries,
each with a distinct mechanism:

- **Build-time CLI.** `pipeline/run-build.ts:25-51` narrates the build
  over `console.log`/`console.warn` (which elevation provider, fetching
  OSM, building, final node/edge counts). `:54-57` prints the error and
  sets `process.exitCode = 1` on failure.
- **Dev/bench.** `bench/run.ts:44-56` reads per-search counters and
  prints them via `bench/report.ts:formatTable`. The vitest suite
  (`features/routing/*.test.ts`) is the other dev-time observation
  point. → deep walk in `01-search-instrumentation-counters.md`.
- **App runtime.** `mobile/src/RouteSummaryCard.tsx:15-41` surfaces
  route quality (three states); `mobile/src/useTileGraph.ts:63,105,126`
  surfaces load progress as `loadingStep`; `mobile/src/MapScreen.tsx`
  surfaces lookup failures as `routeError` (`:176,183,195,206`).

The cleanest way to see the map is that the **same engine code is
observed three different ways** depending on where it runs: counted in
the bench, asserted in tests, and rendered as a status card in the app.
One mechanism (`SearchResult`), three observation surfaces.

**Verdict:** Present and purpose-built, but **batch/local only** — every
observation point is a synchronous print, assertion, or render. No
boundary emits a durable, queryable signal. → `00-overview.md` has the
full map diagram.

---

## 2. reproduction-and-evidence — minimal repro, hypotheses, experiments

**What the repo does.** This is the repo's *strongest* observability
muscle. The evidence loop is built from three things:

- **The optimality oracle.** `features/routing/astar.test.ts:38-45`
  runs Dijkstra (uninformed, provably optimal) and A* on the same grid
  and asserts equal cost (`toBeCloseTo(d.path!.cost, 6)`).
  `bidirectional.test.ts:8-45` extends the oracle to the bidirectional
  variant against both Dijkstra and `directedAstar`. If a fast search
  returns a wrong path, the oracle is the controlled experiment that
  proves it. → `02-optimality-oracle.md`.
- **Deterministic fixtures.** `features/routing/fixtures.ts`
  (`diamondGraph`, `makeGridGraph`, `gradeGraph`, `directionalGraph`)
  are hand-built graphs with *known* answers — `astar.test.ts:9` asserts
  the exact node sequence `["S","A","G"]`. A minimal reproduction is one
  fixture call.
- **State-invariant check.** `features/routing/pqueue.ts:42-48`
  exposes `checkInvariant()` (test-only) so a heap bug is caught as a
  structural violation, not an inscrutable wrong route downstream.

**Verdict:** Present and strong. The oracle + fixtures + invariant
check is a real reproduce→hypothesize→prove loop, the kind you actually
use to explain a bug. This is the lens flattr scores highest on.

---

## 3. structured-logs-and-correlation — events, levels, context, IDs

**What the repo does.** Logging is raw `console.*` with no structure,
levels beyond log/warn/error, context fields, or correlation IDs. The
full inventory (non-test) is small:

- `pipeline/run-build.ts:25,29,32,43,45,49,55` — build narration.
- `bench/run.ts:56,58` — the bench table + an explanatory footer.
- `mobile/scripts/*.mjs`, `make-sample-graph.ts` — tooling output.

No log is emitted as a key/value event; nothing carries a request or
session id; nothing is redacted (there's no PII in scope). `console.warn`
at `run-build.ts:29` is the only level distinction that means anything
(it flags the degraded FLAT-elevation mode).

**Verdict:** `not yet exercised` as structured logging. *Trigger:* a
hosted route API where you must grep one user's request out of
thousands — that's when JSON logs + a correlation id earn their keep.
Today, with one synchronous engine and a local CLI, a plain string is
the right tool and structure would be ceremony.

---

## 4. metrics-slis-slos-and-alerts — signals, SLIs, SLOs, alerts

**What the repo does.** Real *signals* exist — `nodesExpanded`,
`pushes`, `pops` (`features/routing/types.ts:45-51`,
`features/routing/astar.ts:35-37`), plus wall-clock `ms` and `cost`
(`bench/run.ts:23-27,52-53`). But they are computed, printed once by
`formatTable`, and discarded. There is:

- no aggregation or time series (nothing stores a run),
- no SLI (no defined "good" — the bench footer at `run.ts:58-63`
  *describes* expected shape in prose, not as a threshold),
- no SLO, no alert, no error budget.

The closest thing to an assertion *about* a metric is
`astar.test.ts:47-52` (`a.nodesExpanded ≤ d.nodesExpanded`) and
`bidirectional.test.ts:37` (`b.nodesExpanded < dj.nodesExpanded`) —
those are correctness gates on the *shape* of the metric, not
monitored objectives. → the signals themselves are walked in
`01-search-instrumentation-counters.md`; tuning them is
`../study-performance-engineering/`'s lens.

**Verdict:** Signals present; SLIs/SLOs/alerts `not yet exercised`.
*Trigger:* CI that fails the build when `nodesExpanded` regresses past a
baseline (turns the signal into an SLI), or a served endpoint with a
latency objective (turns it into an SLO with alerting).

---

## 5. traces-and-request-lifecycles — spans, causal chains, latency

**What the repo does.** There is no distributed call to trace. A route
is one synchronous `directedAstar(...)` call (`MapScreen.tsx:147`).
The nearest thing to a *lifecycle* is the mobile graph-build pipeline:
`useTileGraph.ts:89-129` runs Overpass-fetch → elevation-sample →
build-graph as a single async `pump()` with a `loadingStep` string
that walks the phases ("Fetching streets" `:105`, then steps inside
`buildGraph` via the `setLoadingStep` callback `:112`). That's a
coarse, single-process progress trace — not spans, no timing
attribution, no parent/child causal links.

**Verdict:** `not yet exercised` as tracing. *Trigger:* splitting
geocode, corridor-build, and route into separate services or workers,
where you'd need spans to attribute latency across the hops. Today the
"trace" is one call stack you can read in a debugger.

---

## 6. state-snapshots-and-debugging-boundaries — state inspection, traces

**What the repo does.** State is inspectable at well-defined seams:

- **The graph artifact is a snapshot.** `pipeline/run-build.ts:11-13`
  serializes the whole graph to `data/graph.json` — a literal,
  re-loadable state snapshot you can diff between builds.
- **`SearchResult` is a state snapshot of one search.**
  `features/routing/types.ts:45-51` returns not just the path but the
  counters — every search hands back enough to reconstruct what it did.
- **The heap invariant** (`pqueue.ts:42-48`) is a before/after
  structural check on the data structure's internal state.
- **Network-failure boundary.** `useTileGraph.ts:18-28,121-122` is the
  explicit boundary where a fetch failure is caught and converted (to
  flat elevation, or to keeping the last region). → `04-degrade-and-surface.md`.

**Verdict:** Present at the data-structure and artifact level. Good
enough that a wrong route can be reproduced from a fixture and a
`SearchResult` inspected field by field. No runtime state-dump tooling
(no React DevTools wiring documented, no heap snapshot export) — but
none is needed at this size.

---

## 7. incident-analysis-and-prevention — root cause, regression guards

**What the repo does.** There is no incident process (no served
system to have incidents). But the *prevention* half is real and
visible in the test suite as regression guards encoding past
reasoning:

- `astar.test.ts:102-128` — the "parallel edges" test guards a
  specific bug: reconstruction must report the *exact relaxed edge*,
  not a length-based re-resolution. The comment (`:103-105`) is the
  root-cause note left in place as a guard.
- `bidirectional.test.ts:26-38` — the long comment documents *why*
  bidirectional can expand more than unidirectional A* on a Euclidean
  grid (so a future reader doesn't "fix" a non-bug).
- `astar.test.ts:91-96` / `bidirectional.test.ts:47-52` — guard the
  load-bearing distinction "null only when disconnected, not when
  steep," which is the `BLOCKED`-finite design. → `03-route-honesty-signal.md`.

**Verdict:** No incident tooling/runbooks (`not yet exercised`), but
**regression guards with embedded root-cause comments** are present and
genuinely good. *Trigger for the rest:* a production deployment where a
bad build or a bad route reaches users and you need a postmortem +
runbook loop.

---

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by consequence, each with its evidence.

**RF-1 (high): silent elevation degradation has no signal.**
`useTileGraph.ts:18-28` catches *any* elevation error and returns 0m
for every point. Connectivity is preserved (good), but a build that
silently fell back to flat produces a route with **all grades = 0** and
the honesty card will happily say "Flat all the way" — a false-clean.
There is no log, counter, or UI badge marking "grades unavailable,
degraded." *Fix:* thread a `degraded` flag out of `bestEffortElevation`
and surface it on the card. Evidence: `:23-25` swallows the error with a
bare `catch {}`.

**RF-2 (high): the bench is the only perf signal and it's manual +
unstored.** `bench/run.ts` must be run by hand (`npm run bench`); the
numbers print and vanish. A regression that doubles `nodesExpanded`
ships undetected unless someone eyeballs a run. *Fix:* a test asserting
counters stay under a baseline (the shape of `astar.test.ts:47-52`,
extended to absolute thresholds). → `01-search-instrumentation-counters.md`.

**RF-3 (medium): app-runtime failures vanish into bare `catch {}`.**
`MapScreen.tsx:31,82-83,99,194` and `useTileGraph.ts:121-122` swallow
errors with no log. The user sometimes sees a `routeError` string
(`:195`), but transient region-load and GPS failures (`:82-83,99`) are
fully silent. On a device, with no console attached, these are
invisible. *Fix:* at minimum a dev-mode `console.warn` in each catch.

**RF-4 (medium): `cost` is a unitless routing number with no
explanation surface.** The bench prints `cost` (`run.ts:53`) and the
card shows distance/climb — but the `cost` that drives routing
decisions (`cost.ts:16-22` penalty curve) is never observable in the
app. When a route looks wrong-but-not-steep, there's no way to see
*why* the search preferred it. *Fix:* a debug overlay dumping per-edge
penalty.

**RF-5 (low): no log level discipline.** Everything is `console.log`
except the one `console.warn` at `run-build.ts:29` and `console.error`
at `:55`. Fine at this size; named here for completeness.

**Verdict:** The two high-consequence blind spots both come from the
same root — **degradation is preferred over failure, but the degrade is
never signalled.** That's the right availability call (a flat route
beats no map) made with a missing observability half (no one can tell
it degraded). Closing RF-1 is the single highest-leverage move.
