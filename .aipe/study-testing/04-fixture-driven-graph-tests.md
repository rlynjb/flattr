# Fixture-Driven Graph Tests — hand-built graphs as named, reusable test scenarios

*Industry name: **test fixtures** / **object mother** (builder functions that
return ready-made test data). Type: language-agnostic technique.*

---

## Zoom out — where this sits

Every routing test needs a graph to run on. flattr doesn't build one inline in
each test — it has a small library of named graph *factories*, each
hand-designed to make one routing behavior provable. They sit beside the
engine and feed both the tests and the benchmark.

```
  Zoom out — fixtures feed the tests and the bench

  ┌─ Engine (features/routing/) ─────────────────────────────┐
  │  astar · bidirectional · cost · graph · nearest          │
  └───────────────────────────┬──────────────────────────────┘
                              │ run on
  ┌─ fixtures.ts ─────────────▼──────────────────────────────┐
  │  diamondGraph()    — known shortest path (200)           │ ← here
  │  gradeGraph()      — flat-but-long vs steep-but-short     │
  │  directionalGraph()— uphill detour vs downhill direct     │
  │  makeGridGraph(n)  — n×n lattice for scale + bench        │
  └───────────────────┬───────────────────────┬──────────────┘
                      │ consumed by            │ consumed by
                      ▼                         ▼
              astar.test.ts etc.           bench/run.ts
```

The question it answers: **how do you make a graph algorithm's behavior
*provable* instead of just *plausible*?** By hand-designing the smallest graph
where the right answer is obvious and the wrong answer is visibly wrong — then
giving it a name so every test that needs that scenario reuses it.

---

## The structure pass

**Layers.** The fixtures sit in two tiers by purpose:

- behavioral fixtures (tiny, hand-verified): `diamondGraph`, `gradeGraph`,
  `directionalGraph` — 3–6 nodes each, designed so *you* know the answer.
- scale fixture (generated, parametric): `makeGridGraph(n)` — an n×n lattice
  built by a loop, used where you need many nodes (the oracle's "too big to
  hand-check" graph) and by the benchmark.

**The axis: knowability — "do you know the right answer for this fixture?"**
Trace it across the two tiers:

- Behavioral tier: *yes, by construction.* `diamondGraph`'s shortest S→G is
  `S,A,G` length 200 because the designer made it so. The test asserts the
  exact path.
- Scale tier: *no — and that's the point.* `makeGridGraph(12)` has 144 nodes;
  nobody hand-traces the optimum. So tests on it assert against an *oracle*
  (Dijkstra), never a hardcoded path. → `01-optimality-oracle.md`.

**The seam:** the factory function boundary — `diamondGraph()` returns a *fresh*
graph each call. That seam enforces test isolation: because it's a function,
not a shared constant, a test that mutates its graph (`astar.test.ts:84`
deletes edges) can't corrupt the next test. The axis that flips across the seam
is *state ownership*: outside, the fixture is a reusable recipe; inside each
test, it's a private, disposable instance.

---

## How it works

### Move 1 — the mental model

You know how you'd write `const user = makeUser({ admin: true })` in a test
instead of constructing the whole user object inline every time? A fixture
factory is that for graphs. Each one encodes a *scenario* — "the case where a
flat detour beats a steep shortcut" — behind a name.

```
  Fixture as a named scenario

  diamondGraph()  ──►  ┌─ S ─┐         the answer is BUILT IN:
                       A     B          shortest S→G = S,A,G (200)
                       │  ×  │          test asserts exactly that.
                       └─ G ─┘
                       (+ a slow D detour and a C cross-link
                        as decoys, so "shortest" is a real choice)
```

The strategy in one sentence: **design the minimal graph where the correct
output is obvious to a human, name it, and assert the algorithm reproduces that
obvious answer.**

### Move 2 — the walkthrough

**Step 1 — derive edge properties from geometry, don't hand-set them.** The
fixture's `edge()` helper computes `riseM`, `gradePct`, `absGradePct` from the
nodes' elevations and the length — so the fixture can't lie about its own
grades. You set elevation and length; the grade follows.

```
  Pseudocode — the edge factory derives, doesn't assert

  function edge(id, from, to, lengthM):
    riseM    = to.elevationM - from.elevationM   // derived from nodes
    gradePct = (riseM / lengthM) * 100           // derived, not hand-typed
    return { id, fromNode, toNode, geometry,
             lengthM, riseM, gradePct,
             absGradePct: |gradePct| }

  // you control elevation + length; grade is computed → fixtures stay
  // internally consistent. fixtures.test.ts:33-39 PROVES this invariant.
```

The boundary condition: a fixture with hand-typed grades that don't match its
elevations would test a graph that can't exist. Deriving them closes that gap —
and a meta-test (`fixtures.test.ts:33-39`) asserts `absGradePct === |gradePct|`
across every fixture, so the fixtures themselves are under test.

**Step 2 — design each fixture to isolate ONE behavior.** Each graph is the
minimal shape that makes one routing decision provable.

```
  The three behavioral fixtures, each isolating one decision

  diamondGraph     gradeGraph          directionalGraph
  "shortest by     "flat-long beats    "uphill detours,
   distance"        steep-short"        downhill goes direct"
  ┌─ S ─┐          S───H(steep)───G    X───Y  (climbs 8%)
  A     B          S───L(flat)────G     \   /
  └─ G ─┘          (L route longer       F (flat detour)
   ↳ S,A,G=200      but chosen flat)     ↳ X→Y via F; Y→X direct
```

`gradeGraph`: the H route is shorter but climbs 9%; the L route is longer but
flat. A *distance* search picks H; a *grade* search picks L. One fixture, two
engines, opposite answers — that's the test for grade-awareness
(`astar.test.ts:55-71`).

`directionalGraph`: the X→Y edge climbs 8%. Going up, the directed engine
detours via flat F; coming down (Y→X), it takes the direct edge because
downhill is free. The fixture is built so the detour edges are *forced* flat
(`fixtures.ts:98-101`) — so only `xy` is steep, isolating the directional
asymmetry (`astar.test.ts:73-89`).

**Step 3 — the parametric scale fixture for when you can't hand-design.** When
a test needs many nodes (the oracle, the bench), `makeGridGraph(n)` builds an
n×n lattice with a smooth elevation ramp so grades vary realistically.

```
  Pseudocode — the generated grid

  function makeGridGraph(n):
    for r in 0..n, c in 0..n:
      elevation = c*3 + ridge_bump(c)        // a ramp + a ridge → varied grades
      node("{r},{c}", lat=r*Δ, lng=c*Δ, elevation)
    for each node:
      edge east  (if c+1 < n)                // 4-neighbor lattice,
      edge south (if r+1 < n)                //   80m spacing
    return assemble(...)

  // n is a knob: makeGridGraph(12) for the oracle, (30) for bidirectional,
  // larger for the benchmark. One fixture, many sizes.
```

The boundary condition that makes the grid trustworthy: it's *generated by a
loop*, so its structure is regular and verifiable by property (corner node has
degree 2, interior has degree 4 — `fixtures.test.ts:21-26`), even though its
optimal paths aren't hand-known.

**Step 4 — the fixtures are themselves tested.** `fixtures.test.ts` asserts the
fixtures have the properties the routing tests *assume*: the diamond is
connected (every node has ≥1 edge), the grid has the right node count and
adjacency degrees, and the grade invariant holds everywhere. If a fixture
silently breaks, this catches it before it produces a confusing routing-test
failure.

### Move 2 variant — the load-bearing skeleton

The kernel of a good fixture library is three parts:

1. **Factories, not constants.** Drop this (share one mutable graph object) →
   a test that mutates it corrupts the next test → order-dependent flakiness.
   Returning a fresh object per call is the load-bearing isolation property.
2. **Derived properties, not hand-typed.** Drop this → fixtures can encode
   impossible states (grade that doesn't match elevation), and you test a graph
   that can't exist.
3. **One behavior per fixture.** Drop this (one big graph for everything) → a
   test failure doesn't tell you *which* behavior broke; the fixture stops
   being a scenario and becomes noise.

Optional hardening: the parametric scale generator, the meta-tests on the
fixtures themselves. The skeleton is "fresh-per-call factory + derived
properties + one-scenario-each."

### Move 3 — the principle

**Make the right answer obvious by designing the smallest input that forces
it.** A fixture isn't just test data — it's an argument. `gradeGraph` *proves*
the router is grade-aware because no distance-only router could pass the test
on it. The discipline of "one fixture, one provable behavior" turns a pile of
tests into a readable spec of what the system does.

---

## Primary diagram

The full recap: the fixture library, what each one proves, and where it's
consumed.

```
  flattr's fixture library — full recap

  ┌─ fixtures.ts ────────────────────────────────────────────┐
  │  edge() — derives riseM/grade from nodes (can't lie)      │
  │     │                                                     │
  │     ├─ diamondGraph()     proves: shortest-by-distance    │
  │     │                     (S,A,G = 200)                   │
  │     ├─ gradeGraph()       proves: grade-aware (flat-long  │
  │     │                     beats steep-short)              │
  │     ├─ directionalGraph() proves: directional (up detour, │
  │     │                     down direct)                    │
  │     └─ makeGridGraph(n)   provides: scale, no hand-answer  │
  └───────┬───────────────────────────────┬──────────────────┘
          │ consumed by                    │ consumed by
          ▼                                 ▼
  ┌─ behavioral tests ──────┐      ┌─ oracle + scale tests ──┐
  │ astar/bidirectional     │      │ astar vs dijkstra on     │
  │ assert EXACT path       │      │ grid (assert via oracle, │
  │ (answer hand-known)     │      │  not hand-known path)    │
  └─────────────────────────┘      └──────────────────────────┘
       │                                    │
       └──── fixtures.test.ts pins the fixtures' own properties ──┘
```

---

## Implementation in codebase

**Use cases.** Every routing and bidirectional test imports from
`features/routing/fixtures.ts`. The tiny graphs (`diamond`, `grade`,
`directional`) are used where the test asserts an *exact* path because the
answer is hand-known; `makeGridGraph(n)` is used where the test needs scale and
defers to an oracle. The benchmark (`bench/run.ts`) reuses the *same*
`makeGridGraph`, so the bench and the tests run on identical graph shapes.
There's a parallel set for the build pipeline — `pipeline/fixtures.ts`
(`sampleOverpass`, `sampleElevationFn`) — used by `build-graph.test.ts`.

The deriving `edge()` factory, `features/routing/fixtures.ts:10-26`:

```
  features/routing/fixtures.ts  (lines 10-26)

  function edge(id, from: Node, to: Node, lengthM: number): Edge {
    const riseM = to.elevationM - from.elevationM;   ← derived from the nodes
    const gradePct = (riseM / lengthM) * 100;        ← derived, not hand-typed
    return {
      id, fromNode: from.id, toNode: to.id,
      geometry: [[from.lat, from.lng], [to.lat, to.lng]],
      lengthM, riseM, gradePct,
      absGradePct: Math.abs(gradePct),               ← always |gradePct|
    };                          │
  }                             └─ you set elevation + length; grade follows.
                                   This is why fixtures can't encode an
                                   impossible grade — and why the meta-test
                                   below always passes.
```

The directional fixture forcing only one steep edge,
`features/routing/fixtures.ts:88-102`:

```
  features/routing/fixtures.ts  (lines 88-102)

  export function directionalGraph(): Graph {
    const X = node("X", 0, 0, 0);
    const Y = node("Y", 0, 0.001, 8);     ← Y is 8m up → X→Y edge climbs 8%
    const F = node("F", 0.0008, 0.0005, 0);
    const edges = [ edge("xy", X, Y, 100), edge("xf", X, F, 90),
                    edge("fy", F, Y, 90) ];
    // Force the detour edges flat regardless of Y's elevation:
    edges[1] = { ...edges[1], riseM: 0, gradePct: 0, absGradePct: 0 };  ← xf flat
    edges[2] = { ...edges[2], riseM: 0, gradePct: 0, absGradePct: 0 };  ← fy flat
    return assemble("directional", nodes, edges);
  }                            │
                               └─ without this override, the F detour edges
                                  would inherit grades from F/Y elevations and
                                  muddy the test. Forcing them flat isolates
                                  "only xy is steep" → the test proves the
                                  directional asymmetry cleanly.
```

The meta-test that keeps the fixtures honest,
`features/routing/fixtures.test.ts:33-39`:

```
  features/routing/fixtures.test.ts  (lines 33-39)

  it("every edge's absGradePct equals |gradePct|", () => {
    for (const g of [diamondGraph(), gradeGraph(),
                     directionalGraph(), makeGridGraph(4)]) {
      for (const e of g.edges)
        expect(e.absGradePct).toBeCloseTo(Math.abs(e.gradePct), 9);
    }                          │
  });                          └─ a test on the test data. If a fixture ever
                                  hand-sets an inconsistent grade, this fails
                                  here — a clear "your fixture is wrong" signal,
                                  not a confusing routing-test failure 3 files
                                  away.
```

---

## Elaborate

This is the **fixture** / **object mother** pattern — builder functions that
manufacture ready-made, valid test objects so tests don't drown in setup. The
"object mother" name comes from the XP/agile testing world; the modern variant
is the "test data builder." flattr's version is the functional form: pure
factory functions returning fresh instances.

Two design choices make flattr's fixtures better than average. First, *derived
properties* — the `edge()` helper computes grade from geometry, so fixtures are
internally consistent by construction (you've done the same thing translating
`Graph2.py` to `Graph2.ts`: the edge knows its own weight). Second, *fixtures
under test* — `fixtures.test.ts` treats the test data as code that can be
wrong and pins its invariants. That second move is rare and good: it means a
broken fixture fails *as a fixture*, not as a mysterious downstream routing
failure.

The fixtures are the bridge between this folder and two siblings. They're the
graphs the oracle (`01-optimality-oracle.md`) runs on, and they're the same
graphs the benchmark (`.aipe/study-performance-engineering/`) measures — sharing
`makeGridGraph` between test and bench means the speedup the bench reports is on
the exact shape the correctness test verified. The graph structures themselves
(adjacency list, weighted edges) live in `.aipe/study-dsa-foundations/`.

---

## Interview defense

**Q: How do you write tests for a routing algorithm that prove it's actually
*grade-aware*, not just shortest-path?** A purpose-built fixture
(`gradeGraph`): a short steep route and a longer flat route between the same
two nodes. A distance-only search picks the steep one; a grade search picks the
flat one. The fixture is designed so no distance-only router could pass — so a
green test *proves* grade-awareness, it isn't just consistent with it. That's
the value of one-fixture-one-behavior.

```
  S──H(steep,short)──G   distance router → H
  S──L(flat, long )──G   grade router    → L   ← only a grade router passes
```

**Q: Why are your fixtures functions, not shared constants?** Isolation. A test
that needs to mutate the graph — `astar.test.ts:84` deletes all but one edge to
test the only-steep-path case — must not corrupt the next test. A factory
returns a fresh instance per call; a shared constant would leak mutations and
create order-dependent flakes. The load-bearing detail people forget:
fresh-per-call is what makes the suite order-independent.

**Q: You hand-build tiny graphs but generate the big one. Why the split?** The
tiny graphs have hand-known answers, so I assert the *exact* path. The 144-node
grid doesn't — nobody traces it by hand — so I assert against an oracle
(Dijkstra) instead. Hardcoding the grid's "expected path" would be both
unverifiable and brittle (it'd break when I tweak a coordinate). Knowability
decides the assertion style.

**Q: Do you test the test data itself?** Yes — `fixtures.test.ts` pins the
properties the routing tests assume (connectivity, adjacency degrees, the
grade-equals-abs invariant). A broken fixture then fails *as a fixture*, with a
clear message, instead of producing a baffling routing failure three files
away.

---

## Validate

**Reconstruct.** Write the three kernel properties of a good fixture library
(fresh-per-call, derived properties, one-behavior-each) and what flakiness or
confusion each prevents.

**Explain.** Why does `directionalGraph()` *override* the detour edges to flat
(`fixtures.ts:98-101`) instead of just setting F's elevation to 0? What would
the test lose if it didn't?

**Apply.** You add a "prefer well-lit footways at night" cost. Design the
minimal fixture that *proves* the new behavior (a shortcut that's dark vs a
detour that's lit) and say what the test asserts.

**Defend.** A reviewer says "`makeGridGraph` is overkill — just use a 3×3."
When is the big grid actually necessary, and when would a 3×3 do? (Hint: the
oracle's "too big to hand-check" only bites at scale; the A*-expands-fewer-nodes
assertion needs enough nodes for the heuristic to prune.)

References: `features/routing/fixtures.ts:10-129`,
`features/routing/fixtures.test.ts:4-41`, `features/routing/astar.test.ts:55-96`,
`pipeline/fixtures.ts:8-25`.

---

## See also

- `01-optimality-oracle.md` — `makeGridGraph(12)` is the "too big to
  hand-check" graph the oracle runs on.
- `03-injected-fetch-network-isolation.md` — `pipeline/fixtures.ts`
  (`sampleOverpass`), the build-pipeline fixtures.
- `05-finite-blocked-sentinel-tests.md` — the only-steep-path fixture mutation
  (`astar.test.ts:82-89`) that tests the BLOCKED case.
- `audit.md` §2 (integration tests), §4 (fresh-per-call isolation).
- `.aipe/study-dsa-foundations/` — the graph structures the fixtures build.
- `.aipe/study-performance-engineering/` — the bench reuses `makeGridGraph`.
