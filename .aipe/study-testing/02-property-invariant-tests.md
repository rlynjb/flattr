# 02 — Property / Invariant Tests

**Industry names:** *property-based testing* / *invariant testing* / *fuzzing with a
checked law* (the QuickCheck family). **Type:** Industry standard.

---

## Zoom out, then zoom in

Example tests check "for *this* input, I get *that* output." Property tests check "for
*any* input, *this law* holds." You stop typing expected values and start asserting truths
the code must never violate — then throw thousands of random inputs at it.

```
  Zoom out — where the property tests live

  ┌─ Routing core: features/routing/ ──────────────────────────┐
  │                                                            │
  │   pqueue.ts  ── hand-rolled binary min-heap                │
  │      │         (knows nothing about graphs)                │
  │      ▼                                                     │
  │   ★ pqueue.test.ts ★  ← THIS CONCEPT                       │
  │      • heap invariant holds after 2000 random ops         │
  │      • pop order == sorted oracle, across 50 seeds        │
  │      • all driven by a SEEDED LCG (reproducible)          │
  │      ▲                                                     │
  │   used by → astar.ts search frontier (every route)        │
  └────────────────────────────────────────────────────────────┘
```

The `PQueue` is the beating heart of every search in the router — it decides which node to
expand next. If its heap invariant ever breaks, A* silently expands the wrong node and
returns a wrong route, with no crash. You can't catch that with three hand-picked
examples. You catch it by asserting "parent priority ≤ child priority, *always*" and
hammering it with 2000 random pushes and pops.

---

## The structure pass

Layer the test, pick the axis — **"what is being asserted: a value, or a law?"** — and
watch it flip.

```
  axis traced: "value or law?"

  ┌─ example test (pqueue.test.ts:14) ──────────────┐
  │  asserts a VALUE: empty queue → pop() undefined  │  ← concrete
  └───────────────────────┬──────────────────────────┘
                          │  seam: the assertion generalizes
  ┌─ property test (pqueue.test.ts:67) ──▼──────────┐
  │  asserts a LAW: checkInvariant() == true after   │  ← universal
  │  EVERY one of 2000 random operations             │
  └───────────────────────┬──────────────────────────┘
                          │  seam: needs a reproducible input source
  ┌─ the generator (pqueue.test.ts:5) ───▼──────────┐
  │  seeded LCG — random but DETERMINISTIC           │  ← the engine
  └──────────────────────────────────────────────────┘
```

Two seams matter. First, value→law: the assertion stops being about one output and becomes
about a property of *all* outputs. Second, law→generator: a property test is only as good
as its input source, and a property test that uses `Math.random()` is a flaky test — so
flattr's generator is a *seeded* LCG, random in coverage but deterministic in replay.

---

## How it works

### Move 1 — the mental model

You've sorted an array and checked it's sorted by eyeballing the first few elements. A
property test does the rigorous version: it asserts `for every i, arr[i] <= arr[i+1]` and
then feeds it 50 different random arrays. The law (`sorted`) is the test; the inputs are
disposable.

```
  the property-test loop — law over many inputs

   seed ──► generate random ops ──► run them ──► CHECK THE LAW
    │              │                   │              │
    │         push/pop mix        mutate heap    invariant holds?
    │                                                 │
    └──────────── next op, 2000 times ────────────────┘
                                              any violation → fail,
                                              and it's reproducible
```

The strategy in one sentence: **assert the law the code must never break, then fuzz it with
reproducible randomness until you trust it.**

### Move 2 — the walkthrough

**Part 1 — the invariant is built into the data structure as a test seam.** The heap
exposes a method whose only job is to let a test check its internal law:

```ts
// features/routing/pqueue.ts:41-48  (annotated)
/** Test-only: assert priority[parent] <= priority[child] across the array. */
checkInvariant(): boolean {
  for (let i = 1; i < this.heap.length; i++) {
    const parent = (i - 1) >> 1;                       // binary-heap parent index
    if (this.heap[parent].priority > this.heap[i].priority) return false;  // LAW broken
  }
  return true;                                          // LAW holds for the whole array
}
```

This is the heap's defining invariant — every parent's priority ≤ both children's. The
method walks the backing array and verifies it everywhere. It exists *for the test*; that's
deliberate design-for-testability (cross-link: `audit.md` lens 3).

**Part 2 — the generator is a seeded LCG, not `Math.random()`.** This is the line that
makes the whole thing non-flaky:

```ts
// features/routing/pqueue.test.ts:5-11  (annotated)
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;   // classic LCG step (Numerical Recipes constants)
    return s / 0x100000000;                  // normalize to [0, 1)
  };
}
```

Same seed → same sequence, every run, every machine. If a property fails on seed 99, you
re-run seed 99 and get the *identical* failing trace. With `Math.random()` you'd get a
one-in-a-thousand ghost you can never reproduce. (See `03-injected-fetch-isolation.md` and
`audit.md` lens 4 — this is the same determinism discipline applied to randomness instead of
to the network.)

**Part 3 — the invariant property: 2000 random ops, checked after every one.** Here's the
fuzzer:

```ts
// features/routing/pqueue.test.ts:67-78  (annotated)
it("keeps the heap invariant after a random mix of pushes and pops", () => {
  const rand = lcg(99);                       // reproducible randomness
  const pq = new PQueue<number>();
  for (let step = 0; step < 2000; step++) {
    if (rand() < 0.6 || pq.isEmpty()) {       // 60% push, 40% pop, but never pop empty
      pq.push(step, Math.floor(rand() * 1000));
    } else {
      pq.pop();
    }
    expect(pq.checkInvariant()).toBe(true);   // ← the LAW, checked after EVERY op
  }
});
```

Walk it:

- The mix is **60/40 push/pop** so the heap grows and shrinks through many shapes — not just
  fill-then-drain, but the messy interleaved states where `siftUp`/`siftDown` bugs hide.
- `|| pq.isEmpty()` forces a push when empty, so it never tests `pop()` on an empty heap
  here (that's a separate example test at `:14`).
- The assertion is **inside the loop**. It checks the invariant after *every single
  operation*, so a violation is caught the instant it appears — you know exactly which op
  number broke it, not just "something's wrong at the end."

**Part 4 — the oracle property: pop order must match a sorted array, across 50 seeds.** The
invariant proves the *shape* is a valid heap; this proves the *behavior* is a valid
priority queue:

```ts
// features/routing/pqueue.test.ts:23-40  (annotated)
it("pops in non-decreasing priority order (oracle, many seeds)", () => {
  for (let seed = 1; seed <= 50; seed++) {          // 50 independent random trials
    const rand = lcg(seed);
    const pq = new PQueue<number>();
    for (let i = 0; i < 200; i++) pq.push(i, Math.floor(rand() * 1000));
    let prev = -Infinity;
    while (!pq.isEmpty()) {
      const before = pq.peekPriority()!;
      pq.pop();
      expect(before).toBeGreaterThanOrEqual(prev);  // LAW: each pop >= the last
      prev = before;
    }
  }
});
```

And `:42` makes the oracle explicit — it builds 300 random pairs, drains the queue, and
asserts the drained order `toEqual` a plain `[...pairs].sort()`. The `Array.prototype.sort`
*is* the oracle (same trick as `01-optimality-oracle.md`: a trusted simple implementation
stands in for the expected answer). The heap must produce what `sort` produces.

### Move 2 variant — the load-bearing skeleton

Strip a property test to its kernel:

1. **A law expressible as a boolean over any output** — `checkInvariant()`, or
   `each pop >= prev`. *Remove the law* (assert a specific value instead) and you're back to
   example testing, which can't cover the input space.
2. **A reproducible input generator** — the seeded LCG. *Remove the seed* (use
   `Math.random()`) and a failure is a ghost you can't reproduce; the test becomes flaky and
   gets ignored.
3. **Volume + per-step checking** — 2000 ops, asserted after each. *Remove the volume* and
   the random search doesn't cover enough states to find the bug; *check only at the end*
   and you lose the "which op broke it" diagnostic.

The part people forget is **the seed**. Engineers write property tests with `Math.random()`
all the time and create flaky tests that train the team to ignore red — the exact failure
mode `audit.md` lens 4 warns about. Seeding it is what makes the technique trustworthy
rather than corrosive.

**Skeleton vs hardening:** the kernel is law + seeded-generator + volume. The 50-seed sweep
and the duplicate-priority edge case (`:53`) are hardening — they widen coverage, but a
single seeded invariant loop is already a property test.

### Move 3 — the principle

**When the input space is too big to enumerate, stop asserting outputs and start asserting
laws.** A binary heap has astronomically many reachable states; you can't list them. But it
has *one* invariant, and that invariant is a single boolean you can check on every state a
fuzzer reaches. Property testing trades "I know this specific answer" for "I know this law
always holds" — and the second is both stronger and cheaper to maintain as the code evolves.
This is the same instinct as the optimality oracle (`01`): replace hand-typed expectations
with a relation that must hold.

---

## Primary diagram

```
  PROPERTY / INVARIANT TESTING — full recap

  ┌─ generator (pqueue.test.ts:5) ─────────────────────────────┐
  │  lcg(seed) → reproducible random stream                    │
  └────────────────────────────┬───────────────────────────────┘
                               │ drives the op mix
  ┌─ fuzz loop (pqueue.test.ts:67) ─────────────────────────────┐
  │  2000 × { 60% push(rand) | 40% pop() }                     │
  │              │ mutates                                      │
  │              ▼                                              │
  │  PQueue<T>  ──── heap array (pqueue.ts)                     │
  └──────────────┬──────────────────────────────────────────────┘
                 │ after EVERY op
                 ▼
  ┌─ the laws ──────────────────────────────────────────────────┐
  │  ① checkInvariant() == true   (parent.pri <= child.pri)     │
  │  ② each pop >= prev pop        (non-decreasing drain)        │
  │  ③ drained order == [...].sort()  (sorted-array oracle, ×50) │
  │      any violation → reproducible failure (re-run the seed)  │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the QuickCheck lineage (Haskell, 1999) — assert properties, generate inputs,
shrink failures. flattr does it by hand rather than with a library (`fast-check` would give
automatic shrinking), which fits the project's "hand-roll the fundamentals" ethic and is
fine at this scale. The piece it gives up by hand-rolling is *shrinking* — `fast-check`
would auto-minimize a 2000-op failure to the 3-op sequence that actually triggers it. With
the seeded LCG you can at least reproduce, then bisect manually.

Two flavors show up here, worth naming: an **invariant property** (a law about internal
state — the heap shape, `:67`) and a **model-based / oracle property** (the output matches a
simpler reference model — the sorted array, `:42`). Both are stronger than example tests;
the model-based one ties straight back to `01-optimality-oracle.md`.

Where to read next: `01-optimality-oracle.md` (the differential-testing sibling), and
`study-dsa-foundations` for the binary-heap invariant theory itself.

---

## Interview defense

**Q: "How do you test a hand-rolled binary heap?"**

> "Two example tests for the boundaries — empty pop returns undefined, duplicates allowed —
> and then property tests for the real coverage. I expose a `checkInvariant()` that verifies
> parent ≤ child across the whole backing array, then run 2000 random pushes and pops from a
> *seeded* LCG and assert the invariant after every operation. Separately I assert pop order
> is non-decreasing and matches a plain sorted array — `Array.sort` as the oracle. The seed
> is the load-bearing part: it makes a failure reproducible instead of a flaky ghost.
> `pqueue.test.ts:67`."

```
  sketch while you talk:

  seeded LCG ─► 2000 random push/pop ─► checkInvariant() after EACH
                                          │
                                          fail on seed 99 → re-run seed 99
                                          → identical trace (not flaky)
```

**Anchor:** *"Property tests assert a law, not a value — and the seed is what keeps them
from becoming flaky tests everyone learns to ignore."*

**Q: "Why not just `Math.random()`?"** Because a property test that fails one run in a
thousand and can't be reproduced is worse than no test — it trains the team to re-run until
green. Seeding turns randomness into reproducible coverage.

---

## See also

- `01-optimality-oracle.md` — the sorted-array oracle here is the same differential trick
- `03-injected-fetch-isolation.md` — the same determinism discipline, applied to the network
- `05-finite-blocked-sentinel-tests.md` — `pqueue.test.ts:101` checks BLOCKED sorts to the back
- `audit.md` lens 4 (determinism) and lens 3 (the `checkInvariant` test seam)
- sibling guide **`study-dsa-foundations`** — binary-heap invariant theory
