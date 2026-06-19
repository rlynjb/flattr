# Stacks, queues, deques & heaps

**Industry names:** priority queue · binary heap (min-heap) · LIFO stack · FIFO
queue · double-ended queue (deque). **Type:** Industry standard. The repo
ships a hand-rolled lazy-deletion binary min-heap in `features/routing/pqueue.ts`.

---

## Zoom out, then zoom in

A\* always asks the same question: *of all the frontier nodes I could expand
next, which has the lowest f-score?* That "give me the minimum, repeatedly, while
I keep adding more" pattern is exactly what a priority queue is for. `flattr`'s
PQueue is the engine's heartbeat — every `push` and `pop` in the search is a heap
operation.

```
  Zoom out — the heap inside the search loop

  ┌─ Search layer (astar.ts:48-75) ───────────────────────────────┐
  │  while (!open.isEmpty()) {                                      │
  │     current = open.pop()    ← ★ pull lowest-f node              │
  │     ...relax neighbors...                                       │
  │     open.push(next, f)      ← ★ add discovered node             │
  │  }                                                              │
  └─────────────────────────┬──────────────────────────────────────┘
                            │ open IS a...
  ┌─ ★ THIS FILE ───────────▼──────────────────────────────────────┐
  │  PQueue<string>  — binary MIN-heap, array-backed, lazy deletion │
  │  features/routing/pqueue.ts                                     │
  │  push: siftUp O(log n) · pop: siftDown O(log n) · peek: O(1)    │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a binary heap is a complete binary tree flattened into an array, kept so
that **every parent is ≤ its children** (a min-heap). That single invariant is
what makes "find the minimum" `O(1)` and "remove it / add one" `O(log n)`. The
repo's twist is **lazy deletion**: instead of updating a node's priority in
place (decrease-key), it just pushes a fresh entry and ignores the stale one when
it surfaces.

---

## The structure pass

**Layers.** The ordering disciplines stack by *what they promise about pop
order*:

```
  One question — "what comes out next?" — across ordering disciplines

  ┌─────────────────────────────────────────────┐
  │ STACK (LIFO)   → most-recently pushed         │  (DFS uses this; not in repo's search)
  └────────────────────┬───────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ QUEUE (FIFO)   → earliest pushed          │  (BFS uses this; not exercised)
       └───────────────┬─────────────────────────┘
           ┌───────────▼───────────────────────┐
           │ PRIORITY QUEUE → lowest priority    │  ← ★ flattr's PQueue
           │   (a heap) regardless of insert order│     (Dijkstra/A* use this)
           └─────────────────────────────────────┘

  the answer to "what's next?" is the entire difference between these structures
```

**Axis = pop order / invariant.** Hold "what does pop return?" constant. Stack
says newest, queue says oldest, priority queue says *cheapest* — and the priority
queue is the only one whose pop order isn't insertion order, which is precisely
why it needs an internal invariant (the heap property) to maintain.

**Seam.** The load-bearing seam is between the *logical* tree and the *physical*
array. A heap is a tree you reason about (parent/child) but an array you store
(`pqueue.ts:5`). The index arithmetic `parent = (i-1)>>1`, `left = 2i+1`, `right
= 2i+2` (`pqueue.ts:52,62-63`) *is* that seam — it lets you navigate a tree with
zero pointers. Get the arithmetic wrong and the tree silently corrupts.

---

## How it works

### Move 1 — the mental model

You've used `Array.prototype.sort()` to get things in order. A heap is what you
reach for when you need *only the smallest, repeatedly, while the collection keeps
changing* — fully sorting after every insert would be `O(n log n)` each time; a
heap gives you the min in `O(1)` and maintains itself in `O(log n)` per change.

```
  A binary min-heap: complete tree (logical) → array (physical)

  logical tree:          array index:        invariant:
        1                [0]=1               parent ≤ both children
       / \               [1]=3  [2]=2        node i:
      3   2              [3]=7  [4]=5         parent = (i-1)>>1
     / \  / \            [5]=8  [6]=9         left   = 2i+1
    7  5 8  9            ────────────────     right  = 2i+2
                         1 3 2 7 5 8 9

  min is ALWAYS at index 0. no pointers — the array index IS the tree position.
```

### Move 2 variant — the load-bearing skeleton

The heap has an irreducible kernel. Strip it to the four parts that, if removed,
break it — then layer the hardening on top.

**1. The array + the heap invariant — the structure itself.**
`heap: Entry<T>[]` (`pqueue.ts:5`) with the rule `priority[parent] <=
priority[child]` for all nodes. *Remove the invariant* and `peek()` no longer
returns the minimum — index 0 is just whatever was inserted first. The invariant
is the entire reason the structure exists. The test `checkInvariant()`
(`pqueue.ts:42-48`) walks the array and asserts it; `pqueue.test.ts:67-78` checks
it holds after 2000 random ops.

**2. `siftUp` — restores the invariant after a push.**
A new item lands at the array's end (a leaf), then bubbles up while it's smaller
than its parent (`pqueue.ts:50-57`). *Remove siftUp* and a small item inserted
last stays at the bottom — `pop` returns the wrong element. It's `O(log n)`: a
complete tree of `n` nodes is `log n` levels deep, and you climb at most all of
them.

```
  siftUp: push("x", 0) into [1,3,2,...]  (pqueue.ts:50-57)

  step 0: x lands at end, index 6        [1,3,2,7,5,8, x=0]
  step 1: parent of 6 = (6-1)>>1 = 2     heap[2]=2 > 0 → swap
  step 2: x now at index 2               [1,3,0,7,5,8,2]
          parent of 2 = (2-1)>>1 = 0     heap[0]=1 > 0 → swap
  step 3: x now at index 0               [0,3,1,7,5,8,2]
          i==0 → stop. min restored.
```

**3. `siftDown` — restores the invariant after a pop.**
`pop` takes index 0 (the min), moves the *last* element into the hole, then
bubbles it down, always swapping with the *smaller* child (`pqueue.ts:59-71`).
*Remove siftDown* and after one pop the root is a leaf value that violates the
invariant everywhere below it. Choosing the smaller child (`pqueue.ts:65-66`) is
the part people get wrong — swap with the larger and you re-break the invariant
immediately.

```
  siftDown: pop() from [0,3,1,7,5,8,2]  (pqueue.ts:59-71)

  step 0: save top=0; move last (2) to root  [2,3,1,7,5,8]  (n now 6)
  step 1: i=0  left=1(=3) right=2(=1)         smaller child = right(1)
          heap[2]=1 < heap[0]=2 → swap        [1,3,2,7,5,8]
  step 2: i=2  left=5(=8) right=6(>n)         no smaller child → stop
          return 0. min restored at index 0.
```

**4. Empty-frontier termination.**
`isEmpty()` / `size` (`pqueue.ts:7-13`) and `pop` returning `undefined` on empty
(`pqueue.ts:30`). *Remove this* and the search's `while (!open.isEmpty())`
(`astar.ts:48`) never terminates — or worse, `pop()!` dereferences `undefined`.
This is the load-bearing part people forget: the heap doesn't just order things,
it *signals exhaustion*. An empty open list is how A\* concludes "no path exists"
(`astar.ts:77`).

**Now the hardening — what's NOT the kernel:**

- **Lazy deletion** (the repo's choice). When a node's best-known cost improves,
  the search *doesn't* find and update its heap entry. It just pushes a new entry
  at the better priority (`astar.ts:72`). The old, stale entry is still in the
  heap — but it'll be popped *after* the good one (lower priority pops first), and
  when it surfaces the search skips it because the node is already closed
  (`astar.ts:51`). This is hardening, not kernel: a plain heap is still a heap
  without it.

```
  Lazy deletion vs decrease-key — the tradeoff

  DECREASE-KEY (not used)          LAZY DELETION (pqueue.ts, used)
  ┌──────────────────────┐        ┌──────────────────────────────┐
  │ find node's entry     │        │ just push a 2nd entry         │
  │ O(n) without an index │        │ O(log n), no index needed     │
  │ update priority       │        │ skip stale at pop:            │
  │ siftUp/Down O(log n)  │        │   if closed.has(x) continue   │
  │ heap stays small      │        │   (astar.ts:51)               │
  └──────────────────────┘        └──────────────────────────────┘
   smaller heap, more code          bigger heap, dead-simple, correct
   → spec §14.3: "start lazy, upgrade only if profiling says"
```

- **`NaN` guard** (`pqueue.ts:24`). `push` throws on a NaN priority. Hardening: a
  NaN priority would make every comparison `false` and silently corrupt ordering.
  This catches the bug at the source. It's why `BLOCKED` is `1e9` not `Infinity`
  — `Infinity - Infinity = NaN` would trip this (see **01**).

### Move 2.5 — current state vs future state

The PQueue is fully shipped with lazy deletion. Decrease-key is the documented
*future* upgrade, gated on profiling.

```
  Phase A (now)                    Phase B (if profiling demands)
  ┌────────────────────────┐       ┌────────────────────────────────┐
  │ lazy deletion           │       │ decrease-key                    │
  │ stale entries tolerated │  ───► │ + value→index map (the bit Rein │
  │ pops > nodesExpanded     │       │   already built in reincodes:   │
  │ (the measured overhead) │       │   PriorityQueue.ts updatePriority)│
  └────────────────────────┘       └────────────────────────────────┘
  what DOESN'T change: siftUp/siftDown, the array backing, the invariant.
  only how staleness is handled. The kernel is stable.
```

You've built the decrease-key version already (`reincodes/PriorityQueue.ts`,
`updatePriority` + value→index lookup). `flattr` deliberately chose the *simpler*
lazy version — that's the spec's advice and the right call until the bench
(`types.ts:49` `pops`) shows the staleness overhead actually hurts.

### Move 3 — the principle

**A heap trades full ordering for repeated-minimum-access.** You never need the
2nd-smallest until you've taken the smallest, so don't pay to sort everything.
The lazy-deletion variant generalizes further: *tolerate stale state and validate
at consumption time* rather than maintaining perfect state continuously — cheaper
to write, often cheaper to run, correct as long as the consumer checks.

---

## Primary diagram

The whole PQueue: array backing, the two sift operations, and the lazy-deletion
seam with the search.

```
  PQueue (pqueue.ts) and its seam with the search

  ┌─ PQueue<T> — array-backed binary min-heap ────────────────────┐
  │  heap: Entry<T>[]   Entry = {item, priority}                   │
  │                                                                │
  │  push(item, p) ──► append at end ──► siftUp  O(log n)          │
  │                    (pqueue.ts:23-27)  (50-57)                  │
  │  pop()        ──► take heap[0] ──► move last to root           │
  │                   ──► siftDown  O(log n)  (pqueue.ts:29-39,59) │
  │  peek/peekPriority ──► heap[0]  O(1)  (pqueue.ts:15-21)        │
  │  invariant: parent ≤ children (checkInvariant, 42-48)          │
  └─────────────────────────┬──────────────────────────────────────┘
        push(next, f)        │  pop() → current      ▲ lazy-delete seam
  ┌─ Search loop ────────────▼───────────────────────┴────────────┐
  │  open.push(next, tentative + h)   (astar.ts:72)                │
  │  current = open.pop()             (astar.ts:49)                │
  │  if (closed.has(current)) continue ← skip STALE  (astar.ts:51) │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The PQueue is the open/frontier list for every search stage
(`astar.ts:30`) and *two* frontiers for bidirectional (`bidirectional.ts:40-41`).
Nothing else in the repo uses a stack or queue directly — DFS/BFS aren't
exercised (see **05**), so the priority-queue discipline is the only ordering
discipline the repo ships.

```
  features/routing/pqueue.ts  (lines 50-57)  — siftUp

  private siftUp(i: number): void {
    while (i > 0) {                              ← stop at the root
      const parent = (i - 1) >> 1;               ← integer parent index
      if (this.heap[parent].priority <= this.heap[i].priority) break;
                                                 ← invariant already holds → done
      this.swap(i, parent);                      ← else bubble up
      i = parent;
    }
  }
       │
       └─ the `<=` (not `<`) is deliberate: equal priorities don't swap, which
          keeps push O(log n) tight and is why duplicate priorities are stable
          (pqueue.test.ts:53-65). The (i-1)>>1 is floor-divide-by-2 — the array
          encoding of "go to my parent" with no pointer.
```

```
  features/routing/pqueue.ts  (lines 59-71)  — siftDown (smaller-child rule)

  let smallest = i;
  if (left  < n && heap[left].priority  < heap[smallest].priority) smallest = left;
  if (right < n && heap[right].priority < heap[smallest].priority) smallest = right;
  if (smallest === i) break;                     ← both children ≥ me → done
  this.swap(i, smallest);                        ← swap with the SMALLER child
       │
       └─ swapping with the smaller child is load-bearing: swap with the larger
          and the larger child becomes a parent of the smaller one — invariant
          re-broken. The `left < n` / `right < n` guards are how a leaf (no
          children) terminates the descent.
```

---

## Elaborate

The binary heap is Williams' 1964 invention, created *for* heapsort, and it's the
canonical priority-queue implementation because the complete-tree-as-array
encoding needs zero extra memory for pointers. Dijkstra's algorithm (1959)
predates it and originally used a linear scan for the minimum (`O(V²)`); pairing
it with a heap is what gives the `O((V+E) log V)` bound in **01**. Fancier heaps
exist — binary → d-ary → Fibonacci → pairing — each shaving the decrease-key cost,
but the spec correctly says don't reach for them until profiling demands it.
You've already built both the heap (`reincodes/BinaryHeap.ts`,
`heapifyUp`/`heapifyDown`) and the decrease-key priority queue
(`reincodes/PriorityQueue.ts`); this repo is the *applied* version where the heap
drives a real shortest-path search. Next read: **05**, where every push and pop
here becomes a node expansion.

---

## Interview defense

**Q: "Walk me through pop on a binary heap."**

Take the root (the min). Move the last element into the root's slot. Sift it down,
always swapping with the smaller child, until both children are ≥ it or it's a
leaf. `O(log n)` because the tree is `log n` deep.

```
  pop:  root=min ──► last→root ──► siftDown(smaller child) ──► O(log n)
  the trap: swap with the SMALLER child, not just any child (pqueue.ts:65-66)
  anchor: pqueue.ts:29-39 (pop) + 59-71 (siftDown)
```

**Q: "Decrease-key or lazy deletion — which did you build and why?"**

Lazy deletion. Decrease-key needs a value→index map to find the entry, adds code,
and the spec says start simple and upgrade only if profiling says. With lazy
deletion I push a fresh, better-priority entry and skip the stale one at pop
because the node's already closed (`astar.ts:51`). The cost is a bigger heap and
`pops > nodesExpanded` — which the bench measures (`types.ts:49`).

**Q: "What part of the heap do people forget?"**

Empty-frontier termination. The heap signals exhaustion (`isEmpty`, `pop →
undefined`), and that's how A\* concludes "no path" (`astar.ts:48,77`). It's not
just an ordering structure — it's the loop's stop condition.

---

## Validate

1. **Reconstruct:** From memory, write the parent/left/right index arithmetic and
   the heap invariant. Check against `pqueue.ts:52,62-63,45`.
2. **Explain:** Why does `siftDown` swap with the *smaller* child specifically
   (`pqueue.ts:65-66`)? What breaks with the larger?
3. **Apply:** The search relaxes a node already in `open` to a lower cost
   (`astar.ts:69-72`). Trace what the lazy-deletion heap does and how the stale
   entry is later ignored (`astar.ts:51`).
4. **Defend:** Argue the lazy-deletion-vs-decrease-key choice using the `pops`
   metric (`types.ts:49`) and spec §14.3 as evidence.

---

## See also

- **05-graphs-and-traversals.md** — where push/pop become node expansions.
- **01-complexity-and-cost-models.md** — derivation of the `O(log n)` heap cost.
- **02-arrays-strings-and-hash-maps.md** — the array backing and the `closed` Set.
- `.aipe/study-performance-engineering/` — the `pops` overhead the bench records.
