# Property & Invariant Tests — asserting a rule holds over many random inputs

*Industry name: **property-based testing** (the seeded-random + invariant
form) and **structural invariant checking**. Type: language-agnostic
technique.*

---

## Zoom out — where this sits

This is how flattr trusts the binary heap underneath the entire router. The
heap is a data structure with one job and a million ways to get the sift logic
subtly wrong; property tests catch the subtle ones that example tests miss.

```
  Zoom out — the heap and its property tests

  ┌─ Engine (features/routing/) ─────────────────────────────┐
  │  search() / dijkstra / astar                             │
  │      │  pushes (node, fScore) and pops the cheapest      │
  │      ▼                                                   │
  │  ┌─ PQueue (pqueue.ts) ──────────────────────────────┐   │
  │  │  binary min-heap: siftUp / siftDown / swap        │   │
  │  │  + checkInvariant()  ← a test-only x-ray method   │   │ ← here
  │  └────────────────────────────────────────────────────┘   │
  │      ▲                                                   │
  │  ★ PROPERTY TESTS ★  (pqueue.test.ts)                    │
  │    seeded-random pushes/pops → assert the RULE holds     │
  └──────────────────────────────────────────────────────────┘
```

The question it answers: **how do you test something that's correct for
*every* sequence of operations, not just the three you thought of?** You can't
enumerate every push/pop interleaving. So instead of asserting a specific
output for a specific input, you assert a *rule that must always be true* and
throw thousands of random (but reproducible) inputs at it.

---

## The structure pass

**Layers.** Two ways to check the same heap, stacked by what they can see:

- outer (black-box): drive the heap through its public API and check the
  *observable behavior* — "pops come out in non-decreasing priority order."
- inner (white-box): reach into the array representation and check the
  *structural invariant* — "every parent's priority ≤ its children's." This is
  the `checkInvariant()` method.

**The axis: observability — "what can the test see?"** Trace it across the two
layers:

- Black-box layer: sees only what a real caller sees (the pop order). Can't
  tell you *why* a bug happened, only *that* the output is wrong.
- White-box layer: sees the internal array. Catches a corrupted heap *the
  moment* it corrupts — mid-sequence, before a single bad pop — and tells you
  the structure broke even if the output happens to look fine so far.

**The seam:** `checkInvariant()` (`pqueue.ts:42-48`). It's a deliberate hole
punched through the encapsulation *for tests only* — the comment says so. That
seam is where a black-box suite (slow to localize bugs) becomes a white-box one
(catches corruption at the step it happens). The axis flips across it: before
the seam, you only know the heap is wrong when a pop is wrong; after it, you
know the instant the array stops being a heap.

---

## How it works

### Move 1 — the mental model

You know how a unit test is `expect(f(3)).toBe(9)` — one input, one expected
output? A property test flips it: `for many random x, expect(someRule(f(x))).toBe(true)`.
You stop predicting outputs and start asserting rules.

```
  Property test — one rule, thousands of inputs

   seeded RNG ──► input₁ ──► [system] ──► output₁ ──► assert RULE(output₁)
        │         input₂ ──► [system] ──► output₂ ──► assert RULE(output₂)
        │           ⋮                        ⋮              ⋮
        └─────────► inputₙ ──► [system] ──► outputₙ ──► assert RULE(outputₙ)

   one rule that must hold for ALL of them.
   a single false → the seed + step pinpoints the failing input.
```

The strategy in one sentence: **don't assert what the output is; assert a
property the output must always have, and generate enough inputs that a
violation surfaces.**

### Move 2 — the walkthrough

**Step 1 — make the randomness reproducible.** A property test that fails on
an input you can't regenerate is useless — you can't debug it. So the
"randomness" is a seeded linear-congruential generator: same seed, same
sequence, every run.

```
  Pseudocode — a seeded LCG (deterministic "random")

  function lcg(seed):
    s = seed                                  // fixed starting state
    return function():
      s = (1664525 * s + 1013904223) mod 2³²  // advance the state
      return s / 2³²                          // → a number in [0, 1)

  // lcg(7) ALWAYS produces the same stream. A failure at seed 7,
  // step 142 can be re-run and re-seen. No flake, no "works on retry."
```

This is the line between a property test and a flaky test. Built-in
`Math.random()` here would mean a failure you can never reproduce. The
boundary condition: **if you can't replay the failing input, the test trains
people to hit "rerun" until it's green** — the worst outcome in testing.

**Step 2 — the behavioral property: pops are non-decreasing.** The defining
promise of a priority queue. Drain it and every pop must be ≥ the last.

```
  Execution trace — the pop-order property (one seed)

  push order (item, priority):  (0,742) (1,531) (2,531) (3,90) (4,888) ...
  ──────────────────────────────────────────────────────────────────────
  pop 1 → priority 90    prev=-∞   90 ≥ -∞   ✓   prev=90
  pop 2 → priority 531   prev=90   531 ≥ 90  ✓   prev=531
  pop 3 → priority 531   prev=531  531 ≥ 531 ✓   prev=531   ← ties OK
  pop 4 → priority 742   prev=531  742 ≥ 531 ✓   prev=742
  pop 5 → priority 888   prev=742  888 ≥ 742 ✓   prev=888
  ──────────────────────────────────────────────────────────────────────
  property held for all pops. repeated for seeds 1..50.
```

Run across 50 seeds × 200 items each — 10,000 pops, every one checked. Plus a
second framing of the *same* property: pop everything, assert the result
equals the input priorities run through `Array.sort()` (the array sort is a
mini-oracle, like `01-optimality-oracle.md`).

**Step 3 — the structural invariant: every parent ≤ its children.** This is
the white-box check. After *every* operation in a random 2000-step mix of
pushes and pops, walk the backing array and confirm it's still a valid heap.

```
  Pseudocode — the heap structural invariant

  function checkInvariant(heap):
    for i from 1 to heap.length - 1:
      parent = (i - 1) / 2                    // integer / 2 = parent index
      if heap[parent].priority > heap[i].priority:
        return false                          // parent heavier than child = BROKEN
    return true

  // called after EVERY push/pop in a 2000-step random sequence.
  // a sift bug corrupts the array at step k; this catches it AT step k,
  // not 50 pops later when the output finally looks wrong.
```

This is the load-bearing technique people forget. The behavioral test (Step
2) tells you the *output* is wrong; the invariant test tells you the
*structure* broke *the moment it broke*. On a sift-down off-by-one, the
behavioral test might pass for a while (a slightly-corrupt heap can still pop a
few right values) — the invariant test fails on the exact operation that did
the damage.

**Step 4 — the targeted edge cases.** Property tests cover the bulk; a few
hand-picked cases nail the corners property tests rarely hit by chance: empty
heap returns `undefined`, duplicate items *and* duplicate priorities allowed,
and — flattr-specific — a large-finite `BLOCKED` priority (1e9) sorts to the
back behind a normal priority (10).

```
  The BLOCKED-orders-last edge case

  push("blocked", 1e9)   push("ok", 10)
         │                     │
         ▼                     ▼
       heap top = "ok"  ← 10 < 1e9, so the steep-but-routable
                          edge waits behind the flat one.
```

That last one ties the heap directly to flattr's design: BLOCKED is finite, so
it *orders* like any priority — it doesn't crash the comparison the way
`Infinity` arithmetic would. → `05-finite-blocked-sentinel-tests.md`.

### Move 2 variant — the load-bearing skeleton

The kernel of this technique is four parts:

1. **A seeded generator.** Drop it → failures are irreproducible → the test is
   worse than none, because it trains people to ignore red.
2. **A property/invariant, not an expected value.** Drop it → you're back to
   example tests and the combinatorial space goes uncovered.
3. **Volume.** Drop it (run once) → rare interleavings never surface; the
   2000-step mix exists precisely to hit orderings you'd never write by hand.
4. **A white-box invariant check (the bonus tier).** Drop it → you still catch
   wrong *outputs* but lose the "fails at the exact corrupting step"
   localization.

Optional hardening: the sorted-array cross-check (an oracle on top of the
property), the targeted edge cases. The skeleton is "seeded RNG + invariant +
volume."

### Move 3 — the principle

**When the input space is too big to enumerate, assert rules instead of
outputs — and make the randomness reproducible.** A behavioral property
("output is sorted") plus a structural invariant ("the data structure stays
valid after every step") is a far tighter net than any number of hand-written
examples. The seed is what turns "random testing" from a liability into an
asset.

---

## Primary diagram

The full recap: both test layers driving the heap, the seam between them, and
the seed feeding both.

```
  flattr's property + invariant tests — full recap

  ┌─ seeded source ──────────────────────────────────────────┐
  │  lcg(seed)  — deterministic stream, replayable (test:5-11)│
  └───────────────┬──────────────────────────┬───────────────┘
                  │ random (item, priority)   │ random push/pop choice
                  ▼                           ▼
  ┌─ BLACK-BOX (behavior) ──────┐   ┌─ WHITE-BOX (structure) ─────────┐
  │ drain → assert each pop ≥   │   │ after EVERY op, walk the array, │
  │ prev (non-decreasing)       │   │ assert parent ≤ children        │
  │ + equals Array.sort()       │   │ (checkInvariant, pqueue.ts:42)  │
  │ test:23-51                  │   │ test:67-78                      │
  └──────────────┬──────────────┘   └────────────────┬────────────────┘
                 └──────────► PQueue (pqueue.ts) ◄────┘
                              siftUp / siftDown
       SEAM: checkInvariant() — a test-only window into the private array
```

---

## Implementation in codebase

**Use cases.** This is reached for exactly once in flattr — on `PQueue`, the
one hand-rolled data structure whose correctness the whole router rests on.
It's the right place: a heap is small, pure, has a crisp invariant, and a sift
bug is the kind of thing example tests miss. (The router *above* the heap uses
the oracle pattern instead — `01-optimality-oracle.md` — because its invariant,
"optimal cost," is exactly what Dijkstra computes.)

The seeded generator, `features/routing/pqueue.test.ts:5-11`:

```
  features/routing/pqueue.test.ts  (lines 5-11)

  function lcg(seed: number): () => number {
    let s = seed >>> 0;                     ← coerce to uint32 starting state
    return () => {
      s = (1664525 * s + 1013904223) >>> 0; ← classic Numerical Recipes LCG
      return s / 0x100000000;               ← normalize to [0, 1)
    };                          │
  }                             └─ same seed → same stream. THIS is what makes
                                   a failure reproducible. Math.random() here
                                   would make every failure a one-time ghost.
```

The structural invariant under test, `features/routing/pqueue.test.ts:67-78`,
calling into `features/routing/pqueue.ts:42-48`:

```
  features/routing/pqueue.test.ts  (lines 67-78)

  it("keeps the heap invariant after a random mix of pushes and pops", () => {
    const rand = lcg(99);                          ← fixed seed
    const pq = new PQueue<number>();
    for (let step = 0; step < 2000; step++) {      ← 2000 random operations
      if (rand() < 0.6 || pq.isEmpty()) {          ← 60% push, else pop
        pq.push(step, Math.floor(rand() * 1000));  ←  (push if empty, always)
      } else {
        pq.pop();
      }
      expect(pq.checkInvariant()).toBe(true);      ← CHECK AFTER EVERY STEP
    }                            │
  });                            └─ not after the loop — after EACH op. A sift
                                    bug corrupts at step k; this fails at step
                                    k, pinpointing the operation, not 1500
                                    steps later when a pop finally misbehaves.
```

The `checkInvariant()` it calls is marked test-only in the source
(`pqueue.ts:41`: *"Test-only: assert priority[parent] <= priority[child]"*).
That comment is the seam made explicit: a method that exists purely to let
white-box tests see inside, with no production caller.

The behavioral property (`pqueue.test.ts:23-40`) loops `seed = 1..50`, pushes
200 items per seed, and asserts each `peekPriority()` before a `pop()` is ≥ the
previous — 10,000 ordered pops checked. The cross-check
(`pqueue.test.ts:42-51`) pops everything and asserts it equals
`[...pairs].sort()`, using the language's sort as a tiny oracle.

---

## Elaborate

This is the seeded-random branch of **property-based testing** — the family
QuickCheck (Haskell) started and `fast-check` (JS), Hypothesis (Python), and
proptest (Rust) carry today. Those libraries add automatic *shrinking* (when a
random input fails, they minimize it to the smallest failing case). flattr
doesn't use a library — it's a hand-rolled LCG and explicit loops, which is the
honest spot for it: the property is simple, the inputs are just integers, and
pulling in `fast-check` would be more machinery than the one data structure
needs. If the invariants got more complex, `fast-check` with shrinking would
earn its place. That's the constructive upgrade path.

The white-box `checkInvariant` move is **structural invariant checking** — the
same discipline as `assert(tree.isBalanced())` after every AVL rotation, or a
database checking its B-tree is still ordered after a page split. The principle:
when a structure has an invariant cheaper to *check* than to *maintain
correctly*, check it constantly in tests.

It composes with `01-optimality-oracle.md`: the oracle says "agrees with a
trusted reference," the property says "obeys a rule." Both abandon hand-written
expected values, which is the only way to cover a combinatorial space. The heap
itself is taught in `.aipe/study-dsa-foundations/` (binary heap, sift
up/down) — you've already built `BinaryHeap.ts` and `PriorityQueue.ts` from
scratch, so the structure is familiar; the *testing technique* on top of it is
the new layer.

---

## Interview defense

**Q: How do you test a data structure that has to be correct for every
operation sequence?** Not with examples — there are infinitely many sequences.
I assert *properties*: a behavioral one (pops come out non-decreasing) and a
*structural invariant* (every parent ≤ its children in the backing array),
checked after every operation in a 2000-step random mix. The detail that
matters: the randomness is a **seeded LCG**, so a failure is reproducible. An
unseeded property test that you can't replay is worse than no test — it trains
the team to hit rerun.

```
  seed → random ops → [heap] → assert invariant AFTER EACH op
                                (catches corruption at the step it happens)
```

**Q: You already test that pops come out sorted. Why also reach into the
private array with `checkInvariant`?** Because the behavioral test tells you
the *output* is wrong; the invariant test tells you the *structure* broke at
the exact step it broke. A sift-down off-by-one can pop a few correct values
before the corruption surfaces — the invariant check fails on the operation
that caused it, which is where the bug is. It's white-box localization on top
of black-box behavior. Anchor: `checkInvariant` is marked test-only in
`pqueue.ts:41` — it's a deliberate seam, not a leak.

**Q: Why hand-roll the LCG instead of `fast-check`?** The property is simple
and the inputs are integers — `fast-check` would be more machinery than one
heap justifies, and I'd lose nothing but automatic shrinking. If the invariants
got complex, shrinking would earn the dependency. Right call for now, clear
upgrade path.

---

## Validate

**Reconstruct.** Write the four kernel parts of this technique (seeded
generator, property-not-output, volume, white-box invariant) and what breaks
without each.

**Explain.** Why is `checkInvariant()` called *inside* the 2000-step loop
(`pqueue.test.ts:76`) and not once after it? What bug would the after-the-loop
version miss?

**Apply.** flattr's `PriorityQueue` later grows an `updatePriority(item,
newP)` method (like your reincodes `PriorityQueue.ts`). What property test do
you add? (Answer: after a random mix that includes updates, `checkInvariant()`
still holds, and the affected item now pops at its new priority.)

**Defend.** A reviewer says "the seed makes it deterministic, so it's not
really property testing — just 50 fixed tests." Respond. (Hint: the seed fixes
the *replay*, not the *coverage* — you still exercise orderings no human would
hand-write; determinism is what makes a found failure debuggable.)

References: `features/routing/pqueue.test.ts:5-11,23-78`,
`features/routing/pqueue.ts:42-48`.

---

## See also

- `01-optimality-oracle.md` — the sibling "no hand-written expected value"
  technique, one layer up on the router.
- `05-finite-blocked-sentinel-tests.md` — the BLOCKED-orders-last edge case
  (`pqueue.test.ts:101-106`) and why finite beats Infinity.
- `audit.md` §4 (determinism), §5 (edge cases).
- `.aipe/study-dsa-foundations/` — binary heap, sift up/down, the structure
  being tested.
