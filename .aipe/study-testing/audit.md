# audit.md — the 7-lens testing audit (flattr)

Pass 1. One section per lens. Every lens walked against the real repo with `file:line`
grounding, or `not yet exercised` named honestly. Significant findings cross-link to the
Pass-2 pattern file rather than re-teaching it here.

Baseline, verified `npx vitest run` on 2026-06-29: **130 tests, 22 files, all passing,
306ms.** No skips, no `.only`, no flaky retries configured.

---

## 1. what-is-tested-and-what-isnt — the risk map

The full picture is the diagram in `00-overview.md`. The condensed verdict:

**Tested, and tested well:**

- **Routing core** (`features/routing/`): `astar.test.ts` (13), `bidirectional.test.ts`
  (6), `cost.test.ts` (many), `pqueue.test.ts` (7), `graph.test.ts` (6),
  `nearest.test.ts` (3), `fixtures.test.ts` (4), `summary.test.ts` (2). This is the
  centerpiece and it shows.
- **Build pipeline** (`pipeline/`): `osm`, `overpass`, `elevation`, `geocode`, `split`,
  `grade`, `build-graph`, `config` all have co-located tests. Network calls are isolated
  by injected `fetch` (→ `03-injected-fetch-isolation.md`).
- **Shared libs** (`lib/geo.test.ts`, `features/grade/`, `features/map/`): pure
  functions, covered.

**Not tested — ranked by risk:**

1. **`mobile/src/` — zero test files.** Confirmed: `find mobile -name "*.test.*"`
   returns nothing. Eight source files uncovered. The load-bearing one is
   `mobile/src/useTileGraph.ts` — it builds a route-corridor subgraph on device and
   re-runs the router, with a single-build-at-a-time queue (`useTileGraph.ts:164`) and a
   span guard (`MAX_CORRIDOR_SPAN_DEG = 0.12`, `useTileGraph.ts:66`) that refuses routes
   wider than ~13km. That guard logic is pure and extractable — it's a unit test waiting
   to be written.
   **Buildable target:** extract the corridor-bbox + span-check into a pure function and
   test it with three cases (in-span → ok, over-span → refuse, endpoints equal → trivial).
   Then test the merge-graph stitching against a fixture. No Expo runtime needed.
2. **No end-to-end test through the shipped artifact.** Nothing loads
   `mobile/assets/graph.json` and asserts a real route. The pipeline tests prove the
   *builder* works; no test proves the *built graph* is routable.
   **Buildable target:** a single integration test that loads the real `graph.json`, picks
   two known nodes, runs `directedAstar`, asserts a non-null path. One test closes the gap.
3. `bench/` is measurement, not assertion — by design. Its only test
   (`bench/report.test.ts`, 1 test) checks the *report shape*, not performance numbers.
   That's correct: a perf number is not a pass/fail gate. Noted so nobody mistakes the
   benchmark for coverage.

**Red flag check — "is the most complex code the least tested?"** No. Inverted the right
way: the router (most complex) is the most tested; the UI (least catastrophic on failure)
is the least tested. Good prioritization.

---

## 2. test-design-and-levels — the pyramid as-built

```
  flattr's pyramid

        ╱ e2e ╲              ← NONE. no app-level / through-artifact test
       ╱───────╲
      ╱ integr. ╲           ← THIN. pipeline module tests stitch 2-3 units
     ╱───────────╲             (build-graph.test.ts), but nothing app-wide
    ╱   unit       ╲         ← WIDE. ~all 130 tests. module-level, fast (<1ms each)
   ╱_______________╲
```

It's a **wide-base, no-tip pyramid.** Almost everything is a fast unit/module test. The
integration band is thin but real: `pipeline/build-graph.test.ts:1` exercises the
osm→split→grade→graph assembly together. There is no e2e tip.

**The good news — no over-mocking.** The classic level-design failure is unit tests so
mocked they test the mock, not the code. flattr mostly *doesn't* mock; it uses real
hand-built fixtures (→ `04-fixture-driven-graph-tests.md`). The only mocking is the
injected `fetch` at the network boundary (→ `03`), which is mocking the *right* seam — the
external world — while running the real parsing/retry code against it. `overpass.test.ts`
asserts the real query string and the real retry count, not "the mock was called."

**Where the pyramid is honestly weak:** no integration test crosses the
pipeline→artifact→app boundary. The three layers are each tested in isolation; the seams
*between* them aren't.

---

## 3. tests-as-design-pressure — untestable code as a smell

flattr is a near-textbook case of testability *earned by design*, so this lens is mostly a
positive finding. Three concrete enablers:

- **`PQueue` is decoupled from the domain.** `features/routing/pqueue.ts:1` — *"Knows
  nothing about graphs/grades."* Because it's a generic `PQueue<T>`, its test
  (`pqueue.test.ts`) hammers it with raw `(number, priority)` pairs and a property-based
  invariant check — no graph setup required. A `PQueue` tangled into the router would need
  a whole graph to test one heap op.
- **`CostFn` is a plain function value.** `cost.ts:25-33` exposes `distanceCost`,
  `gradeCostAbs`, `gradeCostDirected` as standalone `CostFn`s. The search engine
  (`astar.ts:22 search(...)`) takes the cost function as a *parameter*. That seam is why
  `cost.test.ts` can test penalty math directly on one edge with zero search involved, and
  why `bidirectional.test.ts:8` can pass `distanceCost` vs `gradeCostDirected` to compare
  engines on identical cost.
- **`checkInvariant()` is a test-only seam built into the data structure.**
  `pqueue.ts:42` — a method that exists purely so the property test can assert the heap
  property from outside. That's deliberate design-for-testability.

**The one smell:** `mobile/src/useTileGraph.ts` mixes React effects, a build queue, and
pure corridor-geometry math in one hook. The pure math (span check, bbox union) is trapped
behind `useEffect`/`useState`, which is *why* it has no test. This is the
software-design "deep module / extract the pure core" finding — cross-linked to
**`study-software-design`**, not re-audited here. The fix is the extraction named in
lens 1.

---

## 4. determinism-isolation-and-flakiness

This is flattr's quiet superpower. **The suite is fully deterministic.** Walked every
axis a flaky test depends on:

```
  flakiness source     flattr's defense                    where
  ────────────────     ────────────────                    ─────
  network              injected fetch, never real          elevation/overpass tests
  time / delays        delayMs: 0 passed into every        elevation.test.ts:58,68
                       retrying provider                   overpass.test.ts:32+
  randomness           seeded LCG, not Math.random()       pqueue.test.ts:5
  test ordering        no shared mutable state across      every test builds its
                       tests; each builds its own graph    own fixture fresh
  wall-clock           none — no Date.now in assertions    —
```

- **Network: zero real sockets.** `grep "fetch(" --include="*.test.ts"` finds none — every
  network-touching test passes a `vi.fn` mock fetch (→ `03-injected-fetch-isolation.md`).
- **Time: every retrying code path takes `delayMs: 0` in tests.** `elevation.test.ts:58`
  passes `{ delayMs: 0 }`; `overpass.test.ts` passes it on every retry case. The retry
  *logic* runs; the retry *waits* don't. No real `setTimeout` stalls the suite.
- **Randomness: seeded, reproducible.** `pqueue.test.ts:5` defines a deterministic LCG
  (`s = (1664525 * s + 1013904223) >>> 0`) instead of `Math.random()`. The 2000-op
  invariant test and the 50-seed oracle produce the *same* sequence every run — a failure
  is reproducible, not a one-in-a-thousand ghost (→ `02-property-invariant-tests.md`).
- **Ordering: no shared state.** Each test calls `diamondGraph()` / `makeGridGraph(n)`
  fresh (`fixtures.ts`). Tests that mutate a graph mutate their *own* copy
  (`astar.test.ts:22-26` adds an `ISO` node to a fresh graph). Run them in any order; same
  result.

**Flaky-test count: 0.** No `retry` config in `vitest.config.ts`, no quarantined tests, no
`.skip`. Red stays red. This is the property that makes the green trustworthy.

---

## 5. edge-cases-and-error-paths

The happy path is usually all a suite tests. flattr tests the *branches*. Concrete error
and boundary coverage:

- **The three-way routing outcome is fully covered:** optimal path / steep-but-returned /
  genuinely-null. `astar.test.ts:82` (steep path returned + `steepEdges` flagged),
  `astar.test.ts:91` (null only when disconnected, not when merely steep). This is the
  finite-BLOCKED distinction made testable (→ `05-finite-blocked-sentinel-tests.md`).
- **Trivial / degenerate inputs:** `start === goal` (`astar.test.ts:14`,
  `bidirectional.test.ts:54`), unreachable goal (`astar.test.ts:21`), empty queue
  (`pqueue.test.ts:14` — `pop()`/`peek()` return `undefined`, don't throw).
- **The penalty function's every band is pinned, including its boundaries:** flat/downhill
  → 0 (`cost.test.ts:32`), linear band, the *continuity at the moderate/steep boundary*
  (`cost.test.ts:41` — asserts the quadratic meets the linear piece), quadratic band, and
  over-max → `BLOCKED` (`cost.test.ts:55`). Boundary-value testing done properly.
- **NaN guard:** `pqueue.ts:24` throws on `NaN` priority; the design forbids a class of
  silent-corruption bug. (The throw path itself isn't asserted in a test — minor gap.)
- **Network error branches:** non-retryable 400 throws without retrying
  (`overpass.test.ts:29`), transient 504 retries then succeeds (`:37`), persistent 429
  exhausts retries (`:49`), Google `REQUEST_DENIED` rejects (`elevation.test.ts:42`). The
  full retry matrix is exercised (→ `03`).

**Gaps:** the `PQueue` NaN-throw branch and some pipeline parse-error branches aren't
directly asserted. Minor — the load-bearing error paths (routing outcomes, network retry,
penalty boundaries) are covered.

---

## 6. testing-ai-features — the deterministic-harness-around-probabilistic-core seam

**Not yet exercised.** Honest finding: flattr has no LLM and no on-device model today. The
router is pure deterministic graph search; the pipeline calls elevation/geocoding HTTP
APIs, but those return deterministic numbers, not probabilistic generations. There is no
prompt assembly, no tool dispatch, no model output to parse — so there is nothing on the
probabilistic side of the determinism seam to wrap.

This is the seam the spec flags, stated for when it *does* apply: flattr's sibling project
dryrun runs Gemini Nano on-device with an API fallback, and the project context notes a
mobile "on-device rerun path." **If** flattr grows that, the test split is:

```
  deterministic harness (HERE)        probabilistic core (study-ai-engineering)
  ───────────────────────────         ─────────────────────────────────────────
  does the prompt assemble right?     is the model's grade-guess good enough?
  does tool dispatch route to         did quality regress vs the eval set?
    directedAstar with right args?    (LLM-as-judge, eval sets)
  does output parsing handle a
    malformed model response?
  ← all deterministic, testable HERE  ← non-deterministic, evaluated THERE
```

The injected-fetch pattern flattr already uses (→ `03`) is exactly the seam an LLM call
would slot into — inject the model client, return a recorded response, assert the
deterministic wrapper. The infrastructure is in place; the AI feature isn't.

---

## 7. testing-red-flags-audit — the consolidated checklist

The capstone. Every common testing red flag, marked against this repo.

```
  red flag                                          flattr verdict
  ────────────────────────────────────────────     ──────────────
  hardest/most-complex code is least tested         ✓ CLEAR (inverted right way)
  tests the mock, not the code (over-mocking)        ✓ CLEAR (mocks the network seam
                                                       only; real code runs against it)
  flaky — passes/fails on rerun, no code change      ✓ CLEAR (seeded RNG, delayMs:0,
                                                       injected fetch — fully determ.)
  order-dependent tests                              ✓ CLEAR (no shared mutable state)
  real network / wall-clock in tests                 ✓ CLEAR (zero real fetch calls)
  zero coverage on error/exception branches          ✓ CLEAR (retry matrix, null paths,
                                                       penalty boundaries all tested)
  inverted pyramid (all slow e2e)                    ✓ CLEAR (wide fast unit base)
  ──────────────────────────────────────────────    ──────────────
  no e2e / integration through the shipped artifact  ✗ PRESENT — pipeline + app +
                                                       graph.json seams untested together
  an entire layer with zero tests                    ✗ PRESENT — mobile/src/ (8 files,
                                                       incl. useTileGraph rerun logic)
  AI feature with no boundary test                   ⊘ N/A — no AI feature yet (lens 6)
  pure logic trapped behind framework effects        ⚠ MINOR — useTileGraph corridor math
                                                       extractable but not extracted
```

**The honest one-line summary:** for the code it covers, flattr's suite is among the best
you'll see in a side project — deterministic, oracle-gated, property-tested, no
flake. Its two real gaps are *absence*, not *rot*: a whole untested layer (mobile) and a
missing seam-spanning e2e. Both are closable with a handful of tests, named above.
