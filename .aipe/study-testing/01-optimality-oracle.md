# 01 — The Optimality Oracle

**Industry names:** *oracle test* / *differential testing* / *metamorphic testing*
(the "two implementations must agree" variant). **Type:** Industry standard.

---

## Zoom out, then zoom in

You've got two ways to solve the same problem: a slow, obviously-correct one and a fast,
easy-to-break one. How do you test the fast one? You don't hand-type the expected answer —
you make the slow one *be* the answer. That's the oracle.

```
  Zoom out — where the oracle sits in flattr's test stack

  ┌─ Routing core: features/routing/ ──────────────────────────┐
  │                                                            │
  │   dijkstra()  ─────────── the trusted, simple baseline     │
  │      │                    (no heuristic, floods outward)   │
  │      │ its result is the ORACLE                            │
  │      ▼                                                     │
  │   ★ astar.test.ts:38 ★  ← THIS CONCEPT                     │
  │      asserts:  astar.cost  ==  dijkstra.cost               │
  │      ▲                                                     │
  │      │ the implementation under test                       │
  │   astar()  ───────────── fast, informed, easy to break     │
  │                          (haversine heuristic prunes)      │
  └────────────────────────────────────────────────────────────┘
        same oracle extends to → bidirectional.test.ts:8,16
```

The thing you're routing for — flat-not-fast paths — is only *correct* if the optimizer
returns the genuinely optimal path, not just a plausible one. A* is an optimization over
Dijkstra: same answer, fewer nodes expanded. The instant A* and Dijkstra disagree on cost,
A* has a bug (usually an inadmissible heuristic). This test is the tripwire. It is the
single most valuable test in the repo.

---

## The structure pass

Layer the players, pick one axis — **"who is the source of truth for the correct
answer?"** — and watch where it flips.

```
  axis traced: "who decides what the correct cost IS?"

  ┌─ layer: the test ───────────────────────────────┐
  │  decides NOTHING — it only compares two numbers  │
  └───────────────────────┬──────────────────────────┘
                          │   seam: the test trusts dijkstra
  ┌─ layer: dijkstra (oracle) ──▼───────────────────┐
  │  DECIDES the correct cost. trusted by fiat       │  ← truth lives here
  └───────────────────────┬──────────────────────────┘
                          │   seam: must AGREE across it
  ┌─ layer: astar (under test) ─▼───────────────────┐
  │  PROPOSES a cost. believed only if it matches    │  ← truth is checked here
  └──────────────────────────────────────────────────┘
```

The load-bearing seam is between dijkstra and astar: the axis flips from *defines truth* to
*must match truth*. That's the whole pattern. The reason it works is that the two sides
share **nothing but the answer** — different traversal order, different pruning, different
code paths — so a bug in one almost never hides behind the same bug in the other.

---

## How it works

### Move 1 — the mental model

You already do this without naming it. When you refactor a function, you keep the old one
around and assert `newImpl(x) === oldImpl(x)` over a bunch of inputs before deleting the
old one. The oracle test is that, formalized: **the trusted implementation is the expected
value.**

```
  the oracle shape — two paths to one truth

         same graph, same start, same goal
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
     ┌─────────┐             ┌─────────┐
     │ dijkstra│  ORACLE     │  astar  │  UNDER TEST
     │ floods  │             │ pruned  │
     └────┬────┘             └────┬────┘
          │ cost = 200            │ cost = 200
          └───────────┬───────────┘
                      ▼
              assert EQUAL  ──►  ✓ astar is optimal
              (to 6 decimals)    ✗ astar has a bug
```

The strategy in one sentence: **prove the fast algorithm correct by forcing it to agree
with the slow one it's allowed to replace.**

### Move 2 — the walkthrough

**The two engines are the same function with different knobs.** This is what makes the
oracle clean. `features/routing/astar.ts:22` defines one `search(...)` engine; the
"progression stages" are just `(costFn, heuristicFn)` choices:

```ts
// features/routing/astar.ts:135-144  (annotated)
export function dijkstra(graph, startId, goalId) {
  return search(graph, startId, goalId, Infinity, distanceCost, zeroHeuristic);
  //                                                ▲            ▲
  //                                    distance cost      zeroHeuristic → it's
  //                                                       plain Dijkstra (no pruning)
}
export function astar(graph, startId, goalId) {
  return search(graph, startId, goalId, Infinity, distanceCost, haversineHeuristic);
  //                                                ▲            ▲
  //                                     SAME cost        haversine lower bound
  //                                                       → A* (prunes, same optimum)
}
```

Same `distanceCost`, *different heuristic*. A* layers a heuristic on top of Dijkstra. If
the heuristic is admissible (never overestimates — haversine is a straight-line lower bound
on real distance), the optimal cost is *identical*. The test is checking exactly that
admissibility, indirectly, by checking the costs match.

**The assertion: compare to the oracle, not to a literal.** Here is the test itself:

```ts
// features/routing/astar.test.ts:37-45  (annotated)
describe("astar (stage 2, informed search)", () => {
  it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
    const g = makeGridGraph(12);              // a 12x12 lattice fixture
    const d = dijkstra(g, "0,0", "11,11");    // ① the ORACLE computes truth
    const a = astar(g, "0,0", "11,11");       // ② the engine under test
    expect(a.path).not.toBeNull();
    expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6);     // ③ THE GATE
    expect(a.path!.lengthM).toBeCloseTo(d.path!.lengthM, 6);
  });
```

Walk it one line at a time:

- **① The oracle runs first.** `d` is Dijkstra's result. We trust it. Dijkstra is simple
  enough to eyeball-verify and has its own tests against hand-known answers
  (`astar.test.ts:6` checks the diamond's known shortest path is exactly `["S","A","G"]`,
  cost 200). The oracle is itself anchored — that's what makes it trustworthy.
- **② The engine under test runs on the *same* graph and endpoints.** No new fixture, no
  re-typing the answer. Whatever the correct cost is, both must find it.
- **③ The gate: `toBeCloseTo(d.path!.cost, 6)`.** Not `toBe`. Floating-point haversine sums
  won't be bit-identical across two traversal orders, so it asserts agreement to 6 decimal
  places — tight enough to catch a real bug, loose enough to ignore IEEE-754 noise.

**The oracle's reach: it extends to the harder engines.** Once you have the pattern, you
reuse it. `bidirectional.test.ts:8` does the exact same move for the meet-in-the-middle
engine:

```ts
// features/routing/bidirectional.test.ts:8-14  (annotated)
const b = bidirectional(g, "S", "G", Infinity, distanceCost);
const d = dijkstra(g, "S", "G");
expect(b.path!.nodes).toEqual(d.path!.nodes);          // same path
expect(b.path!.cost).toBeCloseTo(d.path!.cost, 6);     // same cost — oracle again
```

And it composes with the *next* engine up the chain: `bidirectional.test.ts:16` checks
bidirectional's directed-cost result against `directedAstar`'s — the oracle for stage N is
the already-verified stage N-1. The trust chain is:

```
  the oracle trust chain — each stage validates the next

  hand-known answer  (diamondGraph: S,A,G = 200, astar.test.ts:6)
        │ validates
        ▼
  dijkstra  ──validates──►  astar  ──validates──►  directedAstar
                                                        │ validates
                                                        ▼
                                                  bidirectional
```

Every link asserts equality against the link before it. Break any engine and the chain
lights up red at exactly that link.

### Move 2 variant — the load-bearing skeleton

Strip the oracle test to its irreducible kernel:

1. **A trusted oracle** — a second way to get the answer you believe by fiat (here:
   Dijkstra, itself anchored to a hand-known fixture). *Remove it* and you're back to
   hand-typing expected values, which can't keep up as the cost function evolves.
2. **The same input fed to both** — identical graph, start, goal. *Remove the sameness*
   (different fixtures) and a disagreement tells you nothing — maybe they just had different
   inputs.
3. **An equality assertion with the right tolerance** — `toBeCloseTo(..., 6)`. *Remove the
   tolerance* (use `toBe`) and float noise makes it flaky; *make it too loose* (`, 1`) and
   a real 0.5% routing bug slips through.

The **independence of the two sides** is the part people forget. An oracle test only works
because the oracle and the code-under-test fail *differently*. If you implemented A* by
calling Dijkstra internally, the test would be a tautology — it'd pass even when both are
wrong. Here they share only `distanceCost`; the search/prune logic is genuinely separate.
That independence is what you'd name in an interview to show you understand *why* the
pattern catches bugs.

**Skeleton vs hardening:** the kernel is oracle + same-input + tolerant-equality.
Everything else — checking `nodesExpanded <= dijkstra.nodesExpanded` (`astar.test.ts:47`,
proving A* actually prunes), the metrics asserts — is hardening. Nice to have, not what
makes it an oracle.

### Move 3 — the principle

**When you have two implementations that must agree, you don't need to know the right
answer — you need them to never disagree.** The slow, simple one is a test fixture you
don't have to maintain. This generalizes far past routing: a new SQL query vs the old one
on the same DB snapshot, a SIMD path vs the scalar path, a cache vs a recompute. Any time
"the optimized version" exists alongside "the obvious version," the obvious version is your
oracle. flattr's router is the clean case because optimality is *exactly* the property
that's easy to break and hard to eyeball.

---

## Primary diagram

The whole pattern, one frame:

```
  THE OPTIMALITY ORACLE — full recap

  ┌─ fixture layer (features/routing/fixtures.ts) ─────────────┐
  │  makeGridGraph(12) / diamondGraph()  — known, hand-built   │
  └────────────────────────────┬───────────────────────────────┘
                               │ same g, start, goal to BOTH
            ┌──────────────────┴──────────────────┐
            ▼                                      ▼
  ┌─ ORACLE ─────────────┐            ┌─ UNDER TEST ───────────┐
  │ dijkstra()           │            │ astar()                │
  │ astar.ts:136         │            │ astar.ts:141           │
  │ zeroHeuristic, floods│            │ haversineHeuristic,    │
  │ → cost = TRUTH       │            │   prunes → cost = ?    │
  └──────────┬───────────┘            └───────────┬────────────┘
             │  d.path.cost                        │  a.path.cost
             └──────────────────┬──────────────────┘
                                ▼
                ┌─ assertion (astar.test.ts:42) ─┐
                │ toBeCloseTo(d.cost, 6 decimals)│
                │  match → A* provably optimal   │
                │  differ → A* has a bug         │
                └────────────────────────────────┘
                                │ pattern reused, stage by stage
                                ▼
                dijkstra ⇒ astar ⇒ directedAstar ⇒ bidirectional
```

---

## Elaborate

This is **differential testing** (run two implementations, compare outputs) and its cousin
**metamorphic testing** (assert a relation that must hold even when you don't know the
absolute answer — e.g. `gradeAstar(S→G)` reversed equals `gradeAstar(G→S)` for an
abs-grade cost, `astar.test.ts:65`). Both dodge the oracle problem: the hardest part of
testing is usually *knowing the right answer*, and these techniques sidestep it by relating
outputs instead of pinning them.

It's the same instinct behind property-based testing (next file, `02`), which is why those
two patterns cluster in flattr's routing tests. The optimality oracle pins a *relation
between two functions*; the property test pins a *relation an output must always satisfy*.
Both replace "I typed in what I think the answer is" with "here's a law that must hold."

Where to read next: `04-fixture-driven-graph-tests.md` (the hand-built graphs the oracle
runs on), `02-property-invariant-tests.md` (the sibling technique), and the
**`study-dsa-foundations`** guide for the A*/Dijkstra admissibility theory the oracle is
silently enforcing.

---

## Interview defense

**Q: "How do you test that A* returns the optimal path, not just a valid one?"**

The strongest possible answer, because it shows you know the failure mode:

> "I don't hand-type the expected path — I use Dijkstra as an oracle. Dijkstra is the simple
> uninformed baseline, provably optimal and easy to verify against known small graphs. A* is
> the optimization. I run both on the same graph and assert their costs are equal to 6
> decimals. The key is that they share *only* the cost function — different traversal,
> different pruning — so a bug in A*'s heuristic shows up as a disagreement. If I'd
> implemented A* by calling Dijkstra, the test would be a tautology. It's
> `astar.test.ts:38`."

```
  sketch while you talk:

  dijkstra ──┐
             ├──► same graph ──► assert costs EQUAL ──► A* is optimal
  astar ─────┘                   (independent code paths
                                  = real bug detection)
```

**Anchor:** *"The oracle and the code under test must fail differently — that independence
is the whole reason it catches the bug."*

**Q: "Why `toBeCloseTo(..., 6)` and not `toBe`?"** Because two different traversal orders
sum the same haversine floats in a different sequence, so IEEE-754 makes them differ in the
last bit or two. `toBe` would be flaky; `toBeCloseTo(6)` is tight enough to catch any real
routing error (which would be off by meters, not by 1e-7) and loose enough to ignore float
noise. Naming *why* the tolerance is 6 and not 1 is the senior signal.

---

## See also

- `04-fixture-driven-graph-tests.md` — the known-answer graphs the oracle runs on
- `02-property-invariant-tests.md` — the sibling "assert a law, not a value" technique
- `05-finite-blocked-sentinel-tests.md` — why the oracle still returns a path on steep graphs
- `audit.md` lens 1 (coverage) and lens 7 (red-flags) — where this test sits in the suite
- sibling guide **`study-dsa-foundations`** — A*/Dijkstra admissibility the oracle enforces
