# 01 — The Optimality Oracle

**Industry names:** differential testing · oracle test · cross-implementation
verification · "test against a known-correct reference." **Type:** Industry
standard (the specific A*-vs-Dijkstra form is project-shaped here).

---

## Zoom out — where this lives

This is the single most load-bearing test in the repo. It sits at the runtime
engine layer, guarding the optimizer that the whole product depends on.

```
  Zoom out — the oracle guards the optimizer

  ┌─ BUILD layer ───────────────────────────────────────────────┐
  │  pipeline → graph.json                                       │
  └───────────────────────────────┬─────────────────────────────┘
                                  │
  ┌─ RUNTIME engine layer ────────▼─────────────────────────────┐
  │  dijkstra (uninformed, slow, PROVABLY optimal)              │
  │      ║  same cost?  ◄══ ★ THE ORACLE ★                       │ ← we are here
  │  astar / directedAstar / bidirectional (fast, MUST match)  │
  └───────────────────────────────┬─────────────────────────────┘
                                  │
  ┌─ MOBILE layer ────────────────▼─────────────────────────────┐
  │  MapScreen renders the route the engine returned            │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: A* is fast because it's *greedy with a heuristic* — it skips nodes it
guesses can't be on the best path. But a heuristic that guesses wrong returns a
path that's plausible and *wrong*, and on a 144-node grid no human can tell.
The oracle is how you check the guesser: run the slow algorithm that can't be
wrong, and demand the fast one return the **same cost**.

---

## Structure pass

**Layers:** two algorithms at the same level — a reference (Dijkstra) and a
candidate (A* family). The oracle is the *vertical seam* between them.

**Axis — "can this algorithm be wrong?"** Trace it across the seam:

```
  axis = "is this provably optimal, or does it depend on a heuristic?"

  ┌─ Dijkstra ──────┐   seam    ┌─ A* / directed / bidi ──┐
  │ PROVABLY optimal│ ════╪════► │ optimal ONLY IF the     │
  │ (no heuristic)  │  (flips)   │ heuristic is admissible │
  └─────────────────┘            └─────────────────────────┘
         ▲                                    ▲
         └──── the oracle pins the seam: ─────┘
               candidate.cost === reference.cost
```

The axis flips hard across this seam: Dijkstra cannot be wrong, A* can. That's
exactly why the boundary is worth a test — the contract "A* equals Dijkstra"
*is* the admissibility proof, checked by execution instead of by hand.

**Seam:** `expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6)`.

---

## How it works

### Move 1 — the mental model

You know how you'd check a fast hand-written `sort()` against the language's
built-in `[...arr].sort()`? You don't re-derive the sorted order yourself — you
trust the reference and demand your version agrees. The optimality oracle is the
same move: Dijkstra is the built-in you trust; A* is your fast version that has
to match.

```
  the oracle — two paths into the same graph, one assertion

         ┌─────────────┐
   graph │  REFERENCE  │── cost_ref ──┐
   ──────┤  dijkstra   │              │
     │   └─────────────┘              ▼
     │                          ┌───────────┐   pass if
     │   ┌─────────────┐        │  EQUAL?   │   cost_ref
     └───┤  CANDIDATE  │── cost_cand ──►     │   == cost_cand
         │  astar      │        └───────────┘
         └─────────────┘
```

The beauty: the test author never computes the optimal cost. They only assert
two methods agree — and two correct methods *must*.

### Move 2 — the walkthrough

**The reference must be the trustworthy one.** Dijkstra is the oracle because it
has no heuristic to get wrong — it floods outward by true accumulated cost. The
test in `features/routing/astar.test.ts:38`:

```ts
// astar.test.ts:37-45
describe("astar (stage 2, informed search)", () => {
  it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
    const g = makeGridGraph(12);              // 12×12 = 144 nodes — too big to
                                              //   eyeball the optimum
    const d = dijkstra(g, "0,0", "11,11");    // reference: provably optimal
    const a = astar(g, "0,0", "11,11");       // candidate: heuristic-driven
    expect(a.path).not.toBeNull();
    expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6);     // ← THE GATE
    expect(a.path!.lengthM).toBeCloseTo(d.path!.lengthM, 6);
  });
```

Line by line: `makeGridGraph(12)` is chosen *because* it's big — a fixture small
enough to hand-verify wouldn't stress the heuristic. `toBeCloseTo(..., 6)`
allows floating-point slop (6 decimals) but nothing more — costs that differ by
a real amount fail. Note it checks **cost**, not the node sequence: there can be
two distinct paths of equal cost, and the oracle correctly accepts either, as
long as the *cost* matches. Pinning the node list would make the test brittle to
tie-breaking; pinning the cost is the actual correctness property.

**The oracle scales up the cost ladder.** Each new algorithm is verified against
the previously-trusted one — a chain of oracles:

```
  the oracle chain — each link verified against the last

  dijkstra ──proven by──► hand-computed diamond (S→A→G = 200)
     │                         astar.test.ts:8-12
     ▼  oracle
  astar ───────────────► matches dijkstra cost (grid12)
     │                         astar.test.ts:43
     ▼  oracle
  directedAstar ───────► matches on directional fixtures
     │                         bidirectional.test.ts:21
     ▼  oracle
  bidirectional ───────► matches dijkstra AND directedAstar cost
                               bidirectional.test.ts:11, :22
```

`features/routing/bidirectional.test.ts:11` and `:22` close the chain — the
most complex algorithm (meet-in-the-middle bidirectional A*) is pinned against
*two* references:

```ts
// bidirectional.test.ts:16-24 — directed cost, interior pair
const g = makeGridGraph(30);
const ref = directedAstar(g, "12,12", "17,17", 10);          // trusted candidate
const b = bidirectional(g, "12,12", "17,17", 10, gradeCostDirected);
expect(b.path!.cost).toBeCloseTo(ref.path!.cost, 4);          // ← oracle
```

**The oracle also guards the *performance* claim, separately from correctness.**
A* must be correct (same cost) *and* faster (fewer expansions). The repo splits
these into two assertions so a regression tells you which property broke:

```ts
// astar.test.ts:47-52 — the performance half, NOT the correctness half
expect(a.nodesExpanded).toBeLessThanOrEqual(d.nodesExpanded);
```

This is the bidirectional.test.ts:26 comment's whole point: the authors knew a
near-exact Euclidean heuristic can make bidirectional expand *slightly more*
than one-directional A*, so they compare against uninformed *Dijkstra* on an
*interior* pair (`:35`), where meet-in-the-middle's win is provable
(`~43 << ~203`). The oracle's correctness half and its performance half are
deliberately different comparisons.

### Move 2 variant — the load-bearing skeleton

Strip the oracle to its kernel:

```
  reference impl (trusted)  +  candidate impl (under test)
  +  shared input (a fixture both run on)
  +  equality assertion on the OUTPUT PROPERTY THAT MUST AGREE
```

Name each part by what breaks without it:

- **Drop the trusted reference** → you're back to hand-computing answers, which
  doesn't scale past tiny fixtures. The whole reason the oracle exists.
- **Drop the shared input** → comparing two algorithms on different graphs
  proves nothing.
- **Assert the wrong property** → pinning the *node sequence* instead of the
  *cost* makes the test fail on legitimate equal-cost ties. The property you
  assert has to be the one that's actually invariant.
- **Reference isn't independent** → if A* and Dijkstra shared the buggy cost
  function, they'd agree on a wrong answer. (Here they *do* share `cost.ts` —
  see the honest limit below.)

Optional hardening: the `toBeCloseTo(..., 6)` float tolerance, the separate
performance assertion, the metrics check (`nodesExpanded > 0`).

### Move 3 — the principle

**An oracle test lets you verify code whose correct answer you don't know.**
That's the move that unlocks testing optimizers, compilers, parsers, anything
where the output space is too large to enumerate by hand. You don't need to know
the answer; you need a second, independent way to produce it. The honest limit:
the oracle only catches bugs the two implementations *don't share*. flattr's A*
and Dijkstra both call `cost.ts`, so a bug *inside* `cost.ts` would fool both —
which is exactly why `cost.ts` is tested separately with closed-form expected
values (`cost.test.ts`, → audit lens 5). The oracle guards the *search*; the
closed-form tests guard the *cost*. Together they cover what either alone misses.

---

## Primary diagram

The full picture: the oracle chain plus the independent cost-function guard that
closes its blind spot.

```
  flattr's correctness architecture

  ┌─ closed-form guards (catch shared-dependency bugs) ─────────┐
  │  cost.test.ts → penalty bands, BLOCKED, directed cost       │
  │  exact expected values, hand-derived from the formula       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ both A* and Dijkstra depend on cost.ts
  ┌─ the oracle chain (catch search bugs) ──▼───────────────────┐
  │                                                             │
  │  hand-computed   ──►  dijkstra   ──►  astar  ──►  directed  │
  │  (diamond=200)        (reference)     (gate)     (gate)     │
  │                            │                        │       │
  │                            └────► bidirectional ◄───┘       │
  │                               (pinned to BOTH)              │
  │                                                             │
  │  assertion at every arrow:  candidate.cost ≈ reference.cost │
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Differential testing (compare two implementations of the same spec) is the
classic technique behind compiler fuzzers (csmith vs gcc/clang), database query
testers, and floating-point libraries. The variant here — a *known-correct slow
reference* vs a *fast optimized candidate* — is the textbook way to validate an
optimized algorithm. Dijkstra is provably optimal (Dijkstra 1959); A* is optimal
*iff* its heuristic is admissible (Hart, Nilsson, Raphael 1968). The oracle test
is the admissibility proof discharged by execution: if A* ever disagrees with
Dijkstra on cost, the haversine heuristic has become inadmissible — which is
exactly the failure mode the project's "heuristic must stay admissible"
constraint (`docs/flattr-spec.md` §14) is guarding against. The test is the
enforcement mechanism for that constraint.

Next: `02-property-invariant-tests.md` (the other way to test without knowing
the answer), `05-finite-blocked-sentinel-tests.md` (why the cost guard matters).

---

## Interview defense

**Q: How do you test a shortest-path algorithm when you can't compute the
optimal answer by hand?**

> You don't compute it — you compare it. Run a slow algorithm you know is
> correct (Dijkstra, no heuristic, provably optimal) on the same graph, and
> assert your fast algorithm returns the same *cost*. That's a differential /
> oracle test. In flattr, `astar.test.ts:43` does exactly this on a 144-node
> grid where no human knows the optimum.

```
  dijkstra (trusted) ──cost_ref──┐
                                 ▼ equal?  → A* is admissible
  astar (under test) ──cost_cand─┘
```

> Anchor: I assert the *cost*, not the node list — there can be two equal-cost
> paths, and pinning the sequence makes the test brittle to tie-breaking.

**Q: What's the blind spot of an oracle test, and how do you cover it?**

> It only catches bugs the two implementations *don't share*. flattr's A* and
> Dijkstra both call `cost.ts` — a bug inside the cost function would fool both
> and the oracle would pass on a wrong answer. So `cost.ts` is tested separately
> with closed-form expected values derived from the penalty formula. The oracle
> guards the search; the closed-form tests guard the shared dependency.

> Anchor: "An oracle is only as independent as its two sides — name the shared
> dependency and test it directly."

---

## See also

- `02-property-invariant-tests.md` — the sibling technique for the heap.
- `04-fixture-driven-graph-tests.md` — the graphs the oracle runs on.
- `05-finite-blocked-sentinel-tests.md` — the cost guard that closes the blind spot.
- `audit.md` lens 1 (risk map), lens 2 (pyramid).
- sibling `study-dsa-foundations` — the A*/Dijkstra primitives themselves.
