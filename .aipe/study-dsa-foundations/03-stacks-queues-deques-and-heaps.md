# Stacks, Queues, Deques & Heaps

**Industry names:** binary heap, min-heap, priority queue, array-backed
heap. **Type:** Industry standard.

---

## Zoom out — where this concept lives

The priority queue is the beating heart of A*. It answers one question on
every loop iteration: "of all the frontier nodes I could expand next,
which has the lowest f-score?" Get a fast answer and the search is
`O(E log V)`; get a slow one and it's `O(V²)`. flattr hand-rolls it in
`pqueue.ts` — no library — because that's the point of the project.

```
  Zoom out — the PQueue as the search frontier

  ┌─ Search engine (astar.ts) ──────────────────────────────────┐
  │                                                              │
  │  ★ open: PQueue<string>  ◄── the frontier ★                │ ← we are here
  │       │                                                      │
  │       │  push(node, f)   ──► O(log n)                       │
  │       │  pop()           ──► O(log n), returns min-f node   │
  │       ▼                                                      │
  │  g / came / closed  (the hash bookkeeping, file 02)         │
  │       │                                                      │
  │  adjacency / byId   (the graph, file 02)                    │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** A binary min-heap implemented as a flat array, with
`siftUp`/`siftDown`, lazy deletion (no decrease-key), a NaN guard, and a
test-only invariant check. This file builds it from the array up — the
same heap you wrote in reincodes (`BinaryHeap.ts`), now as flattr's
frontier.

---

## Structure pass — one axis across the ordering disciplines

Stacks, queues, and heaps are all "what comes out next?" disciplines. The
axis is **ordering policy** — and only one of them is in flattr's hot path.

```
  Axis: "what determines what comes out next?"

  stack  (LIFO)  → most recently pushed     not used in flattr's search
  queue  (FIFO)  → oldest pushed            would give plain BFS
  deque  (both)  → either end               not used
  heap   (by key)→ lowest priority          ★ astar.ts open ★ — A*'s order
```

The seam: **swap the ordering discipline and you swap the algorithm.** A
FIFO queue gives BFS (unweighted shortest path). A priority queue keyed on
cost gives Dijkstra. The same queue keyed on cost+heuristic gives A*.
flattr picks the heap because its costs are weighted (grade penalties), so
FIFO order would be wrong. That one choice is the difference between "BFS
that ignores hills" and "A* that routes around them."

---

## How it works

### Move 1 — the mental model

You know `Array.sort()` keeps everything ordered, but re-sorting on every
insert is `O(n log n)` each time. A heap is the lazy version: it keeps
*just enough* order that the minimum is always at the front, and fixing
the order after an insert or removal costs only `O(log n)` — one walk up
or down the tree.

```
  Binary min-heap — a tree packed into an array

  array:   [10, 14, 12, 21, 18, 20, 35]
  index:     0   1   2   3   4   5   6

  as a tree:            10            ← index 0 = the min (always)
                       /  \
                     14    12         ← children of i: 2i+1, 2i+2
                    /  \   /  \
                  21  18  20  35      ← parent of i: (i-1)>>1

  heap property: parent.priority <= both children's priority
```

The whole trick is that **the tree is virtual** — there's no node objects,
no pointers. A node at index `i` finds its children at `2i+1` and `2i+2`
and its parent at `(i-1)>>1`. That's why it's just an array.

### Move 2 — the heap operations, one at a time

#### `push` — add to the end, then sift up

You append to the array (keeping it a complete tree) and bubble the new
element up until the heap property holds.

```ts
// features/routing/pqueue.ts:23-27
push(item: T, priority: number): void {
  if (Number.isNaN(priority)) throw new Error("PQueue: NaN priority forbidden");
  this.heap.push({ item, priority });
  this.siftUp(this.heap.length - 1);
}
```

```ts
// features/routing/pqueue.ts:50-57
private siftUp(i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;            // integer divide by 2
    if (this.heap[parent].priority <= this.heap[i].priority) break; // ordered, stop
    this.swap(i, parent);                   // smaller than parent → climb
    i = parent;
  }
}
```

Execution trace — push priority `8` into `[10,14,12,21,18]`:

```
  siftUp trace — pushing 8

  step 0:  append at i=5    [10,14,12,21,18, 8]
           parent(5)=(5-1)>>1=2 → heap[2]=12;  12 > 8 → swap
  step 1:  i=2              [10,14, 8,21,18,12]
           parent(2)=(2-1)>>1=0 → heap[0]=10;  10 > 8 → swap
  step 2:  i=0              [ 8,14,10,21,18,12]
           i==0 → stop.  8 is the new min at the root.
```

**The NaN guard is load-bearing.** `Number.isNaN(priority)` throws on
push. Why? Every comparison with `NaN` is `false`, so a `NaN` priority
would silently corrupt the heap order — it'd never be "less than" or
"greater than" anything, and the invariant would break invisibly. In
flattr, a `NaN` cost would come from a divide-by-zero in a grade
calculation. The guard turns a silent corruption into a loud throw.

#### `pop` — take the root, move the last up, sift down

You remove index 0 (the min), move the *last* element into its place to
keep the tree complete, then bubble it down.

```ts
// features/routing/pqueue.ts:29-39
pop(): T | undefined {
  const n = this.heap.length;
  if (n === 0) return undefined;
  const top = this.heap[0];
  const last = this.heap.pop()!;     // remove last element
  if (n > 1) {
    this.heap[0] = last;             // move it to the root
    this.siftDown(0);                // restore order downward
  }
  return top.item;
}
```

```ts
// features/routing/pqueue.ts:59-71
private siftDown(i: number): void {
  const n = this.heap.length;
  for (;;) {
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    let smallest = i;
    if (left  < n && this.heap[left].priority  < this.heap[smallest].priority) smallest = left;
    if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
    if (smallest === i) break;       // already smallest → stop
    this.swap(i, smallest);          // sink toward the smaller child
    i = smallest;
  }
}
```

Execution trace — pop from `[8,14,10,21,18,12]`:

```
  siftDown trace — popping the min (8)

  step 0:  top=8.  move last (12) to root, drop it from end
           [12,14,10,21,18]
           children of 0: left=14, right=10 → smallest=10 (right) → swap
  step 1:  i=2  [10,14,12,21,18]
           children of 2: left(5),right(6) out of range → smallest=i → stop
  result:  return 8;  heap=[10,14,12,21,18], 10 is the new min.
```

#### Lazy deletion — why there's no decrease-key

Here's flattr's most important design choice for the heap. Textbook A*
calls *decrease-key* when it finds a cheaper path to a node already in the
heap: find that node, lower its priority, re-sift. That requires tracking
each item's position in the array — extra bookkeeping.

flattr doesn't. It just **pushes a second copy** with the lower priority
and lets the stale copy linger.

```
  Lazy deletion vs decrease-key

  ┌─ decrease-key (NOT used) ──────┐  ┌─ lazy deletion (pqueue.ts) ────┐
  │ node X in heap at priority 9   │  │ node X in heap at priority 9   │
  │ found cheaper path, cost 5     │  │ found cheaper path, cost 5     │
  │ → locate X, set to 5, re-sift  │  │ → just push (X, 5). Two copies │
  │ needs item→index lookup        │  │   now: (X,5) and (X,9)         │
  │ heap stays minimal             │  │ (X,5) pops first; (X,9) later  │
  └────────────────────────────────┘  │   → closed.has(X) is true →    │
                                       │   continue (skip stale copy)   │
                                       └────────────────────────────────┘
```

The skip is in `astar.ts:51`: `if (closed.has(current)) continue;`. When
the stale `(X,9)` finally pops, X is already in `closed`, so the search
skips it. The heap holds garbage; the closed-set filters it on the way
out. This is the **lazy-deletion / closed-set partnership** — neither
works alone:

- **Drop the closed-set skip:** stale copies get re-expanded, work is
  duplicated, and on a cyclic graph it may not terminate cleanly.
- **Drop lazy deletion (require decrease-key instead):** you'd need the
  `updatePriority` / value→index map you built in reincodes
  (`PriorityQueue.ts`). flattr trades a little wasted heap space for a
  much simpler queue.

The cost is real and measured: `SearchResult.pops` counts *stale* pops
too (`types.ts:50` — "incl. stale"), and the `pqueue.test.ts` oracle
(lines 23-51) explicitly allows duplicate items.

#### The invariant check — testing a structure you can't see

Because the tree is virtual, you can't eyeball whether it's correct. So
the heap exposes a test-only invariant checker.

```ts
// features/routing/pqueue.ts:42-48
checkInvariant(): boolean {
  for (let i = 1; i < this.heap.length; i++) {
    const parent = (i - 1) >> 1;
    if (this.heap[parent].priority > this.heap[i].priority) return false;
  }
  return true;
}
```

The test runs 2000 random push/pop steps and asserts `checkInvariant()`
after each (`pqueue.test.ts:67-78`), plus an oracle that compares pop
order against a plain sorted array over 50 seeds (`pqueue.test.ts:23-51`).
That's how you trust a hand-rolled heap: prove it pops in sorted order and
never violates the parent-child rule. (Sibling **testing** guide owns the
oracle pattern.)

### Move 3 — the principle

A priority queue is a stack/queue with the FIFO/LIFO rule replaced by
"lowest key first," and a binary heap is the cheapest way to maintain that
rule: `O(log n)` per op, `O(1)` to peek the min, all in a flat array with
no pointers. flattr's choice to skip decrease-key in favor of lazy
deletion + a closed-set is the kind of pragmatic trade that's invisible
until you ask "why are there duplicate entries in the heap?" — the answer
is "because deleting them eagerly costs more than skipping them lazily."

---

## Primary diagram

The full heap: array layout, the two sift operations, and the
lazy-deletion partnership with the closed set.

```
  PQueue + lazy deletion — the complete frontier mechanism

  ┌─ pqueue.ts (the heap) ──────────────────────────────────────┐
  │  heap: Entry[]  = array-packed binary tree                  │
  │                                                             │
  │  push(item, p):  append → siftUp     O(log n)  [NaN guard] │
  │  pop():          root  → move last up → siftDown  O(log n) │
  │  peek():         heap[0].item        O(1)                  │
  │                                                             │
  │  parent(i)=(i-1)>>1   left(i)=2i+1   right(i)=2i+2         │
  └───────────────────────────┬──────────────────────────────────┘
                              │  used by astar.ts as `open`
  ┌─ lazy deletion partnership (astar.ts) ──────────────────────┐
  │  cheaper path found → push duplicate (no decrease-key)      │
  │  pop returns stale copy → closed.has(current) → continue   │
  │  pops metric counts stale pops (types.ts:50)               │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The binary heap is Williams' (1964), invented for heapsort. The
array-as-tree packing is the elegant part: a *complete* binary tree has
no gaps, so it maps perfectly onto a contiguous array with arithmetic
index math — no pointers, great cache behavior. Fibonacci heaps give
`O(1)` amortized decrease-key (better asymptotic A*), but their constant
factors are bad enough that production routers use binary heaps with lazy
deletion — exactly flattr's choice. You've built both halves in reincodes:
`BinaryHeap.ts` (the heap) and `PriorityQueue.ts` with `updatePriority`
(the decrease-key version flattr chose *not* to use). flattr is the lazy
branch of that fork. Read file 04 for the tree view, file 05 for the
search that drives it.

---

## Interview defense

**Q: Why no decrease-key? Isn't that the textbook A*?**

```
  decrease-key: O(log n) but needs item→index map
  lazy deletion: push dup O(log n), skip stale on pop via closed-set
  cost: heap holds stale entries; pops metric counts them
```

*Model answer:* "Decrease-key needs to find a node already in the heap and
re-sift it, which means maintaining a value→index map — the
`updatePriority` machinery. flattr skips it: when it finds a cheaper path,
it just pushes a duplicate and lets the stale copy sit. The closed-set
check at the top of the loop (`if closed.has(current) continue`) discards
stale copies when they pop. It trades a little wasted heap space for a
much simpler queue. The `pops` metric counts the stale pops so the cost is
visible."

*Anchor:* lazy deletion + closed-set is the load-bearing pair; neither
works without the other.

**Q: Why guard against NaN priorities?**

*Model answer:* "Every comparison with `NaN` is `false`, so a `NaN`
priority never satisfies `<` or `<=` — the heap would silently stop
ordering correctly and `checkInvariant` would still pass on the entries
around it. A `NaN` cost would come from a divide-by-zero in a grade calc.
The guard at `push` turns a silent corruption into a loud throw at the
exact point of insertion."

*Anchor:* `pqueue.ts:24` — fail loud at the boundary, not silently later.

---

## See also

- `02-arrays-strings-and-hash-maps.md` — the `closed` set that makes lazy
  deletion work.
- `04-trees-tries-and-balanced-indexes.md` — the heap viewed as a tree.
- `05-graphs-and-traversals.md` — the search that pushes/pops this heap.
- `01-complexity-and-cost-models.md` — the amortized `O(log n)` analysis.
