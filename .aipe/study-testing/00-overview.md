# 00 — Overview: how flattr proves it works

One page. The shape of the suite, the single question it's organized around,
and the verdict on what's strong and what's missing.

---

## Zoom out — where the tests sit

The whole system is a build-time pipeline that bakes a static `graph.json`, and
a runtime router over it. Tests bracket the parts that have a *checkable*
answer.

```
  flattr — where the 130 tests land

  ┌─ BUILD-TIME pipeline (Node, run once) ──────────────────────┐
  │  OSM fetch → split → grade → elevation → build-graph         │
  │  ★ tested with INJECTED fetch (no real network) ★            │ ← tested
  └───────────────────────────────┬─────────────────────────────┘
                                  │ emits graph.json
  ┌─ RUNTIME engine (pure TS) ────▼─────────────────────────────┐
  │  pqueue → dijkstra → astar → gradeAstar → directedAstar      │
  │  → bidirectional   ★ proven by OPTIMALITY ORACLE ★           │ ← tested
  └───────────────────────────────┬─────────────────────────────┘
                                  │ consumed by
  ┌─ MOBILE app (Expo / React Native) ──────────────────────────┐
  │  MapScreen, GradeSlider, useTileGraph (on-device rerun)      │
  │  ✗ ZERO tests ✗                                              │ ← gap
  └─────────────────────────────────────────────────────────────┘
```

The pure middle layer is tested to the hilt. The two ends — the live network
on one side, the UI on the other — are where coverage thins or vanishes.

---

## The one axis: how is correctness *proven*?

Pick one question and trace it across the suite. The answer changes by layer,
and that contrast is the whole lesson.

```
  axis = "what makes the assertion trustworthy?"

  pqueue       → INVARIANT + ORACLE   heap property holds after 2000 random
                                      ops; pops match a sorted array (50 seeds)
  astar        → ORACLE               A* cost EQUALS Dijkstra cost (the gate)
  bidirectional→ ORACLE               matches Dijkstra / directedAstar cost
  cost/grade   → CLOSED-FORM          assert the exact penalty formula value
  pipeline     → FIXTURE + FAKE FETCH known input, injected response, known out
  fixtures     → HAND-COMPUTED        diamond's S→A→G = 200, baked in by hand
```

Three proof strategies show up, in rough order of strength:

1. **Oracle** — compute the answer a *second, independent* way and demand
   agreement. Strongest. You don't have to know the answer; you only have to
   trust that two methods can't both be wrong the same way. → `01`.
2. **Invariant** — assert a property that must hold for *any* input, then throw
   thousands of random inputs at it. → `02`.
3. **Hand-computed expectation** — you worked out the answer yourself and pinned
   it (`lengthM).toBe(200)`). Cheapest, most brittle, fine for tiny fixtures.

The router uses #1 and #2 precisely because #3 doesn't scale to a 144-node grid
where no human knows the optimal cost.

---

## Verdict — strong, with two honest holes

**What's strong (rank order):**

- **The optimality oracle** (`features/routing/astar.test.ts:38`). A* must
  return the *same cost* as Dijkstra on a 12×12 grid. This is the single most
  load-bearing test in the repo — it's the only thing standing between a
  plausible-looking wrong path and a correct one. If you change `cost.ts`, this
  test is what catches an inadmissible heuristic.
- **Property tests on the heap** (`features/routing/pqueue.test.ts:67`). 2000
  random push/pop ops, invariant checked every step; plus a 50-seed sorted-order
  oracle. The hand-rolled heap is the foundation under Dijkstra — a silent bug
  here corrupts every route.
- **Network isolation by injected fetch** (`pipeline/*.test.ts`). Every I/O
  function takes a `fetch` parameter; tests pass `vi.fn()`. The suite never
  touches the real Overpass/Open-Meteo/Nominatim APIs. 307ms, zero flake.
- **Finite-`BLOCKED` discipline** (`features/routing/cost.test.ts:55`,
  `astar.test.ts:82`). The repo's most subtle correctness rule — "too steep" is
  a large *finite* number, not `Infinity` — is pinned by tests on both the cost
  function and the router that honors it.

**What's missing (rank order):**

- **Mobile/UI: zero tests.** `mobile/src/` (`MapScreen.tsx`, `GradeSlider.tsx`,
  `AddressBar.tsx`, `RouteSummaryCard.tsx`, `useTileGraph.ts`) has no test at
  all. No component test, no hook test, no render test.
- **The on-device rerun path is untested.** `mobile/src/useTileGraph.ts` (290
  lines) holds the live viewport-fetch, the flat-elevation fallback, and the
  self-heal retry loop. It re-runs the *same* pipeline functions the build uses
  — which *are* tested — but the orchestration around them (degraded state,
  cache, retry timing) has no coverage.
- **No e2e.** Nothing exercises geocode → route → render end to end.

The gaps are at the edges (live network behavior, UI), not in the core
algorithm. For a project whose stated point is "the graph work is the point,"
that's the right place to have spent the test budget — but the mobile hole is
real and growing as `useTileGraph` accretes logic.

→ Full lens-by-lens detail in `audit.md`. The techniques in `01`–`05`.
