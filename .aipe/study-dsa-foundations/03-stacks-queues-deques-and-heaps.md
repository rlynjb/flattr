# Stacks, Queues, Deques & Heaps

**Industry names:** binary min-heap · priority queue · LIFO stack / FIFO
queue / deque · lazy-deletion heap. **Type:** Industry standard.

## Zoom out, then zoom in

The single most reused structure in flattr's router is the priority queue —
`PQueue` in `pqueue.ts`. It's the frontier of every search: Dijkstra, A*,
grade-A*, directed-A*, and both halves of bidirectional all pull "the
cheapest unexplored node next" out of it. It's a hand-rolled binary min-heap
on a flat array, and it's the structure you've already built twice in reincodes
(`BinaryHeap.ts`, `PriorityQueue.ts`). flattr's version drops `updatePriority`
and uses lazy deletion instead — that's the one interesting divergence.

```
  Zoom out — the PQueue is the frontier of every search

  ┌─ Algorithm layer ─────────────────────────────────────────┐
  │  search()        bidirectional()                          │
  │     │  open.pop() cheapest      openF / openR (two heaps)  │
  │     ▼                                                       │
  └─────┼──────────────────────────────────────────────────────┘
        │ push(item, priority) / pop()
  ┌─ Structure layer (pqueue.ts) ──▼──────────────────────────┐
  │  PQueue<T>  — binary min-heap on a flat array             │ ★
  │    heap: Entry<T>[]    siftUp / siftDown / swap           │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: a heap answers one question fast — "what's the minimum right now?" —
in `O(1)` to peek and `O(log n)` to remove. That's exactly what best-first
search needs on every iteration. The rest of this file is *how* the array
encodes a tree, and why flattr skips decrease-key.

## The structure pass

One structure, but trace the **ordering-discipline** axis to place it among its
cousins.

```
  Axis: what determines "what comes out next?"

  structure   next-out rule              flattr uses it?
  ─────────   ───────────────────────    ─────────────────────────
  stack       last in (LIFO)             implicitly: reconstruct() recursion-shaped
  queue       first in (FIFO)            BFS would; flattr's search is priority-based
  deque       either end                 not yet exercised
  heap / PQ   minimum priority           YES — the frontier (pqueue.ts)
```

**The seam:** the boundary between `PQueue<T>` and `search()`. The contract:
the heap promises "pop returns the minimum-priority item, always"
(`pqueue.ts`'s `checkInvariant` and oracle tests guarantee it). The search
promises "I'll hand you a non-NaN priority" (the heap enforces this at
`pqueue.ts:24`). Across that seam, the heap knows *nothing* about graphs,
grades, or costs — it's a generic `PQueue<T>` (`pqueue.ts:1` says so
explicitly). That's a clean seam: you could lift `PQueue` into any other
project unchanged.

## How it works

### Move 1 — the mental model

A binary heap is a **tree flattened into an array**. You never allocate tree
nodes or pointers — the array index *is* the tree position. Parent and children
are arithmetic: for index `i`, parent is `(i-1) >> 1`, children are `2i+1` and
`2i+2`. The "min-heap property" is the one invariant: every parent ≤ both its
children. That's it. Everything else is restoring that invariant after a
change.

```
  Array IS the tree — index arithmetic, no pointers

  array:  [ 3,  5,  4,  9,  8,  7 ]
            0   1   2   3   4   5

  tree:            3            ← heap[0], the min (peek)
                  / \
                 5   4          ← heap[1]=2·0+1,  heap[2]=2·0+2
                / \   \
               9   8   7        ← children of index 1 and 2

  parent(i) = (i−1) >> 1    left(i) = 2i+1    right(i) = 2i+2
  invariant: heap[parent] ≤ heap[child]   for all i
```

### Move 2 — the load-bearing skeleton

This concept has a kernel, so we run the skeleton variant. The irreducible
heap is: **an array + siftUp + siftDown + the parent≤child invariant.** Name
each part by what breaks without it.

#### push — siftUp restores the invariant upward

Bridge: you've written `heapifyUp` in `BinaryHeap.ts`. flattr's is
`siftUp`, `pqueue.ts:50-57`:

```ts
// pqueue.ts:23-27 + 50-57 — push then bubble up
push(item: T, priority: number): void {
  if (Number.isNaN(priority)) throw new Error("PQueue: NaN priority forbidden");
  this.heap.push({ item, priority });   // append at the end (a leaf)
  this.siftUp(this.heap.length - 1);    // bubble up to its sorted spot
}

private siftUp(i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (this.heap[parent].priority <= this.heap[i].priority) break;  // invariant holds, stop
    this.swap(i, parent);   // parent bigger → swap up
    i = parent;
  }
}
```

```
  Execution trace — push priority 2 into [3,5,4,9,8,7]

  step 0: append at index 6          [3,5,4,9,8,7, 2]
          parent(6) = (6−1)>>1 = 2   heap[2]=4 > 2 → swap
  step 1: i=2                        [3,5, 2,9,8,7, 4]
          parent(2) = 0              heap[0]=3 > 2 → swap
  step 2: i=0                        [2,5, 3,9,8,7, 4]
          i=0 → loop ends.  2 is the new min.
```

**What breaks without siftUp:** appending alone leaves the new item at a leaf
regardless of its priority — `peek()` would return a stale minimum and the
whole search would expand nodes in the wrong order. siftUp is what makes
`push` maintain the invariant.

#### pop — siftDown restores the invariant downward

`pop` is the clever one. You can't just remove `heap[0]` — that leaves a hole.
Instead: take the root (the answer), move the *last* element to the root, then
sink it. `pqueue.ts:29-39` and `59-71`:

```ts
// pqueue.ts:29-39 — pop the min, refill root from the tail, sink it
pop(): T | undefined {
  const n = this.heap.length;
  if (n === 0) return undefined;
  const top = this.heap[0];          // the answer (the min)
  const last = this.heap.pop()!;     // remove the tail
  if (n > 1) {
    this.heap[0] = last;             // tail becomes the new root
    this.siftDown(0);                // sink it to its sorted spot
  }
  return top.item;
}

// pqueue.ts:59-71 — pick the smaller child, swap down, repeat
private siftDown(i: number): void {
  const n = this.heap.length;
  for (;;) {
    const left = 2 * i + 1, right = 2 * i + 2;
    let smallest = i;
    if (left  < n && this.heap[left].priority  < this.heap[smallest].priority) smallest = left;
    if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
    if (smallest === i) break;       // both children ≥ self → done
    this.swap(i, smallest);
    i = smallest;
  }
}
```

```
  Execution trace — pop from [2,5,3,9,8,7]

  step 0: top = heap[0] = 2 (the answer)
          last = 7 (tail) → root          [7,5,3,9,8]
  step 1: i=0  left=5, right=3 → smallest=3 (index 2)
          swap                            [3,5,7,9,8]
  step 2: i=2  left=index5 (none), right(none) → smallest=2
          smallest===i → done.  return 2.
```

**What breaks without siftDown:** moving the tail to the root almost always
violates the invariant (the tail is a big leaf). siftDown sinks it past its
smaller children. Drop it and `peek` returns garbage after the first pop.

#### Lazy deletion — flattr's chosen substitute for decrease-key

This is the divergence from your reincodes `PriorityQueue.ts`. There you built
`updatePriority` with a value→index lookup — a *decrease-key* heap. flattr
deliberately does **not** do that. When a node's cost improves, the search just
pushes a *new* entry at the better priority (`astar.ts:72`) and leaves the
stale one in the heap. The stale duplicate gets skipped on pop.

```
  Lazy deletion — duplicates in the heap, skipped on pop

  node "A" pushed at priority 50  → heap has ("A", 50)
  later, cheaper path found       → push ("A", 30)
  heap now holds BOTH:              ("A",30) and ("A",50)

  pop → "A" at 30   → closed.add("A"), expand it   (astar.ts:61)
  pop → "A" at 50   → closed.has("A")? yes → skip  (astar.ts:51)
                       "stale duplicate (lazy deletion)"
```

The skip is one line, `astar.ts:51`:

```ts
if (closed.has(current)) continue; // stale duplicate (lazy deletion)
```

**The tradeoff, named:** lazy deletion makes the heap larger (bounded by total
pushes, not by V) and does redundant pops — but it keeps `PQueue` *generic*. A
decrease-key heap needs a `Map<item, index>` and has to update that index on
every swap, coupling the heap to its items. flattr chose the simpler, generic
heap and paid for it with some wasted pops. For a city-scale street graph
that's the right call — the constant factor is small and the heap stays
reusable. **You built the harder version in reincodes; flattr shows when the
simpler version wins.**

#### Optional hardening — the NaN guard and the invariant oracle

Two things on top of the kernel, neither required for correctness on
well-formed input:

- **NaN guard** (`pqueue.ts:24`): `if (Number.isNaN(priority)) throw`. A NaN
  priority would silently corrupt the heap — every comparison with NaN is
  `false`, so siftUp/siftDown would stop early and the invariant would rot
  with no error. Failing loud at push time turns a silent corruption into a
  stack trace. This guards against a real flattr bug class: a malformed
  `costFn` returning NaN.
- **`checkInvariant()`** (`pqueue.ts:42-48`): test-only, scans the array
  asserting `parent ≤ child` everywhere. The pqueue test
  (`pqueue.test.ts:67-78`) runs 2000 random pushes/pops and checks the
  invariant after each — a property test that the kernel never breaks.

### Move 3 — the principle

A heap is the canonical answer to "I need the minimum repeatedly, and the set
keeps changing." The array-as-tree trick is the part to internalize: no
pointers, just index arithmetic, `O(log n)` to maintain. The deeper lesson is
the lazy-deletion-vs-decrease-key fork — both are correct, and the choice is
about coupling. Lazy deletion keeps the structure generic at the cost of a
larger heap; decrease-key keeps the heap small at the cost of coupling it to an
index map. Knowing *both* and being able to say why you'd pick one is the
senior signal.

## Primary diagram

The PQueue in full: the array, the tree it encodes, the two sift operations,
and how the search drives it.

```
  PQueue — array-backed binary min-heap, lazy deletion

  search() ──push(node, f)──►┌─────────────────────────────┐
           ◄──pop() = min────│  heap: Entry<T>[]           │
                             │  [ {item, priority}, … ]    │
                             │                             │
                             │  push: append → siftUp ▲    │  O(log n)
                             │  pop:  root out, tail→root, │
                             │        siftDown ▼           │  O(log n)
                             │  peek: heap[0]              │  O(1)
                             │                             │
                             │  guards: NaN→throw (l.24)   │
                             │  oracle: checkInvariant     │
                             └─────────────────────────────┘
   lazy deletion: stale dups stay in heap, skipped via
                  closed.has(current) at astar.ts:51
```

## Elaborate

The binary heap is Williams' 1964 structure, the engine inside heapsort. The
priority-queue ADT it implements is what every shortest-path algorithm needs.
Fibonacci heaps (Fredman–Tarjan, 1984) give `O(1)` amortized decrease-key and
drop Dijkstra to `O(E + V log V)` — but their constant factors are bad enough
that in practice a binary heap with lazy deletion (exactly flattr's choice)
usually wins on real graphs. So flattr isn't cutting a corner; it's making the
choice production routers actually make. A `deque` (double-ended queue) is the
structure flattr *doesn't* use — it'd show up if there were a 0-1 BFS variant,
which there isn't (`not yet exercised`).

Read next: `01` (why the `O(log n)` matters to total runtime) and `05` (the
search that pops this heap on every iteration).

## Interview defense

**Q: Walk me through your priority queue. Why a binary heap?**

It's a min-heap on a flat array — the index *is* the tree position, parent is
`(i-1)>>1`, children `2i+1`/`2i+2` (`pqueue.ts:50-71`). Push appends and
siftUps; pop returns the root, moves the tail up, and siftDowns. Both
`O(log n)`, peek `O(1)`. A heap because best-first search needs the minimum
repeatedly from a changing set — a sorted array would be `O(n)` per insert.

```
  push: append → siftUp ▲     pop: root out → tail to root → siftDown ▼
  invariant: parent ≤ both children, everywhere
```

Anchor: "no pointers — the array index encodes the tree."

**Q: How do you handle a node whose cost improves? You don't have
decrease-key.**

Lazy deletion. I push a new entry at the better priority and leave the stale
one; when the stale one pops, `closed.has(current)` is already true so I skip it
(`astar.ts:51`). It keeps the heap generic — no `item→index` map coupling it to
its contents. The cost is a larger heap and some wasted pops, bounded by total
pushes. *I built the decrease-key version in my reincodes `PriorityQueue.ts`;
flattr is the case where the simpler one wins.*

```
  improve A's cost → push ("A",30) on top of ("A",50)
  pop 30 → expand & close A.   pop 50 → closed? skip.
```

Anchor: "lazy deletion trades heap size for not coupling the heap to its items
— the load-bearing skip is `closed.has(current)`."

## See also

- `02-arrays-strings-and-hash-maps.md` — the `closed` Set that powers the skip.
- `05-graphs-and-traversals.md` — the search that pops this heap every step.
- `01-complexity-and-cost-models.md` — the `O(log n)` in the total bound.
- `08-dsa-foundations-practice-map.md` — decrease-key as a ranked practice gap.
