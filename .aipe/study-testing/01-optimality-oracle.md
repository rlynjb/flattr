# Optimality Oracle — testing an optimization against its slow, simple ground truth

*Industry name: **oracle test** / **differential testing** against a
reference implementation. Type: language-agnostic technique.*

---

## Zoom out — where this sits

This is the single most important test in the repo. It lives in the routing
core, guarding the boundary between "the algorithm we wrote" and "the answer
that's actually correct."

```
  Zoom out — the oracle guards the optimization

  ┌─ Engine (features/routing/) ─────────────────────────────┐
  │                                                          │
  │  dijkstra()  ── the SLOW, obviously-correct baseline     │
  │      │                                                   │
  │      │  same graph, same start/goal                      │
  │      ▼                                                   │
  │  ★ ORACLE TEST ★  assert  astar.cost == dijkstra.cost    │ ← here
  │      ▲                                                   │
  │      │                                                   │
  │  astar()  ── the FAST, easy-to-get-wrong optimization    │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
            │
            ▼  if they disagree, the heuristic is inadmissible
       the test fails — the bug is caught before a user sees
       a "shortest" route that isn't shortest
```

Here's the question it answers: **A* is only worth shipping if it returns the
same optimal answer as the dumb baseline, just faster.** Speed without
correctness is a routing engine that confidently sends you up a hill that
wasn't on the cheapest path. The oracle is how you *know* the speedup didn't
silently break the answer.

---

## The structure pass

**Layers.** Two implementations of one contract ("find the cheapest path
S→G"), stacked by trust:

- outer: the optimization under test (`astar`) — fast, fragile, the thing you
  actually ship.
- inner: the reference oracle (`dijkstra`) — slow, simple, the thing you
  trust without testing because it's too dumb to be wrong.

**The axis: correctness — "who do you trust to be right?"** Trace it down the
stack and watch it flip:

- At `astar`: *not trusted by default.* Its correctness depends on the
  heuristic staying admissible (never overestimating the remaining cost). One
  bad heuristic and it returns a wrong-but-plausible path.
- At `dijkstra`: *trusted by construction.* It explores by uniform-cost
  flooding — no heuristic to get wrong. It's the ground truth.

**The seam:** the `expect(astar.cost).toBeCloseTo(dijkstra.cost)` assertion.
That line is where the trusted answer meets the untrusted one. The contract
the seam enforces: *equal optimal cost.* If the axis-answer ("is this
correct?") differs across the seam, the optimization is broken — and the test
is the only place that difference becomes visible.

---

## How it works

### Move 1 — the mental model

You know how, when you refactor a function for speed, the safest check is to
keep the old slow version around and assert `fast(x) === slow(x)` for a pile
of inputs? That's the whole idea. A* is the fast refactor of Dijkstra; the
oracle test pins them together.

```
  The oracle pattern — two paths to one truth

         same input
       ┌─────────────┐
       │ graph, S, G │
       └──────┬──────┘
        ┌─────┴─────┐
        ▼           ▼
   ┌─────────┐  ┌─────────┐
   │ ORACLE  │  │ UNDER   │
   │ dijkstra│  │ TEST    │
   │ (trust) │  │ astar   │
   └────┬────┘  └────┬────┘
        │ cost_d     │ cost_a
        └─────┬──────┘
              ▼
        assert cost_a ≈ cost_d
              │
       agree → ship      disagree → bug in the optimization
```

The strategy in one sentence: **test the hard implementation against an
easier implementation of the same contract, not against hand-computed
expected values.** You don't have to know the right answer — you only have to
have a second way to compute it that you trust more.

### Move 2 — the walkthrough

**Step 1 — establish the oracle is itself correct.** Before Dijkstra can be
the ground truth, *it* gets pinned against hand-known answers on a tiny graph.
This is the base of the trust chain.

```
  Trust chain — pin the oracle on a known answer first

  hand-computed truth          dijkstra              astar
  ┌──────────────────┐        ┌─────────┐         ┌─────────┐
  │ S→A→G, len 200   │ =====► │ asserted│ =====►  │ asserted│
  │ (you did the     │  pin   │ correct │  oracle │ correct │
  │  arithmetic)     │        │         │         │         │
  └──────────────────┘        └─────────┘         └─────────┘
       diamond graph         diamondGraph()      makeGridGraph(12)
```

On the 6-node diamond, the cheapest S→G is `S,A,G` at length 200 — you can
verify that by eye. The test asserts exactly that. Now Dijkstra is trusted,
because it agreed with arithmetic you can check.

**Step 2 — run both on a graph too big to hand-check.** Switch to a 12×12
grid where you *can't* eyeball the answer. Run Dijkstra, run A*, compare their
costs.

```
  Pseudocode — the oracle assertion

  graph    = makeGridGraph(12)         // 144 nodes, no hand answer
  d_result = dijkstra(graph, "0,0", "11,11")   // the trusted cost
  a_result = astar(graph,  "0,0", "11,11")     // the cost under test

  assert a_result.path is not null
  assert a_result.cost   ≈ d_result.cost    // ← the gate (tolerance 6 dp)
  assert a_result.length ≈ d_result.length
```

The boundary condition that makes this work: **you compare cost, not path.**
Two different node sequences can tie on cost; asserting the exact path would
fail on a legal tie. Cost is the invariant; the specific route is not.

**Step 3 — assert the optimization actually optimized.** The whole point of
A* is to expand *fewer* nodes than Dijkstra while getting the same answer. So
a second assertion checks the speedup is real.

```
  Pseudocode — the performance half of the gate

  assert a_result.nodesExpanded ≤ d_result.nodesExpanded
  // A* with an admissible heuristic never expands MORE than Dijkstra;
  // usually far fewer. If A* expands more, the heuristic is doing nothing.
```

This is the part people forget. An oracle test that only checks correctness
lets a "speedup" that isn't faster slip through. flattr checks both: same
answer (`astar.test.ts:43-44`) *and* fewer expansions (`astar.test.ts:51`).

**Step 4 — extend the oracle to the harder engines.** The same pattern then
pins the directed and bidirectional engines. Bidirectional A* is the trickiest
code in the repo — meet-in-the-middle search has a notorious class of "stop
too early, miss the optimum" bugs — so it's checked against *both* Dijkstra
(distance cost) and directed A* (grade cost) as oracles.

```
  The oracle chain across all four engines

  dijkstra ──oracle──► astar ──oracle──► directedAstar
      │                                       │
      └────────────── oracle ────────► bidirectional ◄──── oracle ──┘
                  (distance cost)         (grade cost)
```

### Move 2 variant — the load-bearing skeleton

The irreducible kernel of an oracle test is three parts:

1. **A reference you trust more than the thing under test.** Drop it and you
   have no ground truth — you're back to hand-computing expected values, which
   doesn't scale past tiny inputs. Here it's `dijkstra`.
2. **A shared contract both compute.** Drop it and the comparison is
   meaningless. Here: "optimal cost from S to G."
3. **An invariant assertion, not an exact-output assertion.** Drop the
   "compare the invariant (cost), not the artifact (path)" discipline and the
   test fails on legal ties. Here: `toBeCloseTo(cost)`, never `toEqual(path)`
   on the grid.

Optional hardening layered on top: the `nodesExpanded` performance assertion,
the floating-point tolerance, the multi-engine chain. The skeleton is just
"trusted ref + shared contract + invariant compare."

### Move 3 — the principle

**When you optimize, keep the slow version as an oracle.** The fastest way to
trust a clever implementation is a dumb one that computes the same answer a
different way. This generalizes far past routing: a hand-rolled JSON parser
tested against `JSON.parse`, a SIMD sum tested against a scalar loop, a memo'd
recursion tested against the un-memo'd one. You don't need to know the right
answer — you need a second path to it you trust more.

---

## Primary diagram

The full picture: the trust chain from hand-known arithmetic up through the
four engines, with the oracle assertions as the seams.

```
  flattr's optimality oracle — full recap

  ┌─ TRUST SOURCE ─────────────────────────────────────────────┐
  │  hand-computed: diamond S→A→G = 200  (you did the math)     │
  └───────────────────────────┬────────────────────────────────┘
                              │ pin (astar.test.ts:6-12)
  ┌─ ORACLE ──────────────────▼────────────────────────────────┐
  │  dijkstra()  — uniform-cost flood, no heuristic to break    │
  └───────────────────────────┬────────────────────────────────┘
            ┌──────────────────┼──────────────────┐
            │ assert cost ≈     │ assert cost ≈    │ assert cost ≈
            ▼                   ▼                  ▼
  ┌─ astar ────────┐  ┌─ directedAstar ─┐  ┌─ bidirectional ──┐
  │ same cost +    │  │ same cost on    │  │ same cost; meet- │
  │ fewer expands  │  │ the grid        │  │ in-middle vs     │
  │ (12×12 grid)   │  │ (interior pair) │  │ flood (30×30)    │
  └────────────────┘  └─────────────────┘  └──────────────────┘
       :43-51              bidirectional.test.ts:16-24, 26-38

  the seams (assertions) are where untrusted meets trusted
```

---

## Implementation in codebase

**Use cases.** This pattern is reached for every time flattr adds a faster or
domain-aware search engine. Stage 1 (Dijkstra) is the trusted baseline;
stages 2–5 (A*, grade, directed, bidirectional) each get pinned to it. The
spec's hard constraint — "A* heuristic must stay admissible" — is *enforced*
by this test, not by a comment.

The oracle gate itself, `features/routing/astar.test.ts:37-53`:

```
  features/routing/astar.test.ts  (lines 37-53)

  describe("astar (stage 2, informed search)", () => {
    it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
      const g = makeGridGraph(12);              ← 144-node grid, no hand answer
      const d = dijkstra(g, "0,0", "11,11");    ← the trusted oracle cost
      const a = astar(g, "0,0", "11,11");       ← the cost under test
      expect(a.path).not.toBeNull();            ← it found *a* path at all
      expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6);     ← THE GATE
      expect(a.path!.lengthM).toBeCloseTo(d.path!.lengthM, 6);
    });                              │
                                     └─ toBeCloseTo, not toBe: haversine
                                        rounding would break exact equality.
                                        6 = decimal places of tolerance.

    it("expands no more nodes than Dijkstra, usually far fewer", () => {
      const g = makeGridGraph(12);
      const d = dijkstra(g, "0,0", "11,11");
      const a = astar(g, "0,0", "11,11");
      expect(a.nodesExpanded).toBeLessThanOrEqual(d.nodesExpanded);
    });                              │
  });                                └─ the performance half: an admissible A*
                                        NEVER expands more than Dijkstra. If it
                                        does, the heuristic is broken. Without
                                        this line, a no-op heuristic passes.
```

The oracle is fed by the shared parametric engine: `astar` and `dijkstra` are
both one-line wrappers over `search(...)` with different `(costFn,
heuristicFn)` arguments (`features/routing/astar.ts:136-145`). That's *why*
the comparison is fair — same engine, only the heuristic differs, so the test
isolates exactly the thing that can go wrong.

The bidirectional case is the subtle one (`bidirectional.test.ts:26-38`): its
comment explicitly notes that bidirectional A* legitimately expands *slightly
more* than unidirectional A* on a Euclidean grid (near-exact heuristic), so the
performance assertion is made against *Dijkstra* on an *interior* pair —
because corner-to-corner is degenerate (the goal is the farthest node, nothing
prunes). That comment is a senior engineer protecting the test from a false
failure. It's the difference between an oracle test that's robust and one
that's flaky.

---

## Elaborate

This is **differential testing** — comparing two implementations that should
agree. It comes from compiler and database testing, where the "reference" is a
spec-compliant but slow interpreter and the "candidate" is the optimized one
(CSmith for C compilers, SQLancer for databases work this way). The insight
flattr borrows: when you can't enumerate the right answer, generate inputs and
check two independent computations agree.

It pairs naturally with the property tests next door
(`02-property-and-invariant-tests.md`): the oracle says "agrees with the
reference," the property test says "obeys an invariant." Both replace
hand-written expected values, which is the only way to get real coverage on a
combinatorial input space like "all graphs."

Where to go deeper: the algorithms themselves live in
`.aipe/study-dsa-foundations/` (Dijkstra, A*, admissible heuristics). The
reason the engine is *testable* this way — the parametric `search()` —
is a `.aipe/study-software-design/` deep-module finding. The benchmark that
*measures* the speedup this test only bounds is in
`.aipe/study-performance-engineering/`.

---

## Interview defense

**Q: How do you test a shortest-path algorithm when you don't know the
shortest path?** You don't hand-compute it. You keep a slower, obviously-
correct implementation — Dijkstra, which has no heuristic to get wrong — and
assert the fast one (A*) returns the same optimal cost. On flattr's 12×12 grid
I can't eyeball the answer, but I can trust two independent searches that
agree. The load-bearing detail people miss: **compare cost, not the path** —
ties are legal, so asserting the exact route fails on a correct answer.

```
  graph → [dijkstra]──cost_d──┐
        → [astar]────cost_a──┴─► assert ≈   (cost, not path)
```

**Q: Your A* test passes. How do you know the heuristic is actually doing
anything?** The second assertion: A* must expand ≤ as many nodes as Dijkstra.
An admissible heuristic never expands more. If I delete the heuristic (return
0), A* *becomes* Dijkstra — same cost, same expansions — and the correctness
test still passes but this one tightens. Without the `nodesExpanded` check, a
no-op heuristic ships green. Anchor: correctness gate + performance gate are
two separate assertions for a reason.

**Q: Bidirectional search is notorious for stopping early and missing the
optimum. How do you defend against that?** Two oracles, not one
(`bidirectional.test.ts`): Dijkstra for distance cost, directed-A* for grade
cost, both `toBeCloseTo`. And I assert against an *interior* node pair, not
corner-to-corner — corner-to-corner is degenerate because the goal is the
farthest node, so nothing prunes and the comparison is meaningless.

---

## Validate

**Reconstruct.** From memory, write the three parts of an oracle test
(trusted reference, shared contract, invariant assertion) and explain what
breaks if each is removed.

**Explain.** Why does `astar.test.ts:43` use `toBeCloseTo(..., 6)` instead of
`toBe`? Why compare cost instead of the node path?

**Apply.** flattr adds a contraction-hierarchies engine (much faster A*). What
single test do you add first, and against which oracle? (Answer: `cost ≈
dijkstra.cost` on `makeGridGraph(n)`, plus `nodesExpanded` ≤ the previous
engine.)

**Defend.** A reviewer says "just hardcode the expected path for the grid
test, it's deterministic." Argue why the oracle is better. (Hint: ties; and
the hardcoded path silently breaks when fixture coordinates change, while the
oracle self-heals.)

References: `features/routing/astar.test.ts:5-53`,
`features/routing/bidirectional.test.ts:7-45`, `features/routing/astar.ts:22-78,136-160`.

---

## See also

- `02-property-and-invariant-tests.md` — the other "no hand-written expected
  value" technique, on the heap underneath this engine.
- `04-fixture-driven-graph-tests.md` — the `diamondGraph()` /
  `makeGridGraph()` factories these oracle tests run on.
- `05-finite-blocked-sentinel-tests.md` — the `null` vs BLOCKED distinction
  these tests assert on the disconnected case.
- `audit.md` §1, §2 — coverage and pyramid context.
- `.aipe/study-dsa-foundations/` — Dijkstra, A*, admissibility.
- `.aipe/study-performance-engineering/` — the bench harness that measures the
  speedup this test bounds.
