# 02 — Property & Invariant Tests

**Industry names:** property-based testing · invariant testing · metamorphic
testing · "test the rule, not the example." **Type:** Industry standard
(QuickCheck lineage; here hand-rolled, no fast-check library).

---

## Zoom out — where this lives

This guards the hand-rolled binary heap that sits *under* Dijkstra and A*. A
silent bug in the heap corrupts every route, so it's tested with a different,
stronger discipline than example-based tests.

```
  Zoom out — the invariant guards the foundation

  ┌─ RUNTIME engine ────────────────────────────────────────────┐
  │  astar / dijkstra / bidirectional                           │
  │        │ all push/pop through...                            │
  │        ▼                                                    │
  │  ★ PQueue (hand-rolled binary heap) ★  ← property-tested    │ ← we are here
  │        invariant: parent.priority ≤ children.priority      │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: an example test checks one input ("push 3, 1, 2 → pop 1, 2, 3"). A
property test checks a *rule that holds for every input* ("after any sequence of
ops, the heap invariant holds") and then throws thousands of random sequences at
it. You don't enumerate cases; you state the law and let randomness hunt for the
counterexample.

---

## Structure pass

**Layers:** one structure (the heap), two ways to verify it — by *invariant*
(internal property always true) and by *oracle* (external behavior matches a
sorted array).

**Axis — "what guarantees this assertion holds for inputs I didn't write?"**

```
  axis = "coverage source: enumerated, or generated?"

  ┌─ example test ──┐  seam  ┌─ property test ─────────┐
  │ YOU pick the    │ ══╪══► │ the GENERATOR picks; you │
  │ inputs (3,1,2)  │ (flips)│ assert a law over all of │
  │ → finite cases  │        │ them → 2000 random ops   │
  └─────────────────┘        └──────────────────────────┘
```

The axis flips from "author-chosen cases" to "machine-generated cases." That
flip is the whole value: the bug you didn't think to write a case for is the one
that ships.

**Seam:** `expect(pq.checkInvariant()).toBe(true)` — checked every step.

---

## How it works

### Move 1 — the mental model

You know how a `Array.prototype.sort()` test would be tedious if you had to
hand-write every input permutation? Property testing flips it: state the law
("the output is sorted and a permutation of the input") and let a generator
produce the inputs. flattr does two flavors — assert the *internal* invariant,
and assert against an *external* oracle (a sorted array).

```
  property test — generate, run, assert the law

   seed ──► LCG ──► random op sequence ──► run on PQueue
                                              │
                                              ▼
                              ┌─ invariant: heap property holds? ─┐
                              │  parent ≤ both children, every node│
                              └────────────────────────────────────┘
                                              │  (every step)
                                              ▼
                                       pass / fail
```

### Move 2 — the walkthrough

**First: deterministic randomness.** Property tests need random inputs *and*
reproducible failures. The repo hand-rolls a linear congruential generator with
an explicit seed so a failing run replays identically:

```ts
// pqueue.test.ts:5-11 — seeded PRNG, not Math.random()
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;   // classic LCG constants
    return s / 0x100000000;                  // → [0, 1)
  };
}
```

Why not `Math.random()`? Because an unseeded random failure is a *flaky* test —
it fails once, passes on rerun, and you can never reproduce it. → that's the
exact red flag `audit.md` lens 4 marks CLEAR precisely *because* of this LCG.

**The invariant test — assert the structural law, every step.** This is the
strongest test in the file:

```ts
// pqueue.test.ts:67-78
it("keeps the heap invariant after a random mix of pushes and pops", () => {
  const rand = lcg(99);
  const pq = new PQueue<number>();
  for (let step = 0; step < 2000; step++) {
    if (rand() < 0.6 || pq.isEmpty()) {
      pq.push(step, Math.floor(rand() * 1000));
    } else {
      pq.pop();
    }
    expect(pq.checkInvariant()).toBe(true);   // ← the law, checked EVERY step
  }
});
```

Line by line: 2000 iterations, 60/40 push/pop mix, forced push when empty. The
load-bearing line is `checkInvariant()` *inside* the loop — it checks the heap
property (parent ≤ children) after *every single op*, not just at the end. That's
what catches the bug where the heap is momentarily corrupt and self-heals — an
end-only check would miss it.

**The oracle test — assert external behavior across many seeds.** The companion
to the invariant: pops must come out in sorted order, verified against a sorted
array (an oracle, like `01`), across 50 seeds:

```ts
// pqueue.test.ts:23-40 — sorted-order oracle, 50 seeds × 200 items
for (let seed = 1; seed <= 50; seed++) {
  const rand = lcg(seed);
  const pq = new PQueue<number>();
  for (let i = 0; i < 200; i++) pq.push(i, Math.floor(rand() * 1000));
  let prev = -Infinity;
  while (!pq.isEmpty()) {
    const before = pq.peekPriority()!;
    pq.pop();
    expect(before).toBeGreaterThanOrEqual(prev);   // non-decreasing = sorted
    prev = before;
  }
}
```

And the direct array oracle (`pqueue.test.ts:42`): push 300 random pairs, drain
the queue, assert it `toEqual` the same priorities `.sort()`ed. Same move as the
optimality oracle in `01` — compare against a trusted reference (`Array.sort`)
rather than hand-computing.

```
  two laws, two coverage sources

  INVARIANT (internal)          ORACLE (external)
  ─────────────────────         ─────────────────────────
  parent ≤ children             pops are non-decreasing
  checked every step            == [...priorities].sort()
  1 seed × 2000 ops             50 seeds × 200 items
  catches mid-op corruption     catches wrong ordering
```

### Move 2 variant — the load-bearing skeleton

```
  a generator (seeded)  +  a property that holds for ALL inputs
  +  many generated inputs  +  the property asserted on each
```

What breaks without each part:

- **Drop the seed** → failures are unreproducible; the test becomes flaky and
  people learn to ignore its red. The seed is what turns "random" into
  "deterministic random."
- **Assert per-example instead of a property** → you're back to example testing;
  the input the author didn't imagine goes unchecked.
- **Check only at the end, not every step** → you miss transient corruption that
  self-heals. `checkInvariant()` *inside* the loop is the load-bearing choice.
- **Too few generated inputs** → the counterexample exists but never gets drawn.
  2000 ops / 50 seeds is the search budget.

Optional hardening: duplicate-handling cases (`pqueue.test.ts:53`), the
interleaved-drain test (`:80`), the BLOCKED-orders-to-back case (`:101` → `05`).

### Move 3 — the principle

**Property tests find the bug you didn't think to write a test for.** Example
tests can only cover cases you imagined; a generator covers the case you didn't.
The two flattr flavors map to the two questions you can ask of any structure:
"is it internally consistent?" (invariant) and "does it behave correctly from
outside?" (oracle). Reach for invariant tests on anything with a structural rule
that must always hold — a heap, a balanced tree, a parser's AST, a state
machine's reachable states.

---

## Primary diagram

```
  pqueue.test.ts — the full verification surface

  ┌─ seeded generator (lcg) ────────────────────────────────────┐
  │  reproducible random op streams                             │
  └───────────────┬──────────────────────┬──────────────────────┘
                  │                       │
        ┌─────────▼─────────┐   ┌─────────▼──────────┐
        │ INVARIANT path    │   │ ORACLE path        │
        │ 2000 ops, check   │   │ 50 seeds → compare │
        │ heap property     │   │ pops to Array.sort │
        │ EVERY step        │   │                    │
        └─────────┬─────────┘   └─────────┬──────────┘
                  │                        │
                  └──────────┬─────────────┘
                             ▼
              every Dijkstra/A* route relies on
              this heap being correct
```

---

## Elaborate

Property-based testing comes from QuickCheck (Claessen & Hughes, Haskell, 2000);
the JS lineage is fast-check. flattr doesn't use a library — it hand-rolls the
generator (the LCG) and the shrinking is absent (a real fast-check would shrink a
failing 2000-op sequence down to the minimal reproducer; here you'd get the raw
seed and have to debug from it). That's the honest tradeoff: no dependency, but
no automatic shrinking. For a single heap it's the right call; if invariant
testing spread to more structures, adopting fast-check would buy shrinking for
free. The invariant-every-step pattern is also *metamorphic* in spirit — you're
asserting a relation that survives every transformation, which is the same idea
behind testing that `sort(sort(x)) == sort(x)`.

---

## Interview defense

**Q: Why property-test a data structure instead of writing example cases?**

> Example tests only cover inputs I thought of. A heap bug usually hides in a
> sequence I'd never hand-write — a specific interleaving of pushes and pops. So
> I assert the *invariant* (parent ≤ children) and throw 2000 random ops at it,
> checking the invariant after every op. flattr's `pqueue.test.ts:67` does this.
> The key detail: check *every step*, not just the end — that catches transient
> corruption that self-heals.

```
  random ops ──► heap ──► checkInvariant() after EACH op ──► true?
```

**Q: How do you keep a random test from being flaky?**

> Seed it. flattr uses an LCG with explicit seeds (`pqueue.test.ts:5`), so a
> failure replays identically — `Math.random()` would make the failure
> unreproducible, which trains people to ignore the red. Anchor: "random inputs,
> deterministic failures — that's the whole discipline."

---

## See also

- `01-optimality-oracle.md` — the sorted-array oracle here is the same move.
- `05-finite-blocked-sentinel-tests.md` — the BLOCKED-orders-to-back heap case.
- `audit.md` lens 4 (determinism — why the LCG matters), lens 5 (edge cases).
- sibling `study-dsa-foundations` — the BinaryHeap / PriorityQueue primitive.
