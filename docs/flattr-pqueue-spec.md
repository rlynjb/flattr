# flatr — mini-spec: `routing/pqueue.ts`

> The frontier for every search in the project. Build this first; it's the
> dependency under Dijkstra, A*, and bidirectional A*, and it's fully testable
> on its own. See `flatr-spec.md` §14 for where it sits.

Tag: `[GRAPH]`. No libraries — hand-rolled binary heap.

---

## 1. Role

Dijkstra/A* repeatedly need "give me the unsettled node with the smallest
priority." That's a min-priority-queue. Priority = `g` (Dijkstra) or `f = g + h`
(A*), both plain numbers. This module is generic — it knows nothing about
graphs, grades, or geography. It orders items by a number. That separation is
deliberate: one clean, reusable data structure, tested in isolation.

## 2. Design decision (locked for MVP): generic min-heap + closed set

A* needs to lower a node's priority when a better path is found ("decrease-key").
Two ways:

- **(1) Lazy deletion — *chosen.*** The heap is generic (`push` / `pop`). To
  "decrease," just `push` the same key again with the lower priority; never
  touch the old entry. The search skips stale pops via a **closed set** (a node,
  once popped, is final by the heap property; later pops of it are ignored).
  Simplest correct design, O(log n) ops, a little extra memory.
- (2) Indexed decrease-key. Keep a `Map<key, heapIndex>` synced through every
  swap so you can find and sift an existing entry. No duplicates, more code, more
  bug surface. *Upgrade path only — §8.*

Consequence: the closed set lives in the **search** (`astar.ts`), not in the
queue. This refines the §14.2 sketch — replace `open.pushOrDecrease(next, f)`
with `open.push(next, f)` plus a closed check at pop (see §5).

## 3. Interface

```ts
// routing/pqueue.ts  — generic min-priority-queue
export class PQueue<T> {
  push(item: T, priority: number): void;
  pop(): T | undefined;     // removes & returns min-priority item; undefined if empty
  peek(): T | undefined;    // min-priority item without removing
  get size(): number;
  isEmpty(): boolean;
}
```

- Generic over `T` (we store node ids: `PQueue<string>`).
- Empty `pop`/`peek` return `undefined` — never throw.
- Duplicate items allowed (that's how lazy decrease-key works).
- `priority` is any finite number; `BLOCKED` (large-finite, §6) still orders
  correctly, so too-steep edges sink to the back rather than breaking the heap.

## 4. Internals — array-backed binary min-heap

Store `{ item, priority }` entries in a flat array. 0-indexed index math:

```
parent(i) = (i - 1) >> 1
left(i)   = 2*i + 1
right(i)  = 2*i + 2

heap as array:           as tree:
[ 1 3 2 7 4 9 5 ]              1
  0 1 2 3 4 5 6             /     \
                          3         2
                         / \       / \
                        7   4     9   5

invariant: priority[parent] <= priority[child]   (min-heap)
```

- `push`: append at end, **siftUp** (swap with parent while smaller).
- `pop`: save root, move last entry to root, shrink, **siftDown** (swap with
  smaller child while larger).
- Both are O(log n): one root-to-leaf path.

## 5. How the search uses it (reconciles §14.2)

```ts
const open = new PQueue<string>();
const g = new Map<string, number>();
const closed = new Set<string>();        // <-- the lazy-deletion partner

g.set(startId, 0);
open.push(startId, h(startId, goalId));

while (!open.isEmpty()) {
  const current = open.pop()!;
  if (closed.has(current)) continue;     // stale duplicate -> skip
  if (current === goalId) return reconstruct(...);
  closed.add(current);                   // finalized: heap property guarantees min g

  for (const edgeId of graph.adjacency[current]) {
    const next = otherEnd(edge, current);
    if (closed.has(next)) continue;
    const tentative = g.get(current)! + cost(edge, current, userMax);
    if (tentative < (g.get(next) ?? Infinity)) {
      g.set(next, tentative);
      open.push(next, tentative + h(next, goalId));   // push, not decrease-key
    }
  }
}
```

Why correct: the first time a node is popped it has its minimal `f` (heap
property), so adding it to `closed` and skipping later pops is safe. `g` is the
source of truth for cost; the queue is just an ordering device.

## 6. Complexity

| op | time | note |
|---|---|---|
| push | O(log n) | siftUp |
| pop | O(log n) | siftDown |
| peek | O(1) | root |
| space | O(n) | n = entries; lazy deletion makes n up to O(E) relaxations, not O(V) |

The extra duplicate entries are the price of lazy deletion. On a small-bbox MVP
graph it's negligible; revisit only if §8's benchmark says so.

## 7. Invariants, edge cases, tie-breaking

- **Heap invariant** holds after every push/pop (assert it in tests, §9).
- **Empty** queue: `pop`/`peek` → `undefined`, `isEmpty` → true, `size` → 0.
- **Duplicates**: allowed; multiple entries for one item is normal.
- **Equal priorities**: a min-heap is *not* stable. A* doesn't require stability
  for correctness, but ties affect *how many nodes expand*. Optional: break ties
  toward the entry with smaller `h` (closer to goal) to expand fewer nodes —
  store a secondary key and compare `(priority, h)`. Mark as a later tweak; not
  needed for first correct version.
- **NaN priority**: forbid — guard or let it surface in tests; NaN comparisons
  silently corrupt heap order.

## 8. Upgrade path (only if profiled): indexed decrease-key

Keep `pos: Map<T, number>` (item → current heap index), updated on every swap in
siftUp/siftDown. Add `decreaseKey(item, newPriority)` that finds via `pos` and
sifts up. Removes duplicates (space back to O(V)) and the closed-set skip
becomes optional. Cost: the position map must stay perfectly in sync — the most
common bug. Don't reach for this until the benchmark (`flatr-spec.md` §15.3)
shows lazy duplicates actually hurt.

## 9. Test plan (this module ships with tests)

Unit (`pqueue.test.ts`):
1. **Oracle/property test** — push N random (item, priority); pop all; assert the
   popped sequence is non-decreasing in priority. Repeat many seeds.
2. **Matches sorted array** — same inputs into the PQ and into `[].sort()`;
   compare orders.
3. **Empty** — `pop`/`peek` undefined; `isEmpty` true; `size` 0.
4. **Duplicates** — duplicate items and duplicate priorities pop in valid order.
5. **Heap invariant** — after each op in a randomized sequence, assert
   `priority[parent] <= priority[child]` across the array.
6. **Interleaved** — random mix of pushes and pops stays consistent with a
   reference (a re-sorted list).

Integration (proves it's usable before graph work piles on):
7. **Dijkstra on a hand-built 5–6 node graph** with known shortest paths —
   returns the known answers. This is the correctness baseline the whole §15.2
   progression is measured against.

## 10. Done when

- `PQueue<T>` passes all unit tests above.
- A 6-node hand-built Dijkstra (using only this queue) returns known shortest
  paths.
- No third-party heap/PQ dependency imported.

Then move to the next build-order module: `routing/graph.ts` (adjacency +
directed traversal), per `flatr-spec.md` §14 build order.
