# 00 — Overview: the coverage map as a risk map

Not the percentage. The risk map. Which critical paths have tests that would catch
a real regression, and which don't.

## The whole suite in one picture

Here's flattr's test surface, drawn as the layers it covers — and the one it doesn't.

```
  flattr test coverage — by layer, by risk

  ┌─ UI layer — mobile/ (Expo / React Native) ─────────────────┐
  │  MapScreen, AddressBar, GradeSlider, useTileGraph,         │
  │  loadGraph, elevCache                                       │
  │  ████ ZERO TESTS ████   ← highest-risk gap                 │
  │  incl. the on-device rerun path in useTileGraph.ts         │
  └────────────────────────────┬───────────────────────────────┘
                               │ reads graph.json, calls into ↓
  ┌─ Routing core — features/routing/ ─────────────────────────┐
  │  astar · bidirectional · cost · pqueue · graph · nearest   │
  │  ✓✓✓ DENSELY TESTED ✓✓✓   the crown jewel                  │
  │  optimality oracle · property tests · finite-BLOCKED        │
  └────────────────────────────┬───────────────────────────────┘
                               │ consumes the artifact built by ↓
  ┌─ Build pipeline — pipeline/ (build-time only) ─────────────┐
  │  osm · overpass · elevation · geocode · split · grade      │
  │  ✓✓ WELL TESTED ✓✓   injected-fetch isolation, retry matrix │
  └────────────────────────────┬───────────────────────────────┘
                               │ pure helpers under ↓
  ┌─ Shared libs — lib/ · features/grade/ · features/map/ ─────┐
  │  geo (haversine/bbox) · classify · zones · geojson · tiles │
  │  ✓ TESTED ✓   pure functions, easy + done                  │
  └────────────────────────────────────────────────────────────┘

  ┌─ bench/ ── MEASUREMENT, not assertion (1 test, on report shape) ─┐
```

The shape to notice: **coverage is inverted in the right direction.** The most
complex, most correctness-critical code (the router) is the *most* tested. The
untested layer (mobile UI) is the layer where a bug is most visible and least
catastrophic — a wrong pixel, not a wrong route. That's the opposite of the classic
red flag ("the hardest code is the least tested"). flattr got the priority right.

## Verdict first: what's strong, what's the gap

**Strongest thing in the suite:** the optimality oracle in
`features/routing/astar.test.ts:38`. A* doesn't get asserted against a hand-typed
expected path — it gets asserted against *Dijkstra's* answer on the same graph:
`expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6)`. Dijkstra is the simple,
obviously-correct baseline; A* is the fast, easy-to-break optimization. The test says
"the fast one must agree with the slow one to 6 decimals." That is a correctness
*proof gate*, and it's the single most valuable line in the repo. Full walk in
`01-optimality-oracle.md`.

**Biggest gap, ranked worst-first:**

1. **Mobile (`mobile/src/`) — zero tests.** Eight source files, none covered. The
   one that matters: `useTileGraph.ts` stitches a route-corridor subgraph on top of the
   bundled tiles and re-runs routing on device. That's real logic (a one-build-at-a-time
   queue, a corridor-span guard at `MAX_CORRIDOR_SPAN_DEG`) with no test. Buildable
   target named in `audit.md` lens 1.
2. **No e2e / integration-through-the-app.** Every test is a unit or module test. There
   is no test that loads the real `graph.json` and routes through it end-to-end. The
   pipeline produces the artifact; nothing asserts the artifact the app actually ships
   is routable.
3. **The AI-eval seam is empty.** No LLM, no on-device model in flattr today, so lens 6
   is honestly `not yet exercised`. Not a bug — a fact. When dryrun-style on-device AI
   lands here, that's where the deterministic-harness-around-probabilistic-core test goes.

## How the five patterns map to the layers

Each Pass-2 pattern file is a technique flattr uses to *make* the green above trustworthy:

```
  layer            technique that defends it          pattern file
  ─────            ─────────────────────────          ────────────
  routing core  →  A* cost == Dijkstra cost        →  01-optimality-oracle
  pqueue        →  heap invariant after 2000 ops   →  02-property-invariant-tests
  pipeline      →  inject fetch, no real network    →  03-injected-fetch-isolation
  all of routing→  hand-built graphs, known answers →  04-fixture-driven-graph-tests
  cost/astar    →  BLOCKED is finite, not Infinity  →  05-finite-blocked-sentinel-tests
```

Read `audit.md` next for the lens-by-lens walk, then drop into whichever pattern file
matches what you want to learn to *do*, not just observe.
