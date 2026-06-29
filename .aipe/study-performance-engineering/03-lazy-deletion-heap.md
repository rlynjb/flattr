# Lazy-Deletion Heap — the frontier queue, and the decrease-key trigger

**Industry name(s):** lazy deletion / stale-entry skipping in a binary min-heap;
the alternative is decrease-key (indexed heap). **Type:** Industry standard
(data structure technique).

## Zoom out, then zoom in

You built `BinaryHeap.ts` and `PriorityQueue.ts` with `updatePriority` (a
value→index lookup) in reincodes. flattr's `PQueue` is the *other* design choice:
no `updatePriority`, no index — it just lets stale entries pile up and skips them
on pop. This file is about why flattr picked that, and the one metric that tells
you when to switch back to your indexed version.

```
  Zoom out — where the heap sits

  ┌─ Algorithm core ──────────────────────────────────────────┐
  │  features/routing/astar.ts: search()                       │
  │     open = ★ PQueue<string> ★   ← we are here              │
  │     push(next, f)   /   pop() → current                    │
  │  features/routing/pqueue.ts: the heap itself               │
  └───────────────────────────┬───────────────────────────────┘
                              │ counted by
  ┌─ bench/run.ts ────────────▼───────────────────────────────┐
  │  pushes / pops — the ratio that triggers a redesign        │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: A* needs to repeatedly pull the lowest-`f` node. When it finds a cheaper
path to a node already in the queue, it has two options — *update* the existing
entry's priority (decrease-key, needs an index), or *push a new entry and ignore
the old one* (lazy deletion). flattr does the second.

## Structure pass

**Layers.** The heap is two nested concerns:

```
  heap mechanics (siftUp/siftDown)  →  staleness policy (who handles duplicates?)
  pqueue.ts                            astar.ts:51 — the closed-set skip
```

**Axis: state ownership — "who is responsible for a node that got a cheaper
path?"** Trace it across the seam:

```
  One question across the heap/search boundary
  "when a node's cost improves, who fixes the queue?"

  ┌─ decrease-key design ─┐  seam   ┌─ lazy-deletion design ─┐
  │ HEAP owns it:         │ ═══════ │ SEARCH owns it:         │
  │ updatePriority(idx)   │ (flips) │ push duplicate, skip    │
  │ (your PriorityQueue)  │         │ stale on pop (flattr)   │
  └───────────────────────┘         └─────────────────────────┘
```

The responsibility flips across that seam. flattr's `PQueue` knows *nothing* about
graphs or staleness (`pqueue.ts:1`) — the search handles it with a `closed` set.

**Seam.** The load-bearing boundary is `astar.ts:51`: `if (closed.has(current))
continue;`. That one line is the entire staleness policy. Remove it and the heap's
duplicates corrupt the search.

## How it works

### Move 1 — the mental model

A min-heap that, instead of editing an entry when its priority improves, just
inserts a *second* entry at the better priority and leaves the worse one to rot.
When the rotten one eventually surfaces, the consumer recognizes "I already
finalized this node" and throws it away.

```
  Lazy deletion — the duplicate-then-skip shape

  push B@10                heap: [B@10]
  found cheaper B@6        heap: [B@6, B@10]   ← TWO entries for B
  pop → B@6                finalize B (closed.add B)
  ... later ...
  pop → B@10               closed.has(B)? YES → skip, don't expand
                           ▲ the stale entry self-cleans on pop
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** A binary min-heap is four parts; drop any one and it
breaks:

```
  array storage + parent/child index math + siftUp + siftDown
       │              │                       │         │
       │              └ (i-1)>>1 / 2i+1 / 2i+2          │
       └ heap[] in pqueue.ts:5                          │
                  push: append + siftUp ────────────────┘
                  pop:  swap root w/ last, shrink, siftDown
```

**Name each part by what breaks without it:**

- **`siftUp` (pqueue.ts:50-57)** — restores order after a push. Remove it: pushed
  items sit wherever appended, `peek()` no longer returns the min, A* pops the
  wrong node, route is wrong.
- **`siftDown` (pqueue.ts:59-71)** — restores order after a pop moves the last
  element to the root. Remove it: same corruption from the top.
- **The closed-set skip (astar.ts:51)** — this is the *lazy* in lazy deletion.
  Remove it and every stale duplicate gets re-expanded, inflating `nodesExpanded`
  and possibly relaxing along an already-finalized node. This is the part that
  lives in the *search*, not the heap.

```ts
// features/routing/pqueue.ts:29-39  — pop never looks for duplicates
pop(): T | undefined {
  const n = this.heap.length;
  if (n === 0) return undefined;
  const top = this.heap[0];      // the current min
  const last = this.heap.pop()!; // detach last leaf
  if (n > 1) {
    this.heap[0] = last;         // move it to the root
    this.siftDown(0);            // restore heap order
  }
  return top.item;               // hand back the min — staleness NOT checked here
}
```

```ts
// features/routing/astar.ts:48-51  — staleness handled by the CONSUMER
while (!open.isEmpty()) {
  const current = open.pop()!;
  pops++;
  if (closed.has(current)) continue; // ← stale duplicate (lazy deletion). THE skip.
```

**Separate skeleton from hardening.** The kernel is the heap + the skip. The
`checkInvariant` method (`pqueue.ts:42-48`) and the `NaN` guard on push
(`pqueue.ts:24`) are hardening — test/defensive, not load-bearing for the
algorithm.

**The metric that triggers a redesign — pops vs nodesExpanded.** Every duplicate
push becomes a wasted pop later. So `pops > nodesExpanded` measures the staleness
overhead directly. The bench surfaces exactly this:

```
  Execution trace — pops vs expanded (MEASURED, bench/run.ts)

  pair                       expanded   pops    pops/expanded
  grid40 mid 10,10->30,20      1079     1080    1.001   ← near 1:1
  grid40 mid (astar)            276      277    1.004
  grid30 near (dijkstra)        203      204    1.005
```

On flattr's near-Euclidean grid, almost no node gets a cheaper second path, so
duplicates barely happen — pops sit a hair above expanded. **Lazy deletion is
basically free here, and that's the verdict: don't add an indexed decrease-key
heap you don't need.** The trigger to reconsider is when that ratio climbs — a
graph with lots of re-relaxation (dense, irregular weights) would push pops well
above expanded, and *then* your `PriorityQueue.updatePriority` design earns its
keep by keeping the heap at one entry per node.

### Move 2.5 — current state vs future state

```
  Phase A (now): lazy deletion          Phase B (if pops/expanded climbs)
  ──────────────────────────────        ─────────────────────────────────
  PQueue: no index, no updatePriority   indexed heap w/ decrease-key
  duplicates allowed, skip on pop       one entry per node, edit in place
  pops/expanded ≈ 1.00 (MEASURED)       trigger: ratio >> 1
  simpler heap, knows nothing of graph  needs value→index map (you have it
                                        in reincodes PriorityQueue.ts)
  what DOESN'T change: astar.ts logic   only the queue swaps; search untouched
```

The migration cost is low precisely because the heap knows nothing about the
search — it's a clean swap behind the `push`/`pop`/`peekPriority` interface
(`pqueue.ts:23-39`, `19-21`). The search's `closed`-set skip would become a no-op
but could stay.

### Move 3 — the principle

Lazy deletion trades **memory (duplicate entries)** for **simplicity (no index to
maintain)**, and it's the right trade until the duplicate rate gets high. The
generalizable move is: pick the cheaper design by default, but *instrument the
exact ratio that would justify the more complex one* — here, `pops/nodesExpanded`
— so the upgrade decision is a number, not a guess.

## Primary diagram

```
  Lazy-deletion heap in A* — full picture

  ┌─ astar.ts search loop ────────────────────────────────────┐
  │  push(start, h)                                            │
  │  while open not empty:                                     │
  │    current = open.pop()  ───────────────┐                 │
  │    pops++                                │                 │
  │    if closed.has(current): continue ◄────┘ STALE SKIP      │
  │    closed.add(current); nodesExpanded++                   │
  │    for edge in adjacency:                                  │
  │      if cheaper path to next:                              │
  │        open.push(next, g+h)  ── may be a DUPLICATE         │
  │        pushes++                                            │
  └───────────────────────────┬───────────────────────────────┘
                              │ heap below knows nothing of all this
  ┌─ pqueue.ts ───────────────▼───────────────────────────────┐
  │  push: append + siftUp        pop: root↔last + siftDown    │
  │  no index · no updatePriority · duplicates allowed         │
  └───────────────────────────────────────────────────────────┘

  metric: pops / nodesExpanded ≈ 1.00 here → lazy deletion is free
          (climbs >> 1 → switch to decrease-key)
```

## Elaborate

The classic A*/Dijkstra textbook presents decrease-key as canonical, but real
implementations overwhelmingly use lazy deletion because maintaining a
value→index map costs a hash lookup on every relaxation and bloats the heap node.
On near-metric graphs (road networks, grids) the duplicate rate is low, so lazy
deletion wins on constant factors. flattr's choice matches production routers.
You've built *both* designs — flattr's `PQueue` is the lazy one;
reincodes' `PriorityQueue.ts` with `updatePriority` is the decrease-key one — so
you can speak to the tradeoff from having shipped each.

## Interview defense

**Q: Your heap has no decrease-key. Isn't that wrong for Dijkstra/A*?**

> No — it's lazy deletion. Instead of editing a node's priority when I find a
> cheaper path, I push a second entry and skip the stale one on pop using the
> closed set (`astar.ts:51`). It trades duplicate entries for not maintaining an
> index. On flattr's near-Euclidean grid the duplicate rate is near zero — the
> bench shows pops ≈ expanded (1080 vs 1079), so it's effectively free.

```
  push dup B@6 over B@10 → pop B@6 finalize → pop B@10 → closed? skip
```

Anchor: *the closed-set skip is the load-bearing line; the heap stays dumb.*

**Q: When would you switch to decrease-key?**

> When `pops/nodesExpanded` climbs well above 1 — that ratio *is* the duplicate
> overhead. A dense graph with heavy re-relaxation would inflate it. Then an
> indexed heap with `updatePriority` keeps one entry per node. I've built that
> version too, so it's a queue swap behind the same push/pop interface — the
> search code doesn't change.

```
  ratio ≈ 1.00 → keep lazy      ratio >> 1 → indexed decrease-key
```

Anchor: *the upgrade decision is a measured ratio, not a vibe.*

## See also

- `02-heuristic-pruning.md` — what pushes/pops this queue.
- `audit.md` lens 3 (tail behavior) and lens 4 (CPU).
- Cross-guide: `study-dsa-foundations` (your BinaryHeap/PriorityQueue, both designs).
