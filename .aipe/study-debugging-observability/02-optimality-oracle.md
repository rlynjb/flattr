# The optimality oracle

> **Industry names:** test oracle / differential testing / reference
> implementation oracle / metamorphic test. **Type:**
> Language-agnostic (the slow-reference-proves-fast pattern), applied
> to shortest-path search.

---

## Zoom out, then zoom in

When you debug a `fetch()` that returns wrong data, your first move is
to compare it against a request you *know* the answer to — Postman, a
curl you trust. You reproduce against a reference. The optimality oracle
is that move, formalized into the test suite: a second, slower, provably
correct search runs the same problem and the fast search must agree with
it.

Here's where the oracle sits.

```
  Zoom out — where the oracle lives

  ┌─ Engine layer ─────────────────────────────────────────────┐
  │  features/routing/astar.ts                                 │
  │    dijkstra()    ── uninformed, provably optimal (REFERENCE)│
  │    astar()       ── informed, fast (UNDER TEST)             │
  │    directedAstar / bidirectional  (UNDER TEST)             │
  └────────────────────────────┬────────────────────────────────┘
                               │ both produce SearchResult
  ┌─ Evidence layer (vitest) ──▼────────────────────────────────┐
  │  astar.test.ts / bidirectional.test.ts                      │
  │    run BOTH on the same fixture                            │
  │    assert fast.cost ≈ reference.cost   ★ THE ORACLE ★       │ ← here
  └────────────────────────────┬────────────────────────────────┘
                               │ pass / fail
  ┌─ Output ───────────────────▼────────────────────────────────┐
  │  vitest reporter → red/green in your terminal / CI          │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **test oracle** — when you can't write down
the correct answer by hand (a 30×30 grid's optimal path is not
something you eyeball), you generate it from a source you trust
absolutely. Dijkstra with no heuristic is provably optimal and dead
simple; A* with a heuristic is fast but has more ways to be subtly
wrong (an inadmissible heuristic, a bad tie-break). The oracle says:
*whatever Dijkstra costs, A* must cost the same, or A* is broken.* It
converts "the route looks plausible" into "the route is provably
optimal."

> This file's lens is **reproduction and evidence** — how the oracle
> lets you *explain* a wrong-route bug. The test suite as a
> *correctness gate* (coverage, isolation, flakiness) is
> `../study-testing/`'s lens. We share these test files; we read them
> differently.

---

## Structure pass

Two layers, one axis, one seam.

**Layers:** the **engine** (two implementations of "shortest path") and
the **evidence harness** (the assertion that ties them together).

**Axis — "how do we know the answer is right?"** Trace it across the
two implementations:

```
  One axis: "how do we know it's right?" — across the two engines

  ┌─ dijkstra (reference) ─┐   seam    ┌─ astar (under test) ──┐
  │  right BY CONSTRUCTION │ ════╪════► │  right ONLY IF it     │
  │  (uninformed = no      │  (it flips)│  matches the reference│
  │   heuristic to break)  │           │                       │
  └────────────────────────┘           └───────────────────────┘
         ▲                                       ▲
         └──── same axis, two answers ───────────┘
               left side is self-evidently correct;
               right side BORROWS its correctness from the left
```

**The seam:** the assertion `expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6)`.
On the left of that line, correctness is intrinsic — Dijkstra has no
heuristic, so the only way it's wrong is if the whole graph traversal is
wrong (which the fixtures with hand-known answers catch separately). On
the right, A*'s correctness is *derived* — it's only trusted because it
matched. The axis flips at the assertion: self-evident → derived. That
flip is exactly why the oracle is load-bearing — strip it and A*'s
correctness has no source.

---

## How it works

### Move 1 — the mental model

The shape is **differential testing against a trusted reference.** You
already do this informally: when a refactor's output looks off, you
`git stash` and re-run the old code to see what it *should* produce. The
oracle bakes that comparison into a permanent test — the "old code" is a
simpler algorithm you trust by construction.

```
  Pattern — the oracle comparison

      same problem (fixture graph, same start/goal)
                │
        ┌───────┴────────┐
        ▼                ▼
  ┌───────────┐    ┌───────────┐
  │ REFERENCE │    │UNDER TEST │
  │ dijkstra  │    │  astar    │
  │ (trusted) │    │  (fast)   │
  └─────┬─────┘    └─────┬─────┘
        │ cost_ref       │ cost_test
        └───────┬────────┘
                ▼
        assert cost_test ≈ cost_ref
                │
        ┌───────┴────────┐
       PASS            FAIL
   (A* is optimal)  (A* cut a corner — you have a repro)
```

The payoff: a failure isn't "the route looks wrong," it's "A* costs
1040 where Dijkstra costs 1000 on `makeGridGraph(12)`, S=0,0 G=11,11" —
a fully specified, deterministic reproduction you can drop into a
debugger.

### Move 2 — the step-by-step walkthrough

#### Pick a reference that's correct by construction

The reference has to be *trustably* correct, or the oracle just tests
one bug against another. Dijkstra qualifies because it uses no
heuristic — `zeroHeuristic` — so there's no admissibility to get wrong.

```
  Why Dijkstra is a valid oracle for A*

  A* = Dijkstra + heuristic
       └────────┬─────────┘
                │
   the heuristic is the ONLY thing A* adds that can be subtly wrong:
     • inadmissible (overestimates) → A* finds a NON-optimal path
     • tie-break bug                → A* expands wrong but same cost
   set heuristic = 0 and A* collapses INTO Dijkstra → no way to be
   subtly wrong → trustworthy reference
```

The boundary condition: the reference must solve the *exact same
problem* (same cost function). `bidirectional.test.ts:16-24` is careful
here — it compares bidirectional-with-`gradeCostDirected` against
`directedAstar` (same cost), not against plain Dijkstra (different
cost). Mixing cost functions is the classic way to write an oracle that
fails for the wrong reason.

#### Run both on a deterministic fixture

The problem must be reproducible bit-for-bit, or a failure isn't a
repro. Fixtures are hand-built graphs (`fixtures.ts`) with no
randomness.

```
  Layers-and-hops — fixture to verdict

  ┌─ fixture ────┐ hop 1: makeGridGraph(12)   ┌─ engine ─────┐
  │ fixtures.ts  │ ─────────────────────────► │ dijkstra(g)  │
  │ (no random)  │ hop 1': same g             │ astar(g)     │
  └──────────────┘ ─────────────────────────► └──────┬───────┘
                                        hop 2 │ two SearchResults
                                              ▼
                                   ┌─ assertion ─────────┐
                                   │ toBeCloseTo(cost, 6)│
                                   └─────────┬───────────┘
                                  hop 3 │ pass/fail
                                        ▼
                                   vitest verdict
```

#### Assert on cost, not on the path

This is the subtle, load-bearing part. Two *different* node sequences
can both be optimal (ties). So the oracle asserts **equal cost**, not
equal path — `toBeCloseTo(d.path!.cost, 6)`. Asserting equal *path*
would produce false failures every time the tie-break ordering shifts.

```
  Why cost, not path — ties are real

  goal reachable two ways, SAME cost:
     S → A → G   cost 200  ✓ optimal
     S → B → G   cost 200  ✓ optimal  (also correct!)

  assert path equal  → flaky: breaks when tie-break flips
  assert cost equal  → stable: both routes are optimal, both pass
```

The exception: where the *path itself* is the contract (e.g. "detour
uphill but go direct downhill"), the test asserts the exact node
sequence — `astar.test.ts:76-79`. The rule is: assert cost for
optimality, assert path for *directional behavior*. Knowing which to
assert is the skill.

#### Extend the oracle to the metric, not just the answer

The oracle also guards the *efficiency* claim, not only correctness:
`astar.test.ts:51` asserts A* expands `≤` Dijkstra, and
`bidirectional.test.ts:37` asserts bidirectional expands strictly fewer
than Dijkstra. Same shape — compare a metric against a reference — but
now the reference proves the *speedup* is real, not just the answer.

### Move 2 variant — the load-bearing skeleton

Strip the oracle to its kernel:

1. **Two solvers for the same problem** — one trusted-by-construction
   (Dijkstra), one under test (A*). *Remove the trusted one and you have
   nothing to check against — you're back to "looks right."*
2. **A shared deterministic input** — same fixture, same start/goal.
   *Remove determinism and a failure isn't reproducible, so it's not
   evidence.*
3. **A comparison on the invariant that must hold** — equal *cost* (the
   thing optimality guarantees), tolerant of ties. *Compare the wrong
   invariant (exact path) and the oracle false-fails on every tie-break
   shuffle.*

Optional hardening on top: the `≤ nodesExpanded` efficiency assertions,
the parallel-edge regression test, the `start===goal` and
disconnected-graph edge cases. Those harden specific past bugs; the
three-part kernel is what makes it an oracle.

### Move 3 — the principle

When you can't write the correct answer down by hand, generate it from a
source you trust more than the code under test — and compare on the
*invariant the algorithm guarantees* (here: optimal cost), not on an
incidental detail (the exact path) that ties make non-unique. The oracle
turns "plausible" into "provably correct," and a failure into a fully
specified reproduction.

---

## Primary diagram

The whole oracle loop, reference to verdict.

```
  The optimality oracle — complete reproduction loop

  ┌─ Fixture layer: features/routing/fixtures.ts ──────────────────┐
  │  makeGridGraph(12)  — deterministic, hand-known structure      │
  └────────────────────────────┬───────────────────────────────────┘
                  same g, same start "0,0", goal "11,11"
                ┌──────────────┴───────────────┐
                ▼                               ▼
  ┌─ REFERENCE ─────────────┐     ┌─ UNDER TEST ──────────────┐
  │ dijkstra(g,"0,0","11,11")│     │ astar(g,"0,0","11,11")    │
  │ zeroHeuristic →          │     │ haversineHeuristic →      │
  │ optimal BY CONSTRUCTION  │     │ fast, must be PROVEN       │
  │ → cost d, expanded D     │     │ → cost a, expanded A       │
  └────────────┬─────────────┘     └────────────┬───────────────┘
               │                                 │
               └──────────────┬──────────────────┘
                              ▼
  ┌─ Oracle assertions: astar.test.ts:38-52 ──────────────────────┐
  │  expect(a.cost).toBeCloseTo(d.cost, 6)      ← CORRECTNESS      │
  │  expect(a.lengthM).toBeCloseTo(d.lengthM,6) ← same real route  │
  │  expect(a.nodesExpanded ≤ d.nodesExpanded)  ← SPEEDUP is real  │
  └────────────────────────────┬───────────────────────────────────┘
                               ▼
                vitest verdict — red gives a deterministic repro
```

---

## Implementation in codebase

### Use cases

The oracle is reached for whenever the search engine changes — a new
cost function, a heuristic tweak, a refactor of the `search` loop, a
change to `pqueue`. It's the test you trust to catch "the route is
subtly suboptimal now." Concretely:

- **After adding/changing a cost model** (`cost.ts`): does grade-A*
  still return the *optimal* graded route, or did the penalty curve make
  it cut a corner? The oracle's grade variant
  (`bidirectional.test.ts:40-45`) checks bidirectional-graded against
  `directedAstar`.
- **After touching the heuristic** (`astar.ts:9`): if `haversineHeuristic`
  ever became inadmissible (overestimated), A* would silently return
  non-optimal paths — the oracle (`astar.test.ts:38-45`) is the only
  thing that catches it, because the route would still *look* fine.
- **After a `pqueue` change** (lazy deletion, sift logic): a heap bug
  shows up as a wrong cost in the oracle and as a structural failure in
  `pqueue.test.ts` via `checkInvariant()`.

### Code, line by line

**The correctness oracle** — `features/routing/astar.test.ts:37-53`:

```
  features/routing/astar.test.ts  (astar correctness, lines 37-53)

  describe("astar (stage 2, informed search)", () => {
    it("returns the SAME optimal path as Dijkstra ...", () => {
      const g = makeGridGraph(12);             ← 39  deterministic input
      const d = dijkstra(g, "0,0", "11,11");   ← 40  REFERENCE (trusted)
      const a = astar(g, "0,0", "11,11");      ← 41  UNDER TEST
      expect(a.path).not.toBeNull();           ← 42  it found something
      expect(a.path!.cost)
        .toBeCloseTo(d.path!.cost, 6);         ← 43  ★ THE ORACLE ★
      expect(a.path!.lengthM)
        .toBeCloseTo(d.path!.lengthM, 6);      ← 44  same real distance
    });

    it("expands no more nodes than Dijkstra ...", () => {
      const d = dijkstra(g, "0,0", "11,11");   ← 49
      const a = astar(g, "0,0", "11,11");      ← 50
      expect(a.nodesExpanded)
        .toBeLessThanOrEqual(d.nodesExpanded); ← 51  speedup is REAL
    });
  });
       │
       └─ line 43 is the load-bearing assertion: cost, not path, with
          6-digit tolerance so float drift on the haversine heuristic
          doesn't false-fail. line 51 reuses the counters from file 01
          as a SECOND oracle — proving A* is not just correct but cheaper.
```

If line 43 asserted `a.path!.nodes` equal instead of cost, the test
would flake every time the grid produced an equal-cost alternate route
and the heap tie-break shuffled. Cost is the invariant optimality
actually promises.

**The directional oracle — assert the path when path IS the contract** —
`astar.test.ts:73-80`:

```
  features/routing/astar.test.ts  (directedAstar, lines 73-80)

  it("detours uphill but takes the direct edge downhill ...", () => {
    const g = directionalGraph();
    const up = directedAstar(g, "X", "Y", 5);  ← 76  uphill direction
    expect(up.path!.nodes).toEqual(["X","F","Y"]);← 77 EXACT path asserted
    const down = directedAstar(g, "Y", "X", 5);← 78  reverse direction
    expect(down.path!.nodes).toEqual(["Y","X"]);← 79 direct downhill
  });
       │
       └─ here the PATH is the behavior under test (asymmetric routing),
          not just optimality — so the assertion flips to exact node
          sequence. knowing WHICH to assert (cost vs path) is the skill:
          cost for optimality, path for directional behavior.
```

**The bidirectional oracle, with matched cost function** —
`bidirectional.test.ts:16-38`:

```
  features/routing/bidirectional.test.ts  (lines 16-38)

  it("matches directional A*'s optimal cost on the grid ...", () => {
    const g = makeGridGraph(30);
    const ref = directedAstar(g, "12,12", "17,17", 10);  ← 21 REFERENCE
    const b = bidirectional(g, "12,12", "17,17", 10,
                            gradeCostDirected);          ← 22 SAME cost fn
    expect(b.path!.cost).toBeCloseTo(ref.path!.cost, 4); ← 23 oracle
  });

  it("expands far fewer nodes than uninformed Dijkstra ...", () => {
    const dj = dijkstra(g, "12,12", "17,17");            ← 34
    const b  = bidirectional(g,"12,12","17,17",∞,distanceCost);← 35
    expect(b.path!.cost).toBeCloseTo(dj.path!.cost, 6);  ← 36 same answer…
    expect(b.nodesExpanded).toBeLessThan(dj.nodesExpanded);← 37 …fewer nodes
  });
       │
       └─ line 22 matches the cost function to the reference (line 21):
          comparing bidirectional-graded against directed-graded, NOT
          against plain Dijkstra. mismatching cost fns is the classic
          way to write an oracle that fails for the wrong reason. note
          the INTERIOR pair (12,12→17,17) — corner-to-corner is
          degenerate (comment at :30-32) and would make the oracle prove
          nothing.
```

### The other half — the state-invariant oracle

A second, structural oracle backs the search one:
`features/routing/pqueue.ts:42-48` exposes `checkInvariant()` — it walks
the heap array and asserts `priority[parent] ≤ priority[child]`
everywhere. `pqueue.test.ts` calls it after operations so a heap bug is
caught as a *structural violation* at the data-structure boundary,
before it can surface as a mysterious wrong cost two layers up. That's
the same oracle idea (check an invariant that must hold) applied to
state rather than output.

---

## Elaborate

This is **differential testing** — the technique behind everything from
compiler fuzzers (run the same program through two compilers, diff the
output) to database query checkers. The specific flavor here is a
*reference oracle*: one side is a gold implementation you trust
absolutely. It's cheaper than a property-based oracle (you don't have to
state the property abstractly — Dijkstra *is* the property, executable)
and stronger than example-based tests (you don't have to hand-compute
the answer for a 30×30 grid).

The connection to A* theory: the oracle is only valid because Dijkstra
and A* provably return the same optimal cost *when the heuristic is
admissible*. So the oracle is implicitly also an **admissibility test** —
if someone makes `haversineHeuristic` overestimate, A* starts returning
cheaper-looking-but-suboptimal paths and the oracle goes red. That ties
straight to the project's must-not-change constraint ("A* heuristic must
stay admissible," per the spec). The oracle is how that constraint is
*enforced*, not just stated.

What to read next: `01-search-instrumentation-counters.md` (the
`nodesExpanded` the efficiency oracle compares), and `../study-testing/`
for the suite as a coverage/correctness gate rather than a repro loop.

---

## Interview defense

**Q: Why assert equal *cost* instead of equal *path*? Isn't the path
the thing you actually care about?**

Because optimality guarantees a minimal *cost*, not a unique *path*.
Ties are real — two routes can both be optimal — so asserting the exact
path makes the test flake whenever the heap tie-break reorders. I assert
cost for optimality and only assert the exact path where the *path
shape* is the contract (the directional uphill/downhill test).

```
  cost is the invariant; path is not unique

  optimal cost = 200  ← unique, assert this
  optimal path = {S→A→G, S→B→G}  ← non-unique under ties, DON'T assert
```

Anchor: *assert the invariant the algorithm guarantees (cost), not the
incidental detail (path) ties make non-unique.*

**Q: Dijkstra is also code you wrote — how is it a trustworthy
reference?**

Because it's correct by *construction*, not by testing: A* = Dijkstra +
a heuristic, and the heuristic is the only added piece that can be
subtly wrong (inadmissibility, tie-breaks). Set the heuristic to zero
and A* collapses into Dijkstra — no heuristic, nothing to get subtly
wrong. Dijkstra's own correctness is pinned separately by fixtures with
hand-known answers (`diamondGraph`, exact node sequence).

```
  A* = Dijkstra + heuristic
              └── the ONLY new failure surface
  zero out the heuristic → reference has no new failure surface
```

Anchor: *the reference is the algorithm-under-test minus its only
fragile part.*

**Q: What does a failure of this oracle actually give you?**

A fully specified, deterministic reproduction: "on `makeGridGraph(12)`,
S=0,0 → G=11,11, A* cost 1040 vs Dijkstra 1000." No randomness, no
environment, droppable straight into a debugger. That's the difference
between "the route looked wrong" and a repro I can bisect.

Anchor: *the oracle converts a vibe ("looks wrong") into a repro
("1040 ≠ 1000 on this exact fixture").*

---

## Validate

**Reconstruct.** Draw the oracle's three-part kernel (two solvers, shared
deterministic input, comparison on the guaranteed invariant). Name what
breaks if you remove each part.

**Explain.** Why does `bidirectional.test.ts:22` pass `gradeCostDirected`
to `bidirectional` and compare against `directedAstar` (`:21`) — instead
of comparing against `dijkstra`? What would go wrong with the wrong
reference?

**Apply to a scenario.** Someone "optimizes" `haversineHeuristic`
(`astar.ts:9`) to return `1.2 * haversine(...)` (now overestimating).
The app's routes still look reasonable. Which exact test
(`file:line`) goes red, and what does its failure message tell you the
heuristic violated?

**Defend the decision.** Argue why asserting equal *cost* with
`toBeCloseTo(..., 6)` (`astar.test.ts:43`) is better than asserting equal
node arrays — and name the one test in the same file where asserting the
exact path is correct, and why.

---

## See also

- `01-search-instrumentation-counters.md` — the `nodesExpanded` counter
  the efficiency oracle (`astar.test.ts:51`) compares.
- `03-route-honesty-signal.md` — `BLOCKED`-finite is itself oracle-tested
  ("null only when disconnected, not when steep").
- `00-overview.md` — the evidence map; this is the #2 ranked surface.
- `audit.md` — lens 2 (reproduction & evidence) and lens 7 (regression
  guards with embedded root-cause comments).
- `../study-testing/` — the same tests read as a correctness/coverage
  gate.
- `../study-dsa-foundations/` — why admissible A* equals Dijkstra's
  optimal cost.
