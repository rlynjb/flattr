# Study — Testing & Correctness (flattr)

> The question every test in this repo is answering: **how do you KNOW the
> router returns the right path — and that it'll keep doing so after the next
> change to the cost function?**

A grade-aware A* router has a brutal correctness problem: there's no obvious
"right answer" to eyeball. A path that *looks* reasonable on a map can be
sub-optimal by a few meters of cost, and you'd never catch it by hand. flattr's
test suite solves this the only honest way — it makes the *machine* prove
optimality, by computing the answer a second way and demanding the two agree.

That single move (the optimality oracle) is the spine of this guide.

---

## The seam that splits this from AI evals

```
  ┌─ study-testing (HERE) ──────────────────────────────────────┐
  │  DETERMINISTIC correctness.                                  │
  │  given a known graph, assert a known path / known cost.      │
  │  "A* cost EQUALS Dijkstra cost" — exact, repeatable.         │
  └─────────────────────────────────────────────────────────────┘
            seam = determinism
  ┌─ study-ai-engineering ──────────────────────────────────────┐
  │  PROBABILISTIC evaluation. "is the LLM output good enough?"  │
  │  flattr has NO LLM. The eval seam is NOT YET EXERCISED.      │
  └─────────────────────────────────────────────────────────────┘
```

Every assertion in this repo is the deterministic kind: `toEqual`,
`toBeCloseTo`, `toBe`. There is no model output to grade, no LLM-as-judge, no
eval set. The AI-eval seam is real and worth understanding — but in flattr it is
honestly **not yet exercised**. The audit says so plainly.

> "This code is hard to test" is a `study-software-design` finding, not a testing
> finding. Where it comes up here, it's cross-linked, not re-audited.

---

## Map of the suite

```
  130 tests, 22 files, ~307ms total — all green, all deterministic.

  features/routing/   ← the centerpiece. A* / Dijkstra / bidirectional /
                        pqueue / cost. The optimality oracles live here.
  features/grade/     ← classify (grade→band→color), zones (p85 per cell)
  features/map/       ← geojson shaping, tiling
  pipeline/           ← BUILD-TIME network I/O: osm, overpass, elevation,
                        geocode, split, grade. All fetch is INJECTED.
  lib/                ← haversine, bbox math
  bench/              ← report formatting (measurement, not assertion)

  mobile/src/         ← ZERO tests. The Expo/RN app is untested.
                        useTileGraph.ts (the on-device rerun path) untested.
```

---

## Reading order

1. **`00-overview.md`** — one-page orientation: the suite's shape, the one
   axis (how is correctness proven?), and the verdict on what's strong vs the
   gaps.
2. **`audit.md`** — Pass 1. The 7-lens audit, each lens grounded in `file:line`
   or marked `not yet exercised`. The capstone red-flag checklist closes it.
3. **Pattern files** — Pass 2. Each names a testing *technique* this repo
   applies deliberately. Read `01` first; it's the load-bearing one.

   - `01-optimality-oracle.md` — A* cost must EQUAL Dijkstra cost. The
     gold-standard correctness gate. **Start here.**
   - `02-property-invariant-tests.md` — heap invariant after 2000 random ops;
     a 50-seed sorted-order oracle. Defends a structure, not an example.
   - `03-injected-fetch-isolation.md` — every network call takes a `fetch`
     parameter; tests pass a fake. No real network in the suite.
   - `04-fixture-driven-graph-tests.md` — hand-built diamond / grade /
     directional / grid graphs with known answers baked in.
   - `05-finite-blocked-sentinel-tests.md` — `BLOCKED = 1e9`, not `Infinity`,
     so "steep route, flagged" stays distinct from "no route" — and tests pin
     that distinction.

---

## Cross-links to sibling guides

- **`study-dsa-foundations`** — the pqueue/heap and A*/Dijkstra these tests
  guard are the DSA primitives. The oracle *is* the correctness proof for them.
- **`study-software-design`** — injected `fetch` is dependency injection; the
  testability it buys is a deep-module property. "Hard to test" smells live there.
- **`study-system-design`** — the build-time pipeline vs on-device rerun split;
  the untested `useTileGraph` rerun path is a system-design surface.
- **`study-networking`** — the retry/backoff on Overpass (504→retry, 429→give
  up) that `03` tests deterministically.
- **`study-performance-engineering`** — `bench/` is the measurement harness;
  this guide explains why it is *not* a test.
- **`study-ai-engineering`** — where the eval seam would live, if flattr had a
  model. It doesn't, yet.
- **`study-frontend-engineering`** — the untested `mobile/src/` components.
