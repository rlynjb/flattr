# The optimality oracle

**Industry names:** differential testing · oracle problem · reference
implementation · metamorphic check. **Type:** Industry standard (the pattern);
Project-specific (this instance).

## Zoom out, then zoom in

When you have a fast algorithm whose answer you can't easily eyeball, you check
it against a slow algorithm whose answer you *trust*. That's the whole idea
here: A* is the fast one, Dijkstra is the trusted reference, and the test
asserts they agree.

```
  Zoom out — where the oracle lives

  ┌─ Test layer (Vitest) ───────────────────────────────────────┐
  │  astar.test.ts                                               │
  │    d = dijkstra(g, …)   a = astar(g, …)                      │
  │    expect(a.cost).toBeCloseTo(d.cost)   ★ THE ORACLE ★       │ ← we are here
  └─────────────────────────────┬───────────────────────────────┘
                                │  both call the same engine
  ┌─ Routing engine layer ──────▼───────────────────────────────┐
  │  search(graph, …, costFn, heuristicFn)                       │
  │    dijkstra = (distanceCost, zeroHeuristic)                  │
  │    astar    = (distanceCost, haversineHeuristic)             │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **differential check against a known-good oracle.**
A* is subtle — its correctness depends on the heuristic being admissible, and a
bug there produces a *plausible but wrong* path that no human would catch by
looking. Dijkstra is dumb and slow but provably correct. So Dijkstra becomes the
oracle: if A* ever disagrees with it on cost, A* has a bug. This is the single
highest-value correctness signal in the repo.

## Structure pass

**Layers.** Two: the test that asserts agreement, and the one engine both
algorithms share (they differ only by the `(costFn, heuristicFn)` pair).

**Axis — trace "what is trusted to be correct?" across the two algorithms:**

```
  One axis: what's trusted? — across the two stages

  dijkstra  →  TRUSTED by construction (no heuristic to get wrong)
  astar     →  TRUSTED only if heuristic is admissible (can break)

  the oracle test makes the trusted one VERIFY the breakable one
```

**Seam.** The seam is the shared `search()` signature (`astar.ts:22-29`).
Because both algorithms are the *same function* with different parameters, the
only thing that can differ between them is the heuristic — which is exactly the
thing that can be wrong. That's what makes the differential test sharp: it
isolates the one variable. If A* disagrees with Dijkstra, the bug is provably in
the heuristic or its admissibility, because everything else is literally the same
code path. The seam is what turns "they disagree" into "the heuristic is wrong."

## How it works

### Move 1 — the mental model

You've used this without naming it: writing a slow brute-force solution to a
LeetCode problem, then checking your optimized solution against it on random
inputs. The brute force is the oracle. Here Dijkstra is the brute force.

```
  Pattern — differential check against an oracle

      same input graph g, same start, same goal
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
   ┌────────┐          ┌────────┐
   │dijkstra│          │ astar  │
   │(oracle)│          │(under  │
   │ slow,  │          │ test)  │
   │ trusted│          │ fast,  │
   └───┬────┘          │ subtle │
       │               └───┬────┘
       │  d.cost           │  a.cost
       └────────┬──────────┘
                ▼
      expect a.cost ≈ d.cost     ← disagree ⇒ A* has a bug
```

The strategy in one sentence: **run two implementations on the same input and
assert their answers match — the simple one is the spec for the subtle one.**

### Move 2 — the walkthrough

**The oracle assertion itself.** It's four lines, and every one is load-bearing.

```ts
// features/routing/astar.test.ts:38-45
it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
  const g = makeGridGraph(12);
  const d = dijkstra(g, "0,0", "11,11");      // oracle: trusted answer
  const a = astar(g, "0,0", "11,11");         // under test: same input
  expect(a.path).not.toBeNull();
  expect(a.path!.cost).toBeCloseTo(d.cost, 6);     // ← agreement on cost
  expect(a.path!.lengthM).toBeCloseTo(d.lengthM, 6);
});
```

Read why each line matters. `makeGridGraph(12)` is deterministic — same graph
every run, so a failure is reproducible, not flaky. `dijkstra` and `astar` get
*identical* arguments, isolating the heuristic as the only difference.
`toBeCloseTo(…, 6)` compares cost to 6 decimals — not `toBe`, because float
accumulation over edges means exact equality would be falsely fragile; close-to-6
is "agree to within rounding." Asserting `cost` rather than the node *sequence*
is deliberate: on a grid there are many equal-cost shortest paths, so two correct
algorithms can pick different node lists — only the *cost* must agree.

**Why cost, not path.** This is the subtle part and the place people get the
oracle wrong.

```
  Two valid shortest paths, same cost — both correct

      0,0 ───────► ... ───────► 11,11
        │                         ▲
        │  A* goes right-then-up  │
        └───────► ... ───────────►┘
           Dijkstra goes up-then-right

      different node sequences, IDENTICAL cost
      → assert cost; asserting the sequence would false-fail
```

If you asserted `a.path.nodes` equaled `d.path.nodes`, the test would fail on
correct code the moment tie-breaking differed. The oracle's invariant is *cost
equality* — the thing both algorithms actually promise — not path identity.

**The paired efficiency check.** Right below the oracle sits its complement:

```ts
// features/routing/astar.test.ts:47-52
it("expands no more nodes than Dijkstra, usually far fewer", () => {
  const g = makeGridGraph(12);
  const d = dijkstra(g, "0,0", "11,11");
  const a = astar(g, "0,0", "11,11");
  expect(a.nodesExpanded).toBeLessThanOrEqual(d.nodesExpanded);
});
```

Together these two tests pin both axes: the oracle pins *correctness* (same
cost), this one pins *efficiency* (A* expands ≤ Dijkstra, using the counters from
`01-`). A* that returned the right cost but expanded *more* nodes would pass the
oracle and fail here — that's a broken heuristic too (one that's admissible but
useless). You need both assertions to fully characterize "A* is correct *and*
better."

**The oracle generalizes across the stage progression.** The same differential
shape catches the grade stages too — `gradeAstar` is checked against the plain
`astar` to prove it *prefers* the flat route (`astar.test.ts:56-63`), and
`directedAstar` against itself reversed to prove asymmetry (`:65-70, :74-80`).
Each is the same move: run a trusted reference and a variant on one input, assert
the relationship that must hold.

```
  Layers-and-hops — the oracle as a CI gate

  ┌─ Dev pushes ─┐ hop 1: npm test     ┌─ Vitest runner ──────┐
  │  change to   │ ──────────────────► │  astar.test.ts       │
  │  astar.ts /  │                     │   d=dijkstra a=astar  │
  │  cost.ts     │ ◄────────────────── │   assert a≈d          │
  └──────────────┘  hop 2: pass/FAIL   └──────────────────────┘
                    a regression in the heuristic fails HERE,
                    before it reaches a user as a wrong route
```

### Move 2 variant — the load-bearing skeleton

The kernel: **a trusted reference + the algorithm under test + the same input +
an assertion on the invariant they must share.** Four parts.

- Drop the **trusted reference** (test A* alone against a hand-written expected
  path) and you're back to the oracle problem — you can't write down the right
  answer for an arbitrary graph, which is *why* you needed the oracle.
- Drop the **same input** (different graphs to each) and the comparison is
  meaningless — they must see identical conditions.
- Pick the **wrong invariant** (assert path equality instead of cost equality)
  and the oracle false-fails on correct code, gets disabled, and protects
  nothing. Choosing *cost* is the insight.
- Drop the **paired efficiency assertion** and an admissible-but-trivial
  heuristic (e.g. always returns 0 — that's just Dijkstra) passes silently. The
  oracle alone proves correct; you need the counter check to prove *better*.

Optional hardening: running it over many random graphs (property-based) would
strengthen it — today it's one fixed grid. That's the upgrade path, not the
skeleton.

### Move 3 — the principle

**When you can't write down the right answer, borrow it from a simpler program.**
The oracle pattern dissolves the hardest problem in testing — "what *is* the
correct output?" — by delegating it to an implementation you already trust.
Dijkstra can't be wrong about shortest-path cost (no heuristic to break), so it
gets to be the answer key for A*, which can. This is exactly the brute-force-as-
oracle move you'd reach for on a hard algorithm problem: write the obviously-
correct slow version, then test the clever fast version against it.

## Primary diagram

The oracle in full: shared engine, two parameterizations, differential
assertion on the right invariant, run as a CI gate.

```
  Optimality oracle — the full picture

  ┌─ Test (astar.test.ts:38) ──────────────────────────────────┐
  │   g = makeGridGraph(12)        ← deterministic, repeatable  │
  │   d = dijkstra(g,…)  ──┐                                    │
  │   a = astar(g,…)     ──┤  same graph, same endpoints        │
  │                        ▼                                    │
  │   expect a.cost  ≈ d.cost   (toBeCloseTo, 6)  ← CORRECTNESS │
  │   expect a.expand ≤ d.expand                  ← EFFICIENCY  │
  └────────────────────────┬───────────────────────────────────┘
                           │ both call ↓ (only heuristic differs)
  ┌─ Engine (astar.ts:22) ─▼───────────────────────────────────┐
  │   search(g, s, goal, ∞, distanceCost, heuristicFn)          │
  │     dijkstra → zeroHeuristic   astar → haversineHeuristic   │
  └────────────────────────────────────────────────────────────┘

  measured: cost 800.00 = 800.00 (agree) · expanded 32 ≤ 203 (better)
```

## Elaborate

The "oracle problem" is a named hard problem in software testing: for many
programs you simply cannot state the expected output for an arbitrary input.
Differential testing answers it by comparing two independent implementations of
the same spec — if they disagree, at least one is wrong. flattr's instance is
especially clean because both "implementations" are the *same function* with
different parameters, so the only possible source of disagreement is the
heuristic. That ties directly to the must-not-change constraint in the project
context: *"A\* heuristic must stay admissible — haversine lower bound."* This
test is the executable enforcement of that constraint. Scale the heuristic up for
speed (weighted A*) and this test goes red — which is the spec's point at §14.3:
"you trade optimality; decide knowingly." The oracle makes "knowingly" mechanical.

Partition note: *whether this is covered as a test* is `study-testing`'s lens.
*What it reveals as evidence about A*'s correctness* is this guide's. Same four
lines, two lenses.

## Interview defense

**Q: How do you know your A* is correct, not just plausible-looking?**

I don't trust the A* output directly — I check it against Dijkstra. Dijkstra has
no heuristic, so it can't be wrong about shortest-path cost; it's my oracle. The
test asserts A*'s cost equals Dijkstra's on the same graph (`astar.test.ts:38`).
A broken heuristic produces a path that *looks* fine but costs more — only the
differential check catches that.

```
  trusted (no heuristic)   under test (subtle heuristic)
       dijkstra      ══════════►   astar
        d.cost      assert ≈       a.cost
                  disagree ⇒ heuristic bug
```

Anchor: *Dijkstra is the answer key; A* is the student. I grade one against the
other so I never have to write down the right answer by hand.*

**Q: Why assert cost instead of the actual path?**

Because a grid has many equal-cost shortest paths — two correct algorithms can
return different node sequences with identical cost. Asserting the sequence would
false-fail on correct code, the test would get disabled, and I'd lose the guard.
The invariant both algorithms actually promise is *cost*, so that's what I pin.

Anchor: *assert the invariant the spec guarantees (cost), not an incidental tie-
break (the specific path).*

## See also

- `01-search-instrumentation-counters.md` — the `cost` and `expanded` columns
  this oracle reads.
- `04-finite-blocked-as-diagnostic.md` — the other correctness invariant: null
  only when disconnected.
- `audit.md` lens 2 (reproduction) and lens 4 (the oracle as an implicit SLO).
- Neighbor guide `study-testing` — coverage/design framing of the same assertions.
