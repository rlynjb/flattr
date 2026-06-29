# 04 — Fixture-Driven Graph Tests

**Industry names:** test fixtures · golden inputs · the Object Mother / factory
pattern · "known-answer tests." **Type:** Industry standard (the
named-topology factory set is project-shaped).

---

## Zoom out — where this lives

The routing tests don't run on the real `graph.json` (144k+ edges, no known
optimum). They run on hand-built micro-graphs whose answers are computable by
hand — and those fixtures are a shared, named module, not inline literals.

```
  Zoom out — fixtures feed every routing test

  ┌─ features/routing/fixtures.ts ──────────────────────────────┐
  │  diamondGraph()  gradeGraph()  directionalGraph()           │
  │  makeGridGraph(n)            ← named topologies, known answers│ ← we are here
  └───────────────────────────────┬─────────────────────────────┘
            consumed by            │
  ┌───────────────────────────────▼─────────────────────────────┐
  │ astar.test  bidirectional.test  cost (via edge helper)       │
  │ + bench/run.ts (same fixtures power the benchmark)           │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: each fixture is a *named topology built to exercise one behavior*. The
diamond has a known shortest path. The grade graph has a flat-vs-steep choice.
The directional graph has uphill/downhill asymmetry. The name tells you what the
graph is *for* — so a test reading `gradeGraph()` already announces its intent.

---

## Structure pass

**Layers:** the fixture factory (data construction) under the tests (assertions).
The seam is the factory boundary — what each `*Graph()` promises its callers.

**Axis — "what behavior does this fixture isolate?"** Each topology answers it
differently, and that's why there are several rather than one:

```
  axis = "which routing behavior does this graph make checkable?"

  diamondGraph()     → shortest-path-by-distance (S→A→G = 200)
  gradeGraph()       → flat-vs-steep PREFERENCE (long flat beats short steep)
  directionalGraph() → uphill/downhill ASYMMETRY (A→B ≠ B→A)
  makeGridGraph(n)   → SCALE (too big to eyeball → forces the oracle)
```

Each fixture is the minimal graph that makes one property visible. Adding nodes
would muddy the signal; removing any would collapse the behavior.

**Seam:** the factory return — a fresh `Graph` object every call.

---

## How it works

### Move 1 — the mental model

You've set up a small known data structure at the top of a test so the assertion
has something concrete to check — a 3-row array, a sample user object. A fixture
factory is that, promoted to a named, reusable function with the *answer designed
in*. `diamondGraph()` isn't a random graph; it's built so S→A→G = 200 by
construction, and the test's job is just to confirm the router finds it.

```
  fixture = topology + KNOWN answer, designed together

   diamondGraph()
        S
       ╱ ╲
   100╱   ╲100        known: shortest S→G = S,A,G = 200
     A     B          (the S,B,G path is 100+150 = 250)
   100╲   ╱150
       ╲ ╱
        G
```

### Move 2 — the walkthrough

**The builder derives physics from geometry, so fixtures stay honest.** The
`edge()` helper computes length/rise/grade from the nodes rather than letting the
author type arbitrary numbers — so a fixture can't accidentally claim a
physically impossible edge:

```ts
// fixtures.ts:10-26 — grade is DERIVED, not hand-typed
function edge(id, from, to, lengthM): Edge {
  const riseM = to.elevationM - from.elevationM;     // from the nodes
  const gradePct = (riseM / lengthM) * 100;          // real grade
  return { id, fromNode: from.id, toNode: to.id,
           geometry: [[from.lat, from.lng], [to.lat, to.lng]],
           lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) };
}
```

This is the load-bearing design choice: the *only* free parameter is `lengthM`;
everything else is computed. A fixture's grade is always consistent with its
elevations, so a test can trust it. When a fixture *needs* an inconsistency (force
a detour flat regardless of elevation), it overrides explicitly and says why:

```ts
// fixtures.ts:98-100 — explicit override, commented
// Force the detour edges flat regardless of Y's elevation, so only "xy" is steep.
edges[1] = { ...edges[1], riseM: 0, gradePct: 0, absGradePct: 0 };
```

**The known answer is baked in and asserted directly.** The diamond's optimum is
hand-computed, so its test is a *known-answer test* — no oracle needed for the
base case:

```ts
// astar.test.ts:7-12 — the hand-computed anchor of the whole oracle chain
const r = dijkstra(diamondGraph(), "S", "G");
expect(r.path!.nodes).toEqual(["S", "A", "G"]);   // known by construction
expect(r.path!.lengthM).toBe(200);
expect(r.path!.cost).toBe(200);
```

This is the root of the oracle chain in `01`: the diamond's known answer
validates Dijkstra, then Dijkstra validates everything else. The fixture is
where "trusted reference" gets its trust.

**Fresh instance per call — no shared mutable state.** Every fixture is a
function returning a *new* object, so tests that mutate (add an isolated node to
test disconnection) don't leak into other tests:

```ts
// astar.test.ts:91-96 — mutates a LOCAL copy, safe because fixture is fresh
const g = directionalGraph();            // fresh graph, this test owns it
g.nodes["ISO"] = { id: "ISO", ... };     // mutate freely
g.adjacency["ISO"] = [];
expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();
```

That's why `audit.md` lens 4 marks "order/shared-state dependence" CLEAR — the
factory pattern makes cross-test contamination structurally impossible.

```
  why a factory, not a shared const

  shared const G          factory diamondGraph()
  ──────────────          ──────────────────────
  test A mutates G   →    test A gets its own G
  test B sees the    ✗    test B gets a fresh G  ✓
  mutation (flake)        (isolated by construction)
```

**The grid fixture exists specifically to defeat hand-verification.**
`makeGridGraph(12)` builds 144 nodes with a smooth elevation ramp — deliberately
too large to eyeball, which is *why* the oracle (`01`) is needed for it. The
fixture set is designed as a pair with the verification strategy: small graphs
→ known-answer tests; large graphs → oracle tests.

### Move 2 variant — the load-bearing skeleton

```
  a named factory per behavior
  +  physics DERIVED from geometry (consistent by construction)
  +  a fresh instance per call (isolation)
  +  the answer designed in (known) OR designed too-big (oracle)
```

What breaks without each:

- **Inline literals instead of named factories** → every test rebuilds the graph,
  duplication everywhere, and the intent ("this is the grade-choice graph")
  disappears into a wall of coordinates.
- **Hand-typed grades instead of derived** → a fixture can claim a physically
  impossible edge, and a test passing on a lie is worse than no test.
- **Shared const instead of factory** → one mutating test poisons the rest.
- **Only small fixtures** → you never stress the heuristic; the oracle has
  nothing big to run on.

### Move 3 — the principle

**A good fixture is the smallest input that makes one behavior checkable, with
its answer designed in.** Name it for the behavior, derive its internals so it
can't lie, and return a fresh copy so tests stay isolated. The deeper pairing:
fixtures and verification strategy are co-designed — small known-answer fixtures
seed the trust that large oracle-tested fixtures then propagate. You can't have
the oracle chain in `01` without the diamond's hand-computed root here.

---

## Primary diagram

```
  fixtures.ts — topologies co-designed with verification

  ┌─ small, KNOWN-ANSWER (seed the trust) ──────────────────────┐
  │  diamondGraph()      S→A→G = 200   (hand-computed)          │
  │  gradeGraph()        flat beats steep (known node lists)    │
  │  directionalGraph()  A→B ≠ B→A     (known asymmetry)        │
  └───────────────────────────┬─────────────────────────────────┘
                              │ trust flows up via the oracle (01)
  ┌─ large, ORACLE-TESTED (propagate the trust) ──▼─────────────┐
  │  makeGridGraph(12/30)   144–900 nodes, no human knows the   │
  │  optimum → A* must EQUAL Dijkstra cost                       │
  └─────────────────────────────────────────────────────────────┘

  every edge: grade DERIVED from geometry · fresh instance per call
```

---

## Elaborate

This is the Object Mother / test-data-builder pattern (Fowler), specialized to
graph topologies. The "derive physics from geometry" rule is what keeps these
fixtures from rotting into lies — a common failure mode where hand-maintained
test data drifts out of sync with what the system considers valid. The same
factories power `bench/run.ts`, so the benchmark and the correctness tests share
inputs — a nice property: the thing you measure is the thing you verified. The
one extension worth noting: there's no fixture for the *real* `graph.json` shape
at scale, so build-pipeline behavior on production-sized data is only covered by
the small `sampleOverpass()` fixture in `build-graph.test.ts`. Fine for now;
worth a golden-file test if graph-building logic grows.

---

## Interview defense

**Q: Why not test the router on the real graph?**

> Because the real graph has no known optimum — you can't assert a path is
> *correct* against it. So I use named micro-fixtures with the answer designed
> in: `diamondGraph()` is built so S→A→G = 200, and the test confirms the router
> finds it. The grades are derived from node geometry, so the fixture can't claim
> a physically impossible edge.

```
  diamondGraph()  →  known: S,A,G = 200  →  test confirms router finds it
```

**Q: How do you keep fixtures from causing test-order flake?**

> Make each fixture a factory that returns a fresh instance, not a shared const.
> A test that needs to mutate the graph (add a disconnected node to test the null
> path, `astar.test.ts:91`) mutates its own copy — nothing leaks. Anchor: "a
> fixture is the smallest input that makes one behavior checkable, and a fresh
> copy every call."

---

## See also

- `01-optimality-oracle.md` — the diamond's known answer roots the oracle chain.
- `03-injected-fetch-isolation.md` — `sampleOverpass()` is the pipeline-side fixture.
- `05-finite-blocked-sentinel-tests.md` — `directionalGraph` powers the BLOCKED tests.
- `audit.md` lens 2, lens 4.
- sibling `study-dsa-foundations` — the graph representation under test.
