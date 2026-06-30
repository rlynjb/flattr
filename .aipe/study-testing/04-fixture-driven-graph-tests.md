# 04 — Fixture-Driven Graph Tests

**Industry names:** *test fixtures* / *known-answer tests (KAT)* / *golden inputs*.
**Type:** Industry standard (the graph-specific shaping is project-specific).

---

## Zoom out, then zoom in

To test a router you need graphs. Real OSM graphs have thousands of nodes and no known
"correct" answer you can type into an assertion. So flattr builds tiny graphs *by hand*,
each shaped to make one routing property obvious and each with a closed-form answer you can
verify with a pencil.

```
  Zoom out — fixtures feed every routing test

  ┌─ features/routing/fixtures.ts ─── ★ THIS CONCEPT ★ ────────┐
  │  diamondGraph()      6 nodes, known shortest = S,A,G = 200  │
  │  gradeGraph()        flat-vs-steep choice, known winner     │
  │  directionalGraph()  uphill detour, downhill direct         │
  │  makeGridGraph(n)    n×n lattice, parametric                │
  └────────────────────────────┬───────────────────────────────┘
                               │ imported by EVERY routing test
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
   astar.test.ts        bidirectional.test.ts   cost / nearest tests
   (oracle, stages)     (meet-in-the-middle)    (penalty, snapping)
```

The point isn't "we have test data." It's that **each fixture is designed so the right
answer is known by construction.** The diamond's shortest path is `S,A,G` because the
builder set the lengths that way — so `expect(path.nodes).toEqual(["S","A","G"])` isn't a
guess, it's arithmetic. Known-answer fixtures are what let every other routing pattern
(the oracle, the finite-BLOCKED tests) assert against a real expected value.

---

## The structure pass

Layer it, pick the axis — **"is the expected answer known, or discovered?"** — and watch it
flip across the fixture seam.

```
  axis traced: "where does the expected answer come from?"

  ┌─ real OSM graph (mobile/assets/graph.json) ─────┐
  │  expected answer UNKNOWN — too big to verify     │  ← can't assert against
  └───────────────────────┬──────────────────────────┘
                          │  seam: fixtures.ts hand-builds a tiny graph
  ┌─ hand-built fixture ──▼──────────────────────────┐
  │  expected answer KNOWN BY CONSTRUCTION           │  ← assert exact values
  │  (the builder chose the lengths/elevations)      │
  └──────────────────────────────────────────────────┘
```

The seam is `fixtures.ts` itself. On one side, the real graph: routable but unverifiable —
you don't know the true shortest path through 10,000 nodes. On the other, the fixture:
small enough that *you set* the answer when you built it. Every routing assertion in the
repo stands on the known-answer side of this seam — which is also exactly the gap
`audit.md` lens 1 flags: nothing tests the *unknown* side (the real shipped `graph.json`).

---

## How it works

### Move 1 — the mental model

You've written a test with a setup block that creates a couple of rows in a DB before the
assertion. A fixture is that, but *designed* — not just "some data" but data shaped so the
answer is forced. The diamond graph isn't random; it has a fast route and a slow route with
lengths chosen so `S,A,G` (200) beats every alternative.

```
  the diamond fixture — shaped so the answer is forced

            A ──100── G          S→A→G = 100+100 = 200  ← the known shortest
          ╱100        ╱150
        S ──100── B ─╯           S→B→G = 100+150 = 250  (slower)
          ╲300              ╲
            D ──────300────── G  S→D→G = 600            (decoy, far)

        expected: dijkstra(S,G).path.nodes == ["S","A","G"], cost 200
```

Strategy in one sentence: **build the smallest graph that makes one property unmistakable,
and set its numbers so the answer is closed-form.**

### Move 2 — the walkthrough

**Part 1 — the builder derives grade from geometry, so fixtures stay consistent.** You
don't hand-type `gradePct` and risk it disagreeing with the elevations — the `edge()` helper
computes it:

```ts
// features/routing/fixtures.ts:10-26  (annotated)
function edge(id, from, to, lengthM): Edge {
  const riseM = to.elevationM - from.elevationM;   // rise comes from the NODES
  const gradePct = (riseM / lengthM) * 100;        // grade derived, never hand-typed
  return { id, fromNode: from.id, toNode: to.id, /* ... */
           lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) };
}
```

So when a test sets node `H` to elevation 9 and connects it with a 100m edge, the 9% grade
*follows automatically*. The fixture can't have an inconsistent grade — the data model is
enforced by the builder. That's why the fixtures are trustworthy enough to assert against.

**Part 2 — each fixture isolates exactly one property.** This is the design discipline.
Three fixtures, three jobs:

```
  one fixture, one property under test

  fixture            shape                         the property it makes obvious
  ───────            ─────                         ─────────────────────────────
  diamondGraph    flat, fast vs slow route      shortest-path correctness (oracle)
  gradeGraph      short+steep vs long+flat       grade cost prefers flat (the product!)
  directionalGraph uphill X→Y vs flat detour      direction matters (X→Y != Y→X)
  makeGridGraph(n) parametric n×n lattice         scale + heuristic pruning
```

`gradeGraph()` (`fixtures.ts:70`) is the product thesis in miniature: a short steep path via
`H` (elevation 9) and a long flat path via `L` (elevation 0). The test asserts plain A*
takes the short steep route but `gradeAstar` takes the long flat one:

```ts
// features/routing/astar.test.ts:56-63  (annotated)
const plain = astar(g, "S", "G");
expect(plain.path!.nodes).toEqual(["S", "H", "G"]);   // distance-only → steep shortcut
const flat = gradeAstar(g, "S", "G", 5);
expect(flat.path!.nodes).toEqual(["S", "L", "G"]);    // grade-aware → the flat detour
expect(flat.path!.lengthM).toBeGreaterThan(plain.path!.lengthM);  // longer, on purpose
```

The fixture is *built* so these two answers differ — that's the whole point of choosing
elevation 9 for `H`. A random graph wouldn't reliably produce this contrast.

**Part 3 — the directional fixture forces an asymmetry by overriding derived grade.**
Sometimes the property you want needs data the natural derivation won't give. The builder
handles it explicitly:

```ts
// features/routing/fixtures.ts:88-101  (annotated)
const Y = node("Y", 0, 0.001, 8);            // Y is 8m up → edge X→Y climbs 8%
// ...
// Force the detour edges flat regardless of Y's elevation, so ONLY "xy" is steep.
edges[1] = { ...edges[1], riseM: 0, gradePct: 0, absGradePct: 0 };   // xf forced flat
edges[2] = { ...edges[2], riseM: 0, gradePct: 0, absGradePct: 0 };   // fy forced flat
```

The comment names the intent: the detour `X→F→Y` must read as flat so the *only* steep edge
is the direct `xy`. Now `directedAstar(X,Y)` detours but `directedAstar(Y,X)` (downhill,
free) takes the direct edge — `astar.test.ts:74` asserts exactly that asymmetry. The
override is deliberate fixture-shaping, called out so a future reader doesn't "fix" it.

**Part 4 — `makeGridGraph(n)` is the one parametric fixture, for scale and pruning.** The
hand-built graphs prove *correctness* on tiny cases; the grid proves the engine *scales* and
the heuristic *prunes*:

```ts
// features/routing/fixtures.ts:108-128  (annotated, condensed)
export function makeGridGraph(n: number): Graph {
  // n×n lattice, node ids "row,col", ~80m edges,
  // elevation = c*3 + a ridge term  → grades vary smoothly across the grid
  // edges: each node connects right (c+1) and down (r+1)
}
```

It takes `n`, so the same fixture serves the 12×12 oracle test (`astar.test.ts:42`) and the
30×30 bidirectional pruning test (`bidirectional.test.ts:35`, which needs an *interior* pair
so Dijkstra has room to flood and bidirectional can demonstrably expand fewer nodes). One
parametric builder, many scales.

### Move 2 variant — the load-bearing skeleton

Strip a known-answer fixture to its kernel:

1. **Small enough to verify by hand** — 3 to 6 nodes. *Make it big* and you lose the known
   answer; you're back to "looks reasonable," which asserts nothing.
2. **Shaped to force one property** — the diamond forces a unique shortest path; gradeGraph
   forces a flat-vs-steep split. *Make it generic* and the property you're testing might not
   even be exercised by the data.
3. **A derived, consistent data model** — grade computed from geometry, not hand-typed.
   *Hand-type the derived fields* and they drift out of sync with the nodes, so the fixture
   lies and the test passes for the wrong reason.

The part people forget is **#2 — shaping for the property**. A common failure is reusing one
generic fixture for everything; then a test "passes" without the fixture ever exercising the
branch under test. flattr's discipline is one fixture per property, each named for what it
proves (`diamondGraph`, `gradeGraph`, `directionalGraph`).

**Skeleton vs hardening:** the kernel is small + shaped + derived-consistent. The parametric
`makeGridGraph(n)` is hardening for scale tests; the hand-built trio is the load-bearing
correctness layer.

### Move 3 — the principle

**A good fixture is a theorem you can run: you set the inputs so the output is known, then
assert the code reproduces it.** The skill isn't generating data — it's *designing* data so
the answer is closed-form and one property is unmistakable. This is why fixture-driven
testing pairs so naturally with the optimality oracle (`01`): the fixture gives the known
*input*, the oracle gives the known *relation*, and together every routing assertion stands
on solid ground. The honest limit (`audit.md` lens 1): fixtures verify the *engine*, not the
*shipped graph* — nothing here asserts the real `graph.json` is routable.

---

## Primary diagram

```
  FIXTURE-DRIVEN GRAPH TESTS — full recap

  ┌─ fixtures.ts ── the builders ──────────────────────────────┐
  │  edge() derives grade from node elevations (consistent)    │
  │     │                                                      │
  │     ├─ diamondGraph()   → known shortest S,A,G = 200       │
  │     ├─ gradeGraph()     → flat L beats steep H (the thesis)│
  │     ├─ directionalGraph→ X→Y detours, Y→X direct (override)│
  │     └─ makeGridGraph(n) → parametric lattice, scale+prune  │
  └────────────────────────────┬───────────────────────────────┘
                               │ imported fresh per test (no shared state)
                               ▼
  ┌─ assertions stand on KNOWN answers ────────────────────────┐
  │  toEqual(["S","A","G"])  ← arithmetic, not a guess         │
  │  feeds → 01 optimality oracle · 05 finite-BLOCKED tests    │
  │  gap → real graph.json (unknown answer) untested (lens 1)  │
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

These are **known-answer tests** (the term cryptographers use for "fixed input → fixed
expected output, verified by construction") plus a small **object-mother** pattern (named
builder functions that produce ready-to-use domain objects). The design discipline — one
fixture shaped per property — is what separates this from the common anti-pattern of a
single bloated shared fixture every test borrows from, where tests accidentally couple and
nobody can tell which data a given assertion actually depends on.

It's the no-mock counterpart to `03-injected-fetch-isolation.md`: the network tests fake the
*boundary*, the routing tests use *real* (if tiny) data and run the real algorithm
end-to-end. That's why the routing suite has such high signal — there's almost nothing
faked, so a green test means the real code produced the right answer on real data.

Where to read next: `01-optimality-oracle.md` (the relation that runs on these fixtures),
`05-finite-blocked-sentinel-tests.md` (the steep-graph fixtures), and `study-dsa-foundations`
for the graph representations.

---

## Interview defense

**Q: "How do you get test data for a graph router when real graphs are huge and have no
known answer?"**

> "I hand-build tiny fixtures shaped so the answer is closed-form. A 6-node diamond where I
> set the edge lengths so the shortest path is provably `S,A,G` at 200 — the assertion is
> arithmetic, not a guess. Then one fixture per property: a flat-vs-steep graph to prove the
> grade cost prefers flat, a directional graph to prove `X→Y != Y→X`. Grade is *derived* from
> node elevations in the builder, so the fixtures can't be internally inconsistent. The real
> `graph.json` is the gap — it's too big to assert against, so nothing tests routing through
> the shipped artifact end-to-end. That's `fixtures.ts` and `astar.test.ts`."

```
  sketch while you talk:

  hand-build small ─► set numbers so answer is KNOWN ─► assert exact
       │
   one fixture / property:  diamond(shortest) · grade(flat-wins) · directional(asymmetry)
```

**Anchor:** *"A good fixture is a theorem you can run — I shaped the inputs so the output is
known, one property per graph."*

**Q: "What's the weakness?"** Fixtures verify the engine, not the shipped graph. I'd add one
integration test that loads the real `graph.json`, routes between two known nodes, and
asserts a non-null path — closing the unknown-answer side of the seam.

---

## See also

- `01-optimality-oracle.md` — the relation asserted on these fixtures
- `05-finite-blocked-sentinel-tests.md` — the steep/disconnected fixtures
- `03-injected-fetch-isolation.md` — the faked-boundary counterpart (this is the no-mock half)
- `audit.md` lens 1 (the real-graph gap), lens 4 (fresh fixtures = no shared state)
- sibling guide **`study-dsa-foundations`** — graph representation theory
