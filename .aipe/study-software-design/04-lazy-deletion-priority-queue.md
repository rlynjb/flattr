# Lazy-deletion priority queue
### Binary min-heap with stale-entry skipping / generic container — Industry standard, hand-rolled here

## Zoom out, then zoom in

The search loop needs "give me the cheapest frontier node" fast, over and over.
That's a priority queue. Here's where it sits and what it hides.

```
  Zoom out — where the priority queue lives

  ┌─ Engine layer (features/routing) ─────────────────────────────┐
  │  search() / bidirectional()                                   │
  │     open.push(node, priority)   open.pop()   open.isEmpty()   │
  │             │ tiny interface — 4 verbs                        │
  │             ▼                                                  │
  │  ★ pqueue.ts: PQueue<T> ★  hides: array, sift up/down, swap,  │ ← we are here
  │             the binary-heap parent/child index math            │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** You've built a `BinaryHeap` and a `PriorityQueue` from scratch
(it's in your reincodes repo). flattr's `PQueue<T>` is the same primitive, but
with one deliberate simplification: **no decrease-key**. Instead of updating a
node's priority in place when the search finds a cheaper path, it just pushes a
*duplicate* with the better priority and skips the stale copies on the way out.
The pattern is **lazy deletion**: don't pay to remove stale entries; pay a tiny
check to ignore them. The whole heap mechanism — the array, the sift loops, the
parent/child index arithmetic — is hidden behind four methods.

## Structure pass

**Layers.** The **interface layer** is `push` / `pop` / `isEmpty` / `peek`
(plus a test-only `checkInvariant`). The **mechanism layer** is the private
`siftUp` / `siftDown` / `swap` and the `heap` array. The interface is generic
(`<T>`) and knows *nothing* about graphs, grades, or A*.

**Axis — "who knows the heap is an array with index math?"**

```
  One question down the layers: "who knows it's a binary heap?"

  ┌──────────────────────────────────────┐
  │ search() (astar.ts)                  │  → NOTHING. push/pop/isEmpty.
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ PQueue public methods            │  → know "ordered by priority"
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ siftUp/siftDown/swap (private)│  → know parent=(i-1)>>1, the array
          └──────────────────────────────┘

  the index arithmetic is sealed at the bottom. nobody above sees it.
```

**Seam.** The public methods are the seam between "I need cheapest-first" and
"it's a binary heap in a flat array." The cost axis flips across it: above, the
caller assumes O(log n) without knowing why; below, the sift loops *are* the
O(log n). Swap the heap for a pairing heap or a bucket queue and the four
methods don't change — that's the substitution the seam buys.

## How it works

### Move 1 — the mental model

The shape is a binary tree packed into an array, where every parent is ≤ its
children, plus a rule for ignoring duplicates.

```
  Pattern — binary min-heap in an array + lazy deletion

  array:  [ 3, 5, 4, 8, 9, 7 ]      tree view:        3
  index:    0  1  2  3  4  5                         ╱ ╲
                                                    5   4
  parent(i) = (i-1) >> 1                           ╱╲   ╱
  children(i) = 2i+1, 2i+2                        8  9 7

  lazy deletion: pushing a better priority for X leaves the old X in
  the array. pop returns it later; the SEARCH loop's closed-set check
  throws the stale one away.
```

The heap doesn't *know* an entry is stale — staleness is a search concept. The
heap just stores `{item, priority}` pairs; the search loop decides which pops to
ignore. Clean division of labor.

### Move 2 — the walkthrough (load-bearing skeleton)

The kernel of a heap is: **an array + sift-up on insert + sift-down on remove +
the parent/child index rule.** Name each part by what breaks without it.

**`push` + `siftUp` — insert and bubble up.** Append at the end, then swap
upward while you're smaller than your parent.

```
  push(item, priority):
      if priority is NaN: throw          // poison value → fail loud (see below)
      heap.append({item, priority})
      siftUp(lastIndex)

  siftUp(i):
      while i > 0:
          parent = (i - 1) >> 1
          if heap[parent].priority <= heap[i].priority: break   // heap ok
          swap(i, parent); i = parent
```

What breaks without `siftUp`: the appended element sits at the bottom violating
the heap property, and `pop` returns the wrong minimum. The `>> 1` is integer
parent-index math — the load-bearing arithmetic.

**`pop` + `siftDown` — remove the min and sink the replacement.** Take the root
(the minimum), move the last element to the root, sink it down past its smaller
child.

```
  pop():
      if empty: return undefined
      top = heap[0]
      last = heap.removeLast()
      if heap not empty:
          heap[0] = last
          siftDown(0)
      return top.item

  siftDown(i):
      loop:
          smallest = i among {i, 2i+1, 2i+2} by priority
          if smallest == i: break          // both children ≥ me → done
          swap(i, smallest); i = smallest
```

What breaks without the "move last to root" step: a hole at the root and the
array no longer packs the tree. What breaks without `siftDown`: the moved
element (was a leaf, probably large) sits at the root claiming to be the
minimum.

**The `NaN` guard — the part people forget.** `push` throws on a `NaN` priority
(`pqueue.ts:24`). Why it's load-bearing: `NaN` compares `false` to *everything*,
so a single `NaN` priority silently corrupts every sift comparison and the heap
stops being a heap — with no error, just wrong pops. Catching it at push turns a
maddening silent-corruption bug into an immediate throw. This is "define the
error out by detecting it at the boundary."

**Lazy deletion — the design choice (optional hardening, omitted on purpose).**
A "complete" priority queue offers `decreaseKey` (your reincodes
`PriorityQueue` has `updatePriority` with a value→index lookup). flattr
*deliberately doesn't*. Instead the search pushes a duplicate
(`astar.ts:72`) and the loop skips stale pops with the closed-set check
(`astar.ts:51`). The trade: a few extra heap entries (more memory, more pops)
for a much simpler heap (no index map to maintain). For a graph this size, the
right call — and naming *why* it's omitted is the lesson.

```
  Comparison — decrease-key vs lazy deletion

  decrease-key (your reincodes PQ)     lazy deletion (flattr PQ)
  ┌─────────────────────────────┐      ┌──────────────────────────┐
  │ heap + value→index Map       │      │ heap only                │
  │ update in place, re-sift     │      │ push duplicate, skip      │
  │ exactly 1 entry per node     │      │   stale on pop            │
  │ more code, less memory       │      │ less code, more entries   │
  └─────────────────────────────┘      └──────────────────────────┘
```

### Move 3 — the principle

A container should expose *what it guarantees* (cheapest-first) and hide *how*
(array + sift + index math). And sometimes the deepest move is to *leave a
feature out*: lazy deletion is simpler than decrease-key, and the simplicity is
worth more than the memory it costs at this scale. Knowing which hardening to
skip is design judgment, not laziness.

## Primary diagram

The full container: tiny interface, hidden mechanism, generic over `T`.

```
  PQueue<T> — full picture (pqueue.ts)

  ┌─ public interface (the seam) ─────────────────────────────────┐
  │ push(item, priority)   pop(): T?   isEmpty()   peek()          │
  │ peekPriority()   checkInvariant() [test-only]                  │
  │ push throws on NaN priority ← poison guard                     │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼ private mechanism (hidden)
  ┌───────────────────────────────────────────────────────────────┐
  │ heap: Entry<T>[]   (Entry = {item, priority})                  │
  │ siftUp(i):   bubble toward root while < parent                 │
  │ siftDown(i): sink toward leaves while > smaller child          │
  │ swap(i,j)    parent=(i-1)>>1   children=2i+1,2i+2              │
  └───────────────────────────────────────────────────────────────┘
       used by search() + bidirectional(); lazy deletion handled
       by the CALLER's closed-set check, not by the heap.
```

## Implementation in codebase

**Use cases.** `search` holds one `PQueue<string>` of node ids ordered by
`f = g + heuristic` (`astar.ts:30,45,72`). `bidirectional` holds *two*
(`openF`, `openR`) for the forward and backward frontiers
(`bidirectional.ts:40–43`). Both rely on lazy deletion: neither ever updates a
priority in place; they push duplicates and skip stale pops with their closed
sets.

**The interface + the NaN guard — `features/routing/pqueue.ts:23–39`.**

```
  pqueue.ts  (lines 23–39)

  push(item, priority): void {
    if (Number.isNaN(priority)) throw new Error("PQueue: NaN priority forbidden");
    this.heap.push({ item, priority });   ← append at the end
    this.siftUp(this.heap.length - 1);    ← bubble up to restore heap property
  }                                          └─ guard: NaN would silently corrupt
  pop(): T | undefined {
    const n = this.heap.length;
    if (n === 0) return undefined;        ← empty → undefined, not a throw
    const top = this.heap[0];             ← the minimum (root)
    const last = this.heap.pop()!;
    if (n > 1) { this.heap[0] = last; this.siftDown(0); }  ← move last to root, sink
    return top.item;
  }
```

**The hidden mechanism — `features/routing/pqueue.ts:50–77`.**

```
  pqueue.ts  (lines 50–77, condensed)

  private siftUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;                       ← integer parent index
      if (this.heap[parent].priority <= this.heap[i].priority) break;
      this.swap(i, parent); i = parent;
    }
  }
  private siftDown(i) {
    for (;;) {
      const left = 2*i+1, right = 2*i+2;                 ← child indices
      let smallest = i;
      if (left  < n && heap[left].priority  < heap[smallest].priority) smallest = left;
      if (right < n && heap[right].priority < heap[smallest].priority) smallest = right;
      if (smallest === i) break;                         ← both children ≥ me → done
      this.swap(i, smallest); i = smallest;
    }
  }
       │
       └─ none of this index math escapes the class. search() never sees it.
          checkInvariant() (line 42) lets tests assert parent≤child without
          exposing the array — a test seam, not a public capability.
```

## Elaborate

This is a textbook **binary heap** (you've built it — `BinaryHeap.ts`,
`PriorityQueue.ts` in reincodes), here serving as A*'s open set. The design
interest isn't the heap — it's the *deliberate omission* of decrease-key in
favor of lazy deletion, and the `NaN` guard as boundary error-detection. The
`checkInvariant` method (`pqueue.ts:42`) is a nice secondary lesson: it exposes
*testability* without exposing the *array*, so tests can prove the heap property
without coupling to the representation.

Read next: `01-parametric-search-over-cost-fns.md` for how the search loop's
closed-set check completes the lazy-deletion design. For the heap as a reusable
data structure, see `.aipe/study-dsa-foundations/`.

## Interview defense

**Q: Your priority queue has no decrease-key. Isn't that incomplete?** It's
deliberate. A* with lazy deletion pushes a duplicate when a node's cost improves
and skips the stale pop via the closed set (`astar.ts:51`). That trades a little
memory and a few extra pops for dropping the entire value→index map that
decrease-key needs. At graph sizes this app routes over, simpler wins. If
profiling showed heap size dominating, I'd add the index map back.

```
  the lazy-deletion contract spans TWO modules
  ┌─ PQueue ──────────┐         ┌─ search() ─────────────────┐
  │ push duplicate OK  │  ───►   │ if closed.has(node): skip  │
  │ (no dedup inside)  │         │  ← throws away the stale   │
  └────────────────────┘         └────────────────────────────┘
  the heap can't dedup alone; the caller's closed set completes it.
```

**Q: What's the load-bearing part people forget?** The `NaN` priority guard
(`pqueue.ts:24`). `NaN` breaks every comparison silently, so without the guard a
single bad priority turns the heap into a non-heap with no error. Catching it at
push is the difference between a thrown exception and an afternoon of "why is my
route wrong sometimes."

**Anchor:** "Binary min-heap, hand-rolled, *no* decrease-key on purpose — lazy
deletion, completed by the search loop's closed-set check. Guards `NaN` at push."

## Validate

1. **Reconstruct:** write `siftUp` and `siftDown` from memory, including
   `parent = (i-1)>>1`. Check `pqueue.ts:50–71`.
2. **Explain:** why does `pop` move the *last* element to the root before sinking
   (`pqueue.ts:34–37`), instead of promoting a child?
3. **Apply:** trace `push 5, push 3, push 8, pop` — what's the array after each?
4. **Defend:** a teammate wants to add `decreaseKey`. Walk the two-module
   lazy-deletion contract (`pqueue.ts` + `astar.ts:51`) and say when the trade
   flips in favor of decrease-key.

## See also

- `01-parametric-search-over-cost-fns.md` — the search loop that completes lazy
  deletion.
- `audit.md` Lens 2 (deep module — no classitis), Lens 6 (NaN guard).
- `.aipe/study-dsa-foundations/` — the binary heap as a reusable structure.
