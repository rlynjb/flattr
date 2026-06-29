# Lazy-deletion priority queue

> **Lazy deletion / stale-entry tolerance over decrease-key**
> — Industry standard (the common A\*/Dijkstra implementation choice).

## Zoom out, then zoom in

A\* needs a priority queue, and the textbook version needs a `decrease-key`
operation: when you find a cheaper path to a node already on the heap, you
*update* its priority in place. That requires tracking every node's heap
position and re-sifting it — index bookkeeping that bloats the queue's
interface. flattr skips it entirely. It pushes a *new* entry at the better
priority and lets the stale one rot in the heap until it surfaces, then
discards it on pop. Simpler queue, one cheap check in the search loop.

```
  Zoom out — where the queue sits

  ┌─ Core: features/routing ──────────────────────────┐
  │  search() / bidirectional()                       │
  │     ┌─ frontier ─────────────────────────────┐    │
  │     │  ★ PQueue<string> (pqueue.ts) ★         │    │ ← we are here
  │     │     push(item, priority) / pop()        │    │
  │     └─────────────────────────────────────────┘    │
  │  on pop:  if (closed.has(current)) continue;  ◄────┼── discards stale
  └────────────────────────────────────────────────────┘
```

Zoom in: this is a **deep module that got deeper by leaving something out.**
`PQueue` (`pqueue.ts:4-78`) has no `decreaseKey`, no `contains`, no
`updatePriority` — just `push`/`pop`/`peek`/`isEmpty`/`size`. The complexity
that a decrease-key heap carries inside its interface is instead handled by
*one line* in the caller: skip an entry if its node is already finalized.

## Structure pass

**Layers.** Queue vs caller, split by the staleness check:
- *The queue*: `PQueue` — a generic min-heap, knows nothing of graphs.
- *The seam*: `push(item, priority)` / `pop()`.
- *The caller*: `search()` — owns the `closed` set that detects staleness.

**Axis — "where does duplicate-handling live?"**

```
  axis = "who deals with a node appearing twice in the frontier?"

  ┌─ PQueue ──────────────────┐  doesn't know or care — holds duplicates
  │  push twice → two entries  │  no identity tracking at all
  └──────────┬─────────────────┘
             │ seam: pop() returns the cheaper one FIRST
  ┌─ search() ────────────────┐  detects staleness: closed.has(current)
  │  closed set is the dedup   │  pops stale entry, skips it, continues
  └────────────────────────────┘

  duplicate-handling moved OUT of the queue, INTO the caller's closed set
```

**Seam.** The contract is minimal: `push` accepts `(item, priority)` and may
hold the same item twice; `pop` returns lowest priority first. The queue
makes no promise of uniqueness. The caller's `closed` set is what makes
duplicates harmless. The axis — "who handles a re-discovered node?" — lives
entirely above the seam.

## How it works

### Move 1 — the mental model

You know `Promise.race` — you fire several promises and act on the first to
resolve, letting the losers settle into nothing. Lazy deletion is the same
attitude toward stale heap entries: when a node gets a better priority, you
push a fresh entry to "race" against the old one. The better (lower-priority)
entry wins the pop; the loser surfaces later and you simply ignore it.

```
  the pattern — race the stale entry, discard the loser

  push C@10 ──┐
              ├─► heap ─► pop C@7  (winner: process C)
  push C@7 ───┘            │
                           ▼ later...
                       pop C@10  → closed.has(C)? YES → skip (loser)
```

In one sentence: **tolerate duplicate entries and discard stale ones on pop,
instead of paying to keep the heap unique.**

### Move 2 — the step-by-step walkthrough

#### The queue holds duplicates without complaint

```ts
// pqueue.ts:23-27 — push, annotated
push(item: T, priority: number): void {
  if (Number.isNaN(priority)) throw new Error("PQueue: NaN priority forbidden");
  this.heap.push({ item, priority });   // no identity check — same item OK twice
  this.siftUp(this.heap.length - 1);    // bubble to its place — O(log n)
}
```

No `Map` from item to heap index, no "is this item already here?" lookup. The
same `item` (a node id) can sit in the heap multiple times at different
priorities. The only guard is the NaN check (`pqueue.ts:24`) — a real bug
catcher, since `tentative + heuristic` going NaN would silently corrupt heap
order. **What breaks if you removed the staleness tolerance — i.e., demanded
uniqueness?** You'd need `decreaseKey`, which needs an item→index map kept in
sync through every sift. That's ~30 more lines and a bigger interface, all to
avoid a few extra heap entries.

#### The caller's closed set does the deduplication

```ts
// astar.ts:48-69 — the loop, staleness handling annotated
while (!open.isEmpty()) {
  const current = open.pop()!;
  pops++;
  if (closed.has(current)) continue;   // ◄── stale duplicate: discard, move on
  if (current === goalId) { /* reconstruct */ }
  closed.add(current);                  // finalize: any later copy is now stale
  for (const edgeId of graph.adjacency[current] ?? []) {
    // ...
    if (tentative < (g.get(next) ?? Infinity)) {
      g.set(next, tentative);
      open.push(next, tentative + heuristicFn(...));  // ◄── push NEW entry, don't update
    }
  }
}
```

Two lines carry the whole scheme. Line `astar.ts:51` (`if (closed.has(current))
continue`) is the discard — when a stale duplicate finally surfaces, its node
is already closed, so it's skipped. Line `astar.ts:72` (`open.push(...)`) is
the "decrease-key replacement" — instead of updating the existing entry, push
a fresh one at the better priority. Because `pop` returns lowest-first, the
better entry always processes first and closes the node, so the worse copy
gets discarded later. **What breaks if you forget the `closed.has` check?**
You'd re-expand nodes through stale entries — wasted work, and worse, you
could overwrite a finalized optimal cost with a stale comparison. The check is
load-bearing.

#### The skeleton — what's irreducible vs what's hardening

```
  the kernel (cannot remove any of these):
    ┌─ binary min-heap (array, siftUp/siftDown) ─┐  ordering
    ┌─ pop returns lowest priority ──────────────┐  correctness of A*
    ┌─ caller's closed set ──────────────────────┐  staleness detection
    ┌─ push-new instead of decrease-key ─────────┐  the "lazy" in lazy deletion

  optional hardening (nice, not required):
    ┌─ NaN priority guard (pqueue.ts:24) ────────┐  bug catcher
    ┌─ checkInvariant (pqueue.ts:42) ────────────┐  test-only assertion
    ┌─ peekPriority (pqueue.ts:19) ──────────────┐  needed by bidirectional
```

The kernel is the heap plus the closed-set discard. Drop the heap's ordering
and A\* isn't A\*. Drop the closed set and stale entries corrupt the result.
The rest is hardening: `checkInvariant` exists purely so `pqueue.test.ts` can
assert the heap property holds; `peekPriority` exists because
`bidirectional.ts:50` needs to compare the two frontiers' best priorities
without popping. **The part people forget:** the closed-set discard. Everyone
remembers "A\* uses a priority queue." The interview signal is naming that the
queue tolerates stale entries and the *caller* discards them on pop — that's
how you know someone implemented it rather than imported it.

### Move 3 — the principle

Sometimes the deepest module is the one that refuses a feature. `decreaseKey`
would make `PQueue` "complete," and worse for it — a bigger interface, an
item→index map to keep in sync, more surface to misuse. By tolerating
duplicates and pushing the staleness check up to the one caller that has a
closed set anyway, the queue stays a clean generic. The general lesson:
**before adding an operation to make a module self-sufficient, check whether
the caller already has the state to handle it more cheaply.**

## Primary diagram

The whole scheme: caller pushes duplicates, heap orders them, caller discards
stale on pop.

```
  lazy-deletion priority queue — complete

  ┌─ search() — owns the closed set ───────────────────────────┐
  │  found cheaper path to C?  → open.push(C, 7)   (NEW entry)  │
  │                                                            │
  │  loop:  current = open.pop()                               │
  │         closed.has(current)?  ── YES ──► skip (stale)      │
  │                               ── NO  ──► close + expand    │
  └───────────────────────────┬────────────────────────────────┘
                              │ push / pop  (the only contract)
  ┌─ PQueue (pqueue.ts) — generic min-heap ────────────────────┐
  │  heap: [{item,priority}]   siftUp / siftDown               │
  │  holds C@10 AND C@7 happily — no identity tracking         │
  │  pop() → C@7 first (lowest), C@10 later (becomes stale)    │
  │  NaN guard · checkInvariant (test) · peekPriority (bidir)  │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Lazy deletion is the standard practical choice for A\*/Dijkstra in languages
without a built-in indexed priority queue — the asymptotic cost is a few extra
heap entries (bounded by the number of relaxations), which is almost always
cheaper in practice than maintaining decrease-key bookkeeping. flattr's
`PriorityQueue.ts` in the reincodes DSA repo *does* have `updatePriority` with
a value→index map; this `PQueue` deliberately doesn't, because the search loop
already has a closed set and doesn't need it. Same engineer, two designs,
chosen by context — that contrast is itself the lesson.

It pairs with pattern `01`: `PQueue` is the frontier that `search()` pops
from, and it's a second example of the deep-module property — small interface,
the hard heap mechanics hidden. For the heap algorithm itself (siftUp,
siftDown, array layout), see `study-dsa-foundations/`.

## Interview defense

**Q: "Your priority queue can't update a key. Isn't that the whole point of a
PQ for Dijkstra — decrease-key when you find a shorter path?"**

It's *a* way, not the point. The point is "always expand the cheapest frontier
node next," and lazy deletion delivers that without decrease-key. When I find
a cheaper path to a node, I push a new entry at the better priority instead of
updating the old one. Because pop returns lowest-first, the better entry comes
out first, closes the node, and the stale entry — when it eventually
surfaces — hits `closed.has(current)` and is discarded (`astar.ts:51`). The
cost is at most one extra heap entry per relaxation; the benefit is the queue
stays a clean generic with no item→index map to keep in sync through every
sift. For a graph this size, that trade is clearly right.

```
  decrease-key heap            vs     lazy-deletion heap
  ┌──────────────────┐                ┌──────────────┐
  │ push/pop         │                │ push/pop     │  smaller interface
  │ + item→index map │ sync on        │ (that's it)  │
  │ + decreaseKey    │ every sift     └──────┬───────┘
  └──────────────────┘                caller's closed set discards stale
```

*Anchor: lazy deletion replaces decrease-key with push-new + discard-stale-on-
pop — the closed set the caller already has does the dedup.*

**Q: "What's the load-bearing line, and what breaks without it?"**

`if (closed.has(current)) continue;` at `astar.ts:51`. Without it, stale
duplicates get re-expanded — you'd redo work and could relax neighbors off a
finalized node's outdated cost. That one line is what makes the duplicates
harmless, and it's the part people forget when they describe "A\* uses a
heap." Naming it is how you signal you built the loop.

*Anchor: the closed-set discard on pop is the line that makes stale entries
harmless — forget it and A\* re-expands finalized nodes.*

## See also

- `01-parametric-search-over-cost-fns.md` — the engine this queue powers.
- `05-blocked-as-large-finite.md` — the other "simpler than it looks" choice.
- `audit.md` Lens 2 (deep modules), Lens 6 (the NaN guard as a low-level mask).
- `study-dsa-foundations/` — binary heap siftUp/siftDown mechanics.
