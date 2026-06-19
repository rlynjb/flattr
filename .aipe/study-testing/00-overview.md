# Overview — the testing surface, one page

*The coverage map and the verdict, before any detail.*

## Zoom out — where the tests sit relative to the code

flattr is split into three code layers and one untested app. The tests
cling tightly to the first three; the fourth is bare.

```
  flattr — code layers vs test coverage

  ┌─ Engine (features/) ─────────────────────────────────────┐
  │  routing/  astar · pqueue · cost · graph · nearest        │ ████ HEAVY
  │  grade/    classify · zones                               │ ████ HEAVY
  │  map/      geojson · tiles                                │ ███  GOOD
  │            → 14 test files, the correctness core          │
  └───────────────────────────────────────────────────────────┘
  ┌─ Pipeline (pipeline/) BUILD-TIME ────────────────────────┐
  │  osm · split · grade · elevation · overpass · geocode     │ ████ HEAVY
  │  build-graph · config                                     │      (all
  │            → 8 test files, all external calls mocked      │      mocked)
  └───────────────────────────────────────────────────────────┘
  ┌─ lib + bench ────────────────────────────────────────────┐
  │  lib/geo (haversine) · bench/report (table fmt)           │ ██   THIN
  └───────────────────────────────────────────────────────────┘
  ┌─ Mobile (mobile/src/) Expo app ──────────────────────────┐
  │  MapScreen · useTileGraph · loadGraph · AddressBar ·      │ ░░░░ NONE
  │  GradeSlider · Legend · RouteSummaryCard                  │  not yet
  │            → 0 test files                                 │  exercised
  └───────────────────────────────────────────────────────────┘
```

The verdict up front: **the engine is the project, and the engine is the
thing that's tested.** That's the correct priority. The hand-rolled A* /
priority-queue / cost-function core — the part the spec says is "the point of
the project" — carries the heaviest test load, including an algorithmic
oracle and property tests. The mobile UI that renders the result carries
none.

## The numbers (real, from `npx vitest run`, 2026-06-19)

```
  Test Files  22 passed (22)
       Tests  130 passed (130)
    Duration  282ms
```

282ms for 130 tests means every test is a pure-function unit or an
in-memory integration test. Nothing waits on I/O. That speed is *why* the
suite is worth running on every save — and it's a direct consequence of the
network-isolation discipline (`03-injected-fetch-network-isolation.md`).

## What's strong, what's missing

**Strong:**
- The Dijkstra-vs-A* optimality oracle (`astar.test.ts:37-53`) — the single
  best test in the repo.
- Property/invariant testing on the binary heap (`pqueue.test.ts:23-78`):
  50-seed sorted-order oracle plus a 2000-step heap-invariant check.
- Total network isolation: every Overpass / Open-Meteo / Nominatim call goes
  through an injected `fetch`, so the suite never hits the rate-limited
  Open-Meteo API the project memory warns about.
- Error/edge paths tested, not just happy paths: `null` on disconnected,
  throw on empty graph, divide-by-zero guarded, NaN priority rejected.

**Missing (`not yet exercised`):**
- Mobile components — zero tests across all of `mobile/src/`.
- `pipeline/run-build.ts` orchestrator and `mobile/scripts/sync-engine.mjs`
  — the glue scripts have no tests.
- CI: no `.github/workflows`. The green bar is local-only.
- Coverage tooling: no `@vitest/coverage-*` dependency; coverage is eyeballed,
  not measured.
- No LLM / AI feature anywhere → the AI-eval seam is entirely absent (which
  is fine — there's nothing to eval).

## How to use the rest of this folder

Read `audit.md` for the lens-by-lens walk. Then the five pattern files,
each of which takes one technique flattr uses *on purpose* and teaches it as
a reusable skill you can carry to the next codebase — because that's the
point: the oracle pattern survives even if you swap A* for Bellman-Ford.
