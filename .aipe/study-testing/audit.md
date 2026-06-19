# Pass 1 — the testing audit (7 lenses)

One `##` section per lens. Each names what the codebase actually does with
`file:line` grounding, or emits `not yet exercised`. Significant findings
cross-link to the Pass 2 pattern files.

Baseline for everything below: `npx vitest run` → **130 tests, 22 files,
282ms, all green** (2026-06-19). Config: `vitest.config.ts` — `globals:
true`, `include: ["**/*.test.ts"]`, `passWithNoTests: true`. Test runner is
the only test dependency; no coverage plugin, no CI.

---

## 1. what-is-tested-and-what-isnt (the risk map)

The coverage shape is the headline finding: **the most complex, most
load-bearing code is the most tested, and the untested code is the lowest-risk
UI glue.** That's the inversion of the classic red flag, and it's correct.

What's tested, ranked by how much the project depends on it:

| Area | Test file | What it pins |
|---|---|---|
| A* / Dijkstra / directed / bidirectional | `features/routing/astar.test.ts`, `bidirectional.test.ts` | optimal-cost correctness, the A*-vs-Dijkstra gate |
| Binary heap | `features/routing/pqueue.test.ts` | heap invariant + sorted-pop oracle |
| Cost function | `features/routing/cost.test.ts` | piecewise penalty, BLOCKED sentinel |
| Graph helpers | `features/routing/graph.test.ts` | adjacency, directed grade, edge lookup |
| Grade classify/zones | `features/grade/classify.test.ts`, `zones.test.ts` | band thresholds, p85 percentile |
| Map shaping | `features/map/geojson.test.ts`, `tiles.test.ts` | coord flip, directed coloring, tile stitch |
| Pipeline (build-time) | `pipeline/*.test.ts` (8 files) | parse → split → grade → build, all mocked |
| Geo math | `lib/geo.test.ts` | haversine distance + symmetry |
| Bench report | `bench/report.test.ts` | table formatting |

What's **not yet exercised**, with the risk each carries:

- **`mobile/src/` — all 7 components/hooks, zero tests.** `MapScreen.tsx`,
  `useTileGraph.ts`, `loadGraph.ts`, `AddressBar.tsx`, `GradeSlider.tsx`,
  `Legend.tsx`, `RouteSummaryCard.tsx`. Risk: medium. The engine they call is
  pinned, but the wiring (which userMax gets passed, which tiles get loaded,
  how a "no route" result renders) is unverified. The recent commit history
  (`fix: load grades for the whole visible screen`, `fix: fetch the whole
  viewport`) shows this is exactly where the live bugs have been — and those
  fixes shipped with no regression test. **This is the biggest gap.**
- **`pipeline/run-build.ts`** — the top-level orchestrator that wires the
  build steps and writes `graph.json`. The *steps* are each tested; the
  orchestration isn't. Risk: low (it's straight-line glue).
- **`mobile/scripts/sync-engine.mjs`** — copies the engine into mobile. No
  test. Risk: low, but a silent sync failure would ship a stale engine.

Red-flag check: **passed.** The most important code is not the least tested;
the reverse holds.

---

## 2. test-design-and-levels (the pyramid as-built)

The pyramid is healthy and bottom-heavy — exactly what you want for a pure-
logic engine.

```
  Test levels in flattr — a correct, wide-bottom pyramid

         ╱╲          (none) e2e / component — not yet exercised
        ╱  ╲
       ╱────╲        integration: buildGraph end-to-end
      ╱      ╲       (pipeline/build-graph.test.ts:21-58),
     ╱        ╲      tile merge+route (tiles.test.ts)
    ╱──────────╲
   ╱            ╲    unit: ~110 of 130 — astar, pqueue, cost,
  ╱──────────────╲   classify, geo, parseOsm, splitWays …
```

- **Unit-dominant.** Most tests are a pure function in, a value out:
  `penalty(2, max)` → `DEFAULT_K1 * 2` (`cost.test.ts:38`), `haversine(...)`
  within 0.5% (`geo.test.ts:11-15`).
- **Real integration where it counts.** `build-graph.test.ts:21-58` runs the
  *whole* pipeline (overpass fixture → split → grade → build) and then asserts
  the output is routable by Dijkstra (`build-graph.test.ts:42-49`) — an
  integration test that crosses the pipeline/engine seam with a real graph,
  not a mock. `tiles.test.ts` does the same across the tile-merge seam:
  build two tiles, stitch, route across the seam (`tiles.test.ts` —
  `stitchGraph` block).
- **Mocking is surgical, not pervasive.** The only mocks are `vi.fn()`
  fakes standing in for `fetch` at the network boundary
  (`elevation.test.ts:28`, `overpass.test.ts:20`, `geocode.test.ts:6`). The
  engine has *no* mocks — it's all real graphs. → see
  `03-injected-fetch-network-isolation.md`.

Red-flag check: **passed.** No inverted pyramid, no over-mocking that tests
the mock instead of the code. The mocks sit only at the genuine I/O edge.

---

## 3. tests-as-design-pressure

The suite is easy to write *because the engine was designed deep and pure*.
This is a `study-software-design` observation surfaced here, not re-audited
(see `.aipe/study-software-design/` for the deep-module treatment).

The evidence that the design enables the tests:

- **`search()` takes its cost and heuristic as parameters**
  (`features/routing/astar.ts:22-29`). Because the four "stages" (Dijkstra,
  A*, grade, directed) are just `(costFn, heuristicFn)` choices, one test
  file exercises all four against the same fixtures with no special setup —
  `dijkstra`, `astar`, `gradeAstar`, `directedAstar` are all thin wrappers
  (`astar.ts:136-160`).
- **The PQueue knows nothing about graphs** (`pqueue.ts:1`). That isolation
  is why it can be property-tested in total isolation with random integers
  (`pqueue.test.ts`), no graph in sight.
- **Every external call is a parameter, not an import.** `geocode(query,
  { fetchImpl })`, `googleProvider(key, fetch)`, `fetchOverpass(bbox, url,
  fetch)`. The seam is in the signature, so no test needs `vi.mock()` module
  surgery — it just passes a fake. → `03-injected-fetch-network-isolation.md`.

The counter-example — where tests are *absent because the design resists
them*: the mobile components. `MapScreen.tsx` couples MapLibre rendering,
tile loading, geocoding, and routing into one screen. Testing it would need
the full Expo / `@maplibre/maplibre-react-native` harness, which is why it
has none. That's a "hard to test → tangled by nature of UI" signal, not an
engine smell.

Red-flag check: **passed** for the engine; the mobile gap is a UI-harness
cost, not a design smell in the testable core.

---

## 4. determinism-isolation-and-flakiness

Flakiness risk is **effectively zero**, and it's deliberate.

- **No clock dependency.** Nothing reads `Date.now()` or sleeps for real. The
  one place real time exists — Open-Meteo's exponential backoff
  (`pipeline/elevation.ts:114-115`, `sleep(delayMs * 2**(attempt+1))`) — is
  neutralized in tests by passing `delayMs: 0` (`elevation.test.ts:58,68`).
  So the retry *logic* is exercised without the wall-clock wait that would
  make the test slow and potentially flaky.
- **No network.** This is the load-bearing isolation property. The project
  memory warns Open-Meteo's free tier 429s under heavy testing — and the
  suite never calls it. Every `fetch` is a `vi.fn()` returning a synthetic
  `Response` (`elevation.test.ts:28-32`, `overpass.test.ts:20`,
  `geocode.test.ts:6-11`). → `03-injected-fetch-network-isolation.md`.
- **No shared mutable state.** Every test builds its own graph from a fixture
  *factory* — `diamondGraph()`, `makeGridGraph(12)` return fresh objects per
  call (`features/routing/fixtures.ts`). Tests that mutate (`g.edges =
  g.edges.filter(...)` in `astar.test.ts:84`) mutate a private copy, so order-
  independence holds.
- **Randomness is seeded.** The property tests use a hand-rolled LCG with a
  fixed seed (`pqueue.test.ts:5-11`), so "random" pushes are reproducible
  byte-for-byte across runs. A failure can be re-run and re-seen. →
  `02-property-and-invariant-tests.md`.
- **Floating-point compared with tolerance.** Optimal-cost comparisons use
  `toBeCloseTo(..., 6)` not `toBe` (`astar.test.ts:43-44`,
  `bidirectional.test.ts:13`), so haversine rounding doesn't cause spurious
  failures.

Red-flag check: **passed.** No test passes-then-fails on rerun; none requires
a specific run order. The 282ms total runtime is itself proof: nothing waits.

---

## 5. edge-cases-and-error-paths

The error and boundary branches are tested, not just the happy path. This is
where weak suites usually collapse, and flattr's holds.

- **Unreachable / disconnected:** `dijkstra` and all four engines return
  `null` (not throw, not BLOCKED) when the goal is genuinely disconnected
  (`astar.test.ts:21-27, 91-96`; `bidirectional.test.ts:47-52`).
- **Trivial path:** `start === goal` returns a one-node, zero-cost, zero-edge
  path across Dijkstra and bidirectional (`astar.test.ts:14-19`,
  `bidirectional.test.ts:54-59`).
- **Empty containers:** `PQueue` empty-on-create returns `undefined` for
  pop/peek (`pqueue.test.ts:14-21`); `nearestNode` throws on an empty graph
  (`nearest.test.ts:27-29`); `percentile([])` throws (`zones.test.ts:19-21`).
- **Divide-by-zero guard:** a zero-length edge yields grade 0, no NaN
  (`grade.test.ts:`"zero-length edge yields grade 0").
- **Bad input rejected:** `PQueue.push` throws on a NaN priority
  (`pqueue.ts:24`; covered implicitly by the property tests never feeding
  NaN, explicit guard tested by construction).
- **DEM noise clamp:** an absurd ~400% grade from coarse elevation data is
  clamped to `±MAX_GRADE_PCT` while the *true* riseM is preserved
  (`grade.test.ts:` "clamps an absurd grade").
- **The signed-grade boundary cases:** continuity at the moderate/steep band
  edge (`cost.test.ts:41-45`), penalty 0 for downhill/flat
  (`cost.test.ts:32-34`), BLOCKED above max (`cost.test.ts:55-58`).
- **Parallel-edge reconstruction:** the search must report the *exact* edge
  it relaxed, not a re-resolved-by-node-pair edge — tested with two parallel
  A→B edges, short-steep vs long-flat (`astar.test.ts:102-135`).
- **API error branches:** every external-call test has a "throws on non-OK
  response" case (`elevation.test.ts:42-46,66-70`, `overpass.test.ts:29-55`,
  `geocode.test.ts:33-36`), and the retry path is tested both ways — transient
  504 then success (`overpass.test.ts:37-47`) and exhausted retries on
  persistent 429 (`overpass.test.ts:49-55`).

Red-flag check: **passed.** Error branches are not zero-tested; they're some
of the best-tested code in the repo. → `05-finite-blocked-sentinel-tests.md`
for the most subtle one (steep-but-routable vs disconnected).

---

## 6. testing-ai-features (the AI-eval seam)

**Not yet exercised — and correctly so.** There is no LLM, no embedding, no
model call anywhere in the engine, the pipeline, or the mobile app. The
"AI" in flattr is the routing *algorithm* (informed search), which is fully
deterministic: a path cost is a number you assert exactly, not a generation
you judge.

So there is nothing here that needs the deterministic-harness-around-a-
probabilistic-core pattern. Every assertion is `toBe` / `toBeCloseTo`. If a
natural-language feature were added later (e.g. "flat loop near Cal
Anderson"), the *prompt assembly, tool dispatch, and output parsing* would be
deterministic and would be tested here; only the model's free-text output
would hand off to `study-ai-engineering`'s evals. None of that exists today.

Red-flag check: **N/A** — no AI feature to leave untested.

---

## 7. testing-red-flags-audit (capstone checklist)

The consolidated checklist, marked against this repo.

```
  flattr testing red-flag scorecard

  ┌────────────────────────────────────────────────┬───────┐
  │ red flag                                         │ this  │
  │                                                  │ repo  │
  ├────────────────────────────────────────────────┼───────┤
  │ most complex code is least tested                │  no   │
  │ inverted pyramid (all slow e2e)                  │  no   │
  │ over-mocking — tests the mock not the code       │  no   │
  │ heavy setup to reach the code under test         │  no   │
  │ tests depend on real time / clock                │  no   │
  │ tests hit the live network                       │  no   │
  │ tests require a specific run order               │  no   │
  │ shared mutable state across tests                │  no   │
  │ zero tests on error / exception branches         │  no   │
  │ unseeded randomness (irreproducible failures)    │  no   │
  ├────────────────────────────────────────────────┼───────┤
  │ no CI runs the suite on push                     │  YES  │
  │ no coverage measurement tooling                  │  YES  │
  │ mobile UI layer entirely untested                │  YES  │
  └────────────────────────────────────────────────┴───────┘
```

The three real flags are all about *reach and enforcement*, not test quality:

1. **No CI.** No `.github/workflows`. `npm test` is green on the author's
   machine; nothing guarantees it stays green on push. The fix is one
   workflow file running `npm test` + `npm run typecheck`. Given the suite is
   282ms, there's no excuse — it's the highest-leverage missing piece.
2. **No coverage tooling.** No `@vitest/coverage-v8` in `package.json`.
   Coverage is inferred from reading the suite (this audit), not measured. The
   fix is `vitest run --coverage` once the plugin is added; it would confirm
   the mobile gap quantitatively.
3. **Mobile untested.** Covered in lens 1. The buildable target: a
   render-and-assert test on `RouteSummaryCard` (pure-ish, takes a summary
   object) and a logic test on `useTileGraph`'s tile-selection math, which is
   the part that's actually had bugs.

Everything else is clean. For a hand-rolled routing engine, this is a strong
suite — the algorithm is pinned by an oracle, the heap by property tests, and
the network by injection. The gaps are at the edges (CI, mobile), not the
core.
