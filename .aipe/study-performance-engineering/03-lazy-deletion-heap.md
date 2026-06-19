# Lazy-deletion heap — skipping stale entries instead of decrease-key

**Industry name:** lazy deletion / lazy decrease-key in a binary min-heap.
**Type:** Industry standard (the technique) implemented from scratch.

---

## Zoom out, then zoom in

A* needs to pop the lowest-`f` node next, over and over. That's a priority queue,
and the textbook A* uses a *decrease-key* operation: when you find a cheaper path
to a node already in the queue, you lower its priority in place. Decrease-key
needs the heap to track *where each item lives* in its array — a value→index map
you maintain on every swap. That bookkeeping is real code and real per-operation
cost. This repo skips it entirely with one trick: **push a duplicate with the
better priority, and ignore the stale copy when it pops.**

Here's where the heap sits — it's the open set every search pops from.

```
  Zoom out — the priority queue under the search

  ┌─ features/routing/search() ───────────────────────────────────┐
  │  open.push(node, f)        open.pop() → lowest f                │
  │  if (closed.has(current)) continue;  ← the stale-skip lives here│
  └───────────────────────────────┬───────────────────────────────┘
                                   │  backed by
  ┌─ features/routing/pqueue.ts ───▼───────────────────────────────┐
  │  ★ PQueue<T> — plain binary min-heap, NO decrease-key ★         │ ← here
  │  push → siftUp        pop → siftDown                            │
  └─────────────────────────────────────────────────────────────────┘
```

The pattern: **lazy deletion** — never update or remove an entry in place; let
obsolete entries sit in the heap and discard them when they surface. The heap
stays dumb (it knows nothing about graphs or grades), and the *caller* owns
staleness via the closed set.

## Structure pass

Trace the **cost axis** — "what does an improved path cost the data structure?" —
across the decrease-key-vs-lazy boundary.

```
  One question across two designs: "cost of finding a cheaper path to a node?"

  ┌─ textbook A* (decrease-key heap) ─────────────────┐
  │ find item in heap (needs index map) → lower key →  │  → O(log n) + index
  │ siftUp → update index map on every swap            │    bookkeeping EVERYWHERE
  └────────────────────────────────────────────────────┘
                          ║  the cost model FLIPS here
  ┌─ this repo (lazy-deletion heap) ──────────────────┐
  │ just push a NEW entry with the better key →        │  → O(log n) push,
  │ siftUp. Old entry stays; skipped on pop.           │    zero index bookkeeping
  └────────────────────────────────────────────────────┘
```

**Axis = cost (work per improved path).** The seam is the choice between
decrease-key and lazy push. Across it, the cost model flips: decrease-key pays in
*permanent bookkeeping* (an index map kept correct on every swap, forever);
lazy deletion pays in *extra heap entries* (a few more pushes, plus the skip
check on pop). The trade: heap can grow larger than the node count, but stays a
plain array with no auxiliary structure.

**The load-bearing seam is split across two files** — and that's the subtle part.
The heap (`pqueue.ts`) has no concept of "stale." Staleness is detected by the
*caller* (`astar.ts`) via the closed set. Neither file alone implements lazy
deletion; the contract lives in the boundary between them.

## How it works

### Move 1 — the mental model

You know how you might append to an array and dedup later instead of searching for
and updating an existing element? This is that, for a heap. When A* finds a better
route to a node, it doesn't hunt down the old queue entry and edit it — it just
pushes a fresh entry with the lower priority. Now the node is in the heap twice.
The better one is closer to the top (lower priority), so it pops first; when the
worse duplicate eventually surfaces, the node's already finalized, and you throw
the duplicate away.

The shape — duplicates coexist, best-first pop, stale-skip:

```
  Lazy deletion — the same node, twice, best one wins

  heap (min by priority):
        (X, f=12)   ← better entry, near top
          /   \
   (X, f=20)  (Y, f=15)   ← stale entry for X still lurking

  pop → X (f=12)  → finalize X, add to closed
  ...
  pop → X (f=20)  → closed.has(X)? YES → skip (this is the lazy deletion)
```

### Move 2 — the load-bearing skeleton

The kernel is a binary min-heap plus a caller-side skip. Strip any part and
either correctness or the optimization breaks.

#### Part 1 — the array-backed binary heap (siftUp / siftDown)

The heap is a flat array where parent of `i` is `(i-1) >> 1` and children are
`2i+1`, `2i+2`. `push` appends then `siftUp` (bubble toward root while smaller
than parent); `pop` takes the root, moves the last element to the top, then
`siftDown` (sink while larger than a child). This is the same `BinaryHeap` you've
implemented from scratch. **Drop siftUp/siftDown and it's just an unordered array
— pop is O(n) instead of O(log n).**

```
  Heap as array — index arithmetic, no pointers

  index:   0    1    2    3    4    5    6
  value:  12   20   15   25   30   18   22
            \  / \   / \  /
  parent(i) = (i-1)>>1   children(i) = 2i+1, 2i+2

  push: append at end → siftUp     pop: take [0], move last→0 → siftDown
```

#### Part 2 — the no-decrease-key decision

The heap deliberately has **no `decreaseKey` and no value→index map.** Look at the
API: `push`, `pop`, `peek`, `isEmpty` — that's it. There's no way to find or
update an existing item. **This is the whole point:** by refusing decrease-key,
the heap needs no index bookkeeping, so `swap` just exchanges two array slots and
moves on. The cost of that refusal is paid elsewhere (Part 3).

#### Part 3 — the caller's closed-set skip (where staleness is resolved)

Because improved paths create duplicates, the search must ignore obsolete pops.
The instant a node is popped and finalized, it goes in the `closed` set. Every pop
first checks `closed.has(current)` — if true, it's a stale duplicate, skip it.
**Drop this skip and A* re-expands finalized nodes**: it would reprocess them,
inflating `nodesExpanded`, and (without consistency guarantees) could do real
wasted work. This is also why `pops` always exceeds `nodesExpanded` in the bench —
the gap is exactly the stale duplicates skipped.

```
  The two-file contract — heap dumb, caller owns staleness

  ┌─ pqueue.ts (dumb heap) ─┐   pop()   ┌─ astar.ts (owns closed set) ──┐
  │ returns lowest-priority │ ────────► │ pops++                        │
  │ item; knows nothing of  │           │ if closed.has(item): continue │ ← skip stale
  │ "stale"                 │           │ else: closed.add; expand      │
  └─────────────────────────┘           └────────────────────────────────┘
```

#### Part 4 — the NaN guard (a small correctness rail)

`push` throws on a NaN priority. With grade penalties feeding `f`, a NaN priority
would silently corrupt the heap order (NaN comparisons are always false), so a
node could get stuck or pop out of order. **Drop the guard and a single bad cost
value poisons the whole queue silently.** It's hardening, not skeleton — but it's
the kind of rail that turns a baffling "route is wrong sometimes" bug into a loud,
immediate throw.

#### Execution trace — a duplicate being skipped

```
  Trace — node X improved, then its stale copy surfaces

  step  action                         heap (by priority)        closed
  ────  ─────────────────────────────  ────────────────────────  ───────
   1    push X f=20                     [X:20]                    {}
   2    relax: found X via cheaper path
        push X f=12 (NO decrease-key)   [X:12, X:20]              {}
   3    pop → X:12; fresh               [X:20]                    {X}   ← expand
   4    pop → X:20; closed.has(X)=true  []                        {X}   ← SKIP (lazy)
        (pops=4, nodesExpanded counts X once)
```

### Move 3 — the principle

The general lesson: **when in-place update is expensive, prefer append-and-dedup
over find-and-modify — push the cost to read time where you can drop obsolete
work cheaply.** It's the same instinct as an append-only log compacted on read, or
event sourcing, or React keeping stale renders and reconciling. The heap stays
simple and fast; the caller absorbs a cheap O(1) skip per stale pop. The cost you
accept is a heap that can hold more entries than there are nodes — and on these
graph sizes, that's free.

## Primary diagram

The full picture — dumb heap, caller-owned staleness, the trade made explicit.

```
  Lazy-deletion heap, end to end

  ┌─ features/routing/astar.ts (caller owns staleness) ────────────┐
  │  relax neighbor → tentative < g[next]? → open.push(next, f)     │
  │      (improved path = NEW entry, never an in-place edit)        │
  │  loop: current = open.pop(); pops++                             │
  │        if closed.has(current) continue;   ← LAZY DELETION skip  │
  │        closed.add(current); nodesExpanded++                     │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  push / pop only
  ┌─ features/routing/pqueue.ts (dumb binary min-heap) ────────────┐
  │  heap: Entry<T>[]   parent=(i-1)>>1   children=2i+1,2i+2        │
  │  push → append → siftUp      pop → root, last→top → siftDown    │
  │  NO decreaseKey · NO index map · push throws on NaN priority    │
  └─────────────────────────────────────────────────────────────────┘

  trade: heap may hold duplicates (more pushes) ↔ zero index bookkeeping
```

## Implementation in codebase

**Use cases in this repo.** The open set for *every* search:
`search()` (`astar.ts`) and `bidirectional()` (both directions,
`bidirectional.ts:40-41`) all back their frontier with `PQueue`. There is no other
priority queue in the codebase — this one heap serves all five algorithm stages.

**The heap refuses decrease-key by omission** (`features/routing/pqueue.ts`):

```
  features/routing/pqueue.ts  (lines 4-39)

  export class PQueue<T> {
    private heap: Entry<T>[] = [];          ← flat array, the only state. No index map.

    push(item, priority): void {
      if (Number.isNaN(priority))
        throw new Error("PQueue: NaN priority forbidden");  ← Part 4 rail
      this.heap.push({ item, priority });   ← append (duplicates allowed!)
      this.siftUp(this.heap.length - 1);    ← O(log n) bubble up
    }

    pop(): T | undefined {
      const top = this.heap[0];             ← the minimum
      const last = this.heap.pop()!;
      if (n > 1) { this.heap[0] = last; this.siftDown(0); }  ← restore heap order
      return top.item;
    }
       │
       └─ NO `decreaseKey`, NO value→index Map. The API is push/pop/peek only.
          That absence IS the design: it's why `swap` (lines 73-77) is a bare
          3-line array swap with no bookkeeping to keep in sync.
  }
```

**The caller owns staleness — the other half of the contract**
(`features/routing/astar.ts`):

```
  features/routing/astar.ts  (lines 48-51, 68-74)

  while (!open.isEmpty()) {
    const current = open.pop()!;
    pops++;                                 ← counts EVERY pop, stale included
    if (closed.has(current)) continue;      ← THE lazy deletion: drop stale duplicate
    ...
    if (tentative < (g.get(next) ?? Infinity)) {
      g.set(next, tentative);
      came.set(next, { edge, prev: current });
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  ← duplicate push
      pushes++;
    }
       │
       └─ this push, on an improved path, is what a decrease-key would have been.
          Instead of editing the old entry in the heap, it adds a better one. The
          `closed.has(current)` skip on line 51 is the cleanup. Remove line 51 and
          A* re-expands finalized nodes — nodesExpanded inflates and work is wasted.
  }
```

**The invariant check (test-only safety net)** (`features/routing/pqueue.ts`):

```
  features/routing/pqueue.ts  (lines 42-48)

  checkInvariant(): boolean {                ← test-only
    for (let i = 1; i < this.heap.length; i++) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].priority > this.heap[i].priority) return false;
    }
    return true;
       │
       └─ asserts parent ≤ child across the whole array — the heap property. Lets
          the test suite prove siftUp/siftDown are correct without depending on
          search behavior. This is how you trust a from-scratch heap.
  }
```

## Elaborate

Lazy deletion is the standard pragmatic answer to "my priority queue language
binding has no decrease-key" — it's exactly how Python's `heapq` is used for
Dijkstra/A* (push a new tuple, skip popped-but-stale entries), because `heapq` has
no decrease-key either. The theoretical alternative, an indexed binary heap with
real decrease-key, gives a tighter heap (never more than `n` entries) at the cost
of maintaining the position map — worth it when memory is tight or the graph is
huge, not worth it here. The deeper rung is a **Fibonacci heap** (O(1) amortized
decrease-key), which improves Dijkstra's asymptotic bound but is slower in
practice due to constant factors — a classic "better on paper, worse on real
inputs" result. For this repo's graph sizes, the dumb array heap with lazy
deletion is the right call, and the from-scratch implementation (vs an npm heap)
is consistent with the project's "build the fundamentals" stance.

Read next: `01-heuristic-pruning.md` (what feeds the priorities) and
`02-instrumented-bench-harness.md` (where the stale-pop gap shows up as
`pops > expanded`).

## Interview defense

**Q: "A* needs decrease-key. Your heap doesn't have it. Is that a bug?"**

No — it's lazy deletion, and it's deliberate. Instead of finding and lowering a
node's key in the heap, I push a new entry with the better priority and skip the
stale one when it pops, using the closed set. That lets the heap stay a plain
array with no value→index map to maintain on every swap. The cost is a few extra
entries; the benefit is a much simpler, correct heap. It's exactly how `heapq`
is used for Dijkstra in Python.

```
  improved path → push duplicate (not decrease-key)
  stale pop → closed.has(node)? skip
  → heap stays dumb, no index bookkeeping
```

Anchor: *the heap knows nothing about "stale"; the caller's closed set owns
staleness — the contract lives in the boundary, not in either file.*

**Q: "Why is `pops` larger than `nodesExpanded` in your benchmark?"**

That gap is exactly the stale duplicates. Every improved path pushes a second
entry for a node; both get popped, but only the first is finalized — the second
hits `closed.has(...)` and is skipped. So `pops` counts the skips and
`nodesExpanded` doesn't. Seeing that gap in the table is how you know lazy
deletion is doing its job.

```
  pops = nodesExpanded + (stale duplicates skipped)
```

Anchor: *the most-forgotten load-bearing part is the closed-set skip — without it
A* re-expands finalized nodes.*

## Validate

1. **Reconstruct.** From memory, write `siftDown` and explain the parent/child
   index arithmetic. (Check `pqueue.ts:59-71`.) Why does `pop` move the *last*
   element to the top rather than promoting a child?
2. **Explain.** The heap has no `decreaseKey`. Where, across `pqueue.ts` and
   `astar.ts`, is the work a decrease-key would do actually performed?
   (`astar.ts:51` + `astar.ts:72`.)
3. **Apply.** If you removed `if (closed.has(current)) continue;` (`astar.ts:51`),
   what happens to `nodesExpanded` in the bench, and could the returned path
   become wrong? (Consider consistency of the haversine heuristic.)
4. **Defend.** Someone wants to replace `PQueue` with an indexed heap that has
   real decrease-key. Argue when that's worth it for this codebase and when it
   isn't, citing graph size (1621 nodes, `mobile/assets/graph.json`) and the
   `push throws on NaN` guard at `pqueue.ts:24`.

## See also

- `01-heuristic-pruning.md` — the `f = g + h` priorities the heap orders by.
- `02-instrumented-bench-harness.md` — why `pops > nodesExpanded`.
- `.aipe/study-dsa-foundations/` — binary heap and priority queue as DSA.
