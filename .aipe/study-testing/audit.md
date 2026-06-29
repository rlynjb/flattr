# audit.md — the 7-lens testing audit (flattr)

Pass 1. Every lens from the spec inventory, walked against the actual repo.
Each lens names what the code does with `file:line` grounding, or says `not yet
exercised`. Significant techniques cross-link to their Pass 2 pattern file.

Baseline: **130 tests, 22 files, ~307ms, all green** (`npx vitest run`).
Config: `vitest.config.ts` — `globals: true`, `include: ["**/*.test.ts"]`,
`passWithNoTests: true`. Co-located `*.test.ts`. No setup file, no mocks dir.

---

## 1. what-is-tested-and-what-isnt (the risk map)

Not the coverage %, the *risk* map: is the most important / most complex code
the best tested? Here, mostly yes.

```
  risk vs coverage — the centerpiece is the best-defended

  HIGH complexity, HIGH coverage  ← correct allocation
  ┌──────────────────────────────────────────────────┐
  │ astar.ts / bidirectional.ts  → oracle vs Dijkstra │
  │ pqueue.ts (hand-rolled heap) → invariant + oracle │
  │ cost.ts (signed grade penalty)→ closed-form values│
  │ split.ts / grade.ts / elevation.ts → fixture+fake │
  └──────────────────────────────────────────────────┘

  HIGH complexity, LOW/NO coverage  ← the risk
  ┌──────────────────────────────────────────────────┐
  │ mobile/src/useTileGraph.ts (290 ln) → NO tests    │
  │   degraded-state + self-heal retry + elev cache   │
  │ mobile/src/*.tsx (all UI)            → NO tests    │
  └──────────────────────────────────────────────────┘
```

**Tested (the core):** the routing engine is covered end to end —
`pqueue.test.ts` (7), `astar.test.ts` (4 describe blocks: dijkstra, astar,
gradeAstar, directedAstar, + parallel-edge reconstruction), `bidirectional.test.ts`
(6), `cost.test.ts` (penalty bands + cost functions), `graph.test.ts`,
`nearest.test.ts`, `summary.test.ts`. The build pipeline is covered with
injected fetch: `overpass.test.ts`, `elevation.test.ts`, `geocode.test.ts`,
`split.test.ts`, `grade.test.ts`, `osm.test.ts`, `build-graph.test.ts`,
`config.test.ts`. Grade/map layers: `classify.test.ts`, `zones.test.ts`,
`geojson.test.ts`, `tiles.test.ts`. Geo math: `lib/geo.test.ts`.

**Not tested (the risk):**
- `mobile/src/` — every file. `MapScreen.tsx`, `AddressBar.tsx`,
  `GradeSlider.tsx`, `Legend.tsx`, `RouteSummaryCard.tsx`, `loadGraph.ts`,
  `useTileGraph.ts`, `elevCache.ts`. No `*.test.tsx` anywhere under `mobile/`.
- `mobile/src/useTileGraph.ts` specifically — the on-device rerun path. It
  *reuses* tested functions (`fetchOverpass`, `openMeteoProvider`, `buildGraph`)
  but its own orchestration — `degraded` flag, `RETRY_MS = 12000` self-heal,
  `cachedElevation` wrapper, viewport padding — has zero tests.
- `bench/run.ts`, `pipeline/run-build.ts` — entry-point scripts, untested (only
  `bench/report.ts`'s `formatTable` is tested → lens 7 note on bench).

**Verdict:** the allocation is correct for the project's thesis — the graph
engine is the point and it's the best-tested thing. The mobile hole is the one
place where complexity and coverage diverge, and `useTileGraph` is where that
will bite first.

---

## 2. test-design-and-levels (the pyramid as-built)

```
  the as-built pyramid

        ╱ e2e ╲              NONE
       ╱───────╲
      ╱  integ  ╲           build-graph.test.ts (whole pipeline,
     ╱───────────╲          fixture in → routable graph out),
    ╱             ╲         bidirectional×Dijkstra cross-checks
   ╱     unit      ╲        ~95% of the 130 tests
  ╱─────────────────╲
```

Healthy bottom-heavy shape. Almost everything is a fast unit test on a pure
function. A thin integration band exists and it's the right band:

- `pipeline/build-graph.test.ts:28` — "output is routable by the Plan 1 engine
  (the Phase 0 gate)": builds a graph from a fixture, then runs Dijkstra over it
  and asserts a path exists. That's a genuine integration test — pipeline output
  feeding the runtime engine.
- The oracle tests (`astar` vs `dijkstra`, `bidirectional` vs `directedAstar`)
  are cross-component checks at the unit level — two real implementations
  compared, no mocking between them.

**Over-mocking? No.** The only fakes are at the true I/O seam (`fetch`). Internal
collaborators (pqueue inside dijkstra, cost inside astar) are never mocked — the
tests run the real heap, the real cost function. That's why the oracle works: it
compares two *real* algorithms, not a mock of one. → `03` for the fetch seam.

**The gap:** no e2e, no integration above the engine. geocode→route→render is
never exercised together; the mobile layer that stitches them is untested
(lens 1).

---

## 3. tests-as-design-pressure (where untestable = a smell)

The pipeline code is *easy* to test, and that's not an accident — it's the
direct payoff of one design choice: every function that does I/O takes its
dependency as a parameter.

- `geocode(query, { fetchImpl })` (`pipeline/geocode.test.ts:12`),
  `googleProvider(key, fetch)` (`elevation.test.ts:33`),
  `fetchOverpass(bbox, url, fetch, opts)` (`overpass.test.ts:21`),
  `buildGraph(city, bbox, overpassResp, elevationProvider, ...)`
  (`build-graph.test.ts:10`). None reach for a module-level `fetch`; all accept
  it. That *is* dependency injection, and the test ease is the proof the design
  is clean. → `03`.

Contrast — where the design fights the test:

- `mobile/src/useTileGraph.ts` is a React hook that closes over `fetch`
  directly (`openMeteoProvider(fetch, ...)` at line ~191) and manages state,
  timers (`RETRY_MS`), and a persistent cache as side effects. It's a deep
  tangle of effect + state + I/O — exactly the shape that's hard to test, and
  exactly why it has no tests. The untestability *is* the design smell.

> "Hard to test" as a design finding belongs to `study-software-design`
> (deep modules are easy to test). Cross-linked, not re-audited here. The
> testing-side observation: the pipeline's injected-fetch shape is reusable from
> the hook, but the hook doesn't expose its own logic for testing.

---

## 4. determinism-isolation-and-flakiness

Excellent. The suite is fully deterministic and isolated by construction.

- **No real network.** Every pipeline test passes a `vi.fn()` fake fetch. No
  test hits Overpass, Open-Meteo, or Nominatim. → `03`.
- **No real time.** Retry/backoff tests pass `delayMs: 0`
  (`overpass.test.ts:33`, `elevation.test.ts:58`) so timers don't slow or
  destabilize the run. No `setTimeout`-based flake.
- **Seeded randomness.** The property tests use a hand-rolled LCG
  (`pqueue.test.ts:5`) with explicit seeds (1..50, 7, 99, 123). Random in
  spirit, reproducible in fact — a failure replays identically. → `02`.
- **No shared state / no ordering dependence.** Every fixture is a fresh
  factory call (`diamondGraph()`, `gradeGraph()`) — `fixtures.ts` returns new
  objects each time, so no test mutates state another reads. Tests that *do*
  mutate (adding an `ISO` node, `astar.test.ts:92`) mutate their own local copy.

**Result:** 307ms, repeatable. No `.only`, no `.skip`, no retry config. This is
the cleanest lens in the audit.

---

## 5. edge-cases-and-error-paths

Strong — error and boundary paths are tested, not just the happy path.

**Boundary values:**
- `start === goal` → trivial path (`astar.test.ts:14`, `bidirectional.test.ts:54`).
- unreachable goal → `null` (`astar.test.ts:21`, `:91`, `bidirectional.test.ts:47`).
- zero-length edge → grade 0, no divide-by-zero (`grade.test.ts:43`).
- empty input → `percentile([])` throws (`zones.test.ts:17`).
- duplicate items / priorities in the heap (`pqueue.test.ts:53`).
- absurd-grade clamp to `±MAX_GRADE_PCT` (DEM noise) (`grade.test.ts:53`).

**Error branches (the I/O failure paths):**
- non-OK HTTP throws: 429 on geocode/elevation/overpass
  (`geocode.test.ts:33`, `elevation.test.ts:66`, `overpass.test.ts:49`).
- API status not OK → throws `REQUEST_DENIED` (`elevation.test.ts:42`).
- non-retryable 400 → throws *without* retrying (`overpass.test.ts:29`).
- transient 504 → retries then succeeds (`overpass.test.ts:37`).
- persistent 429 → gives up after exact retry count (`overpass.test.ts:49`).
- no results → `null` / `[]` (`geocode.test.ts:28`, `:82`).

**The BLOCKED edge case — the repo's signature subtlety:**
- steep-but-only path is *returned and flagged*, not dropped
  (`astar.test.ts:82`, `cost.test.ts:81`).
- genuinely disconnected → `null` (`astar.test.ts:91`).
- The finite/infinite distinction is pinned on both sides. → `05`.

**Verdict:** error-path coverage is real, including the retry *count* (asserting
"called 3 times" not just "threw"). The one untested error surface is the
mobile flat-fallback path (lens 1).

---

## 6. testing-ai-features (the AI-eval seam)

**Not yet exercised.** flattr has no LLM, no model inference, no probabilistic
output anywhere in the codebase. (`me.md` notes flattr is the routing project;
the AI projects are dryrun/buffr/contrl/AdvntrCue.)

```
  the eval seam — present in concept, empty in this repo

  ┌─ deterministic harness (study-testing) ─┐
  │  exists, heavily used: oracle, fixtures, │
  │  injected fetch, invariants              │
  └────────────────┬─────────────────────────┘
                   │ would wrap...
  ┌─ probabilistic core (study-ai-engineering)─┐
  │  NOT PRESENT. no model, no prompt, no      │
  │  tool dispatch, no output parsing to grade │
  └─────────────────────────────────────────────┘
```

There is one honest nuance worth stating: the *closest thing* to a
non-deterministic input in flattr is the **external elevation/OSM data** —
coarse-DEM elevation noise produces absurd grades. But the repo handles that
deterministically: it *clamps* the noise (`MAX_GRADE_PCT`, `grade.test.ts:53`)
and tests the clamp with an exact expected value. That's a deterministic
defense against noisy input, not a probabilistic eval. It stays on the testing
side of the seam.

If flattr ever added, say, an LLM to parse natural-language destinations ("the
flat way to the park"), *that* is where evals would begin — and the existing
injected-fetch + fixture discipline is exactly the harness you'd wrap around it.
The seam is ready; nothing crosses it yet.

→ Handoff target: `study-ai-engineering` for what evals look like when there
*is* a model.

---

## 7. testing-red-flags-audit (capstone checklist)

Consolidated checklist, marked against flattr.

```
  red flag                                          flattr
  ───────────────────────────────────────────────  ──────────────────
  most complex code is least tested                 ⚠ PARTIAL (mobile/
                                                      useTileGraph)
  heavy mocking that tests the mock, not the code   ✓ CLEAR (only fetch
                                                      faked; algos real)
  inverted pyramid (all slow/flaky e2e)             ✓ CLEAR (no e2e)
  tests depend on real network                      ✓ CLEAR (injected)
  tests depend on real time / sleeps                ✓ CLEAR (delayMs:0)
  tests depend on order / shared state              ✓ CLEAR (fresh
                                                      fixtures)
  unseeded randomness → flake                       ✓ CLEAR (seeded LCG)
  zero tests on error/exception branches            ✓ CLEAR (429/504/
                                                      400/status all hit)
  happy-path-only                                   ✓ CLEAR (boundaries
                                                      + errors covered)
  LLM feature untested at the deterministic seam    n/a (no LLM)
  flaky test rerun-passes with no code change       ✓ CLEAR (none)
  measurement mistaken for a test                   ⚠ NOTE: bench/ is
                                                      measurement; only
                                                      report.test.ts
                                                      asserts. Correct
                                                      as-is.
  UI / component layer untested                     ✗ FLAG (mobile/src
                                                      0 tests)
```

**Two real flags, ranked:**

1. **`mobile/src/` is entirely untested** — including `useTileGraph.ts`, the
   most complex non-algorithm file in the repo. This is the highest-leverage
   gap. The buildable target: a hook test that injects a fake `fetch` (the
   pattern already exists in `pipeline/*.test.ts`) and asserts the degraded→
   self-heal transition fires.
2. **No e2e** — acceptable for the engine's maturity, but means
   geocode→route→render is never proven together.

**The note (not a flag):** `bench/` is a measurement harness, not a test suite.
`formatTable` is unit-tested (`bench/report.test.ts`); the timing in `run.ts` is
deliberately *not* asserted (timings vary by machine — asserting on them would
be the "flaky test" red flag). That's the right call. Bench measures; tests
assert. → see `00-overview.md` and `study-performance-engineering`.
