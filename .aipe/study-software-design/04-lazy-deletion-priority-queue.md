# 04 — Lazy-deletion priority queue

**Industry names:** lazy deletion / stale-entry skipping / decrease-key avoidance.
**Type label:** Industry standard (the standard way to do Dijkstra in practice).

The heap never updates a node's priority in place. It pushes a *new*
entry at the better priority and skips the stale one on pop. Simplicity
bought with one `closed.has()` check.

---

## Zoom out, then zoom in

This is the data structure under the search loop. `01` showed the loop's
holes; this is the thing the loop pops from.

```
  Zoom out — where the queue lives

  ┌─ ROUTING CORE ───────────────────────────────────────────────┐
  │  search()  astar.ts:22                                        │
  │     open.pop()  ◄────────┐                                    │
  │     open.push(next, …)  ─┘                                    │
  │           │                                                   │
  │   ┌───────▼──────────────────────────────────────┐           │
  │   │ ★ PQueue<T>  pqueue.ts:4 ★  ← we are here      │           │
  │   │   binary min-heap, NO decrease-key            │           │
  │   └───────────────────────────────────────────────┘           │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **lazy deletion** — the textbook-practical way to
run Dijkstra/A*. The "proper" textbook version keeps a `decrease-key`
operation that finds a node already in the heap and lowers its priority
in place. That needs the heap to track *where* each item lives (a
value→index map you maintain through every swap). flattr skips all of
that: when it finds a cheaper path to a node, it just pushes a second
entry and lets the first one go stale. You've made this trade whenever
you chose "append + dedupe on read" over "find-and-update in place."

---

## Structure pass

**Layers.** Generic heap (`PQueue<T>`, knows nothing about graphs) →
search loop (owns the "is this stale?" decision via the closed set). The
heap stays domain-agnostic; the staleness handling lives in the caller.

**Axis held constant — "who handles a duplicate entry?"**

```
  "what happens to an outdated heap entry?" — trace across the seam

  ┌─ PQueue ─────────────┐   seam    ┌─ search loop ────────────┐
  │ keeps BOTH entries   │ ════╪════► │ pops stale one, sees it  │
  │ (no decrease-key)    │ (it flips)│ in closed set, `continue` │
  └──────────────────────┘           └──────────────────────────┘
     heap stays dumb                    loop does the skipping
```

**Seam.** `PQueue │ search`. The heap declines to handle staleness; the
loop handles it with one line. That split is *why* `PQueue` can be a
generic `PQueue<T>` reusable for anything — it never had to learn about
graph nodes to support decrease-key.

---

## How it works

### Move 1 — the mental model

The shape: a min-heap that may hold several entries for the same node,
plus a "have I already finalized this node?" set that discards the stale
ones as they surface. Duplicates are allowed in; they're filtered out on
the way out.

```
  Pattern — lazy deletion

  push B@10 ──► heap: [B@10]
  found cheaper path to B (cost 7):
  push B@7  ──► heap: [B@7, B@10]   ← BOTH live; no in-place update
  pop B@7   ──► finalize B, add to closed
  pop B@10  ──► closed.has(B)? yes → `continue`  (stale entry skipped)
       the heap never edited an entry; the loop just ignored the old one
```

### Move 2 — the walkthrough

**The heap is deliberately dumb — no value→index map.** `pqueue.ts:4-77`
is a plain binary min-heap: `push` sifts up, `pop` sifts down, that's it.
Compare to the `PriorityQueue.ts` in your reincodes repo, which *does*
keep a `value→index` lookup so it can `updatePriority`. flattr's
`PQueue` has no such lookup — and that absence is the design choice.

```ts
// features/routing/pqueue.ts:23-39  (the whole interface, essentially)
push(item: T, priority: number): void {
  if (Number.isNaN(priority)) throw new Error("PQueue: NaN priority forbidden");
  this.heap.push({ item, priority });   // always append a fresh entry
  this.siftUp(this.heap.length - 1);
}
pop(): T | undefined {                  // return the global min, sift down
  // …
}
```

No `decreaseKey`, no `updatePriority`, no index map. **What breaks if you
added the map:** nothing functionally — but you'd now maintain it through
every `swap` (`pqueue.ts:73`), and a single missed update silently
corrupts the heap. The map is the part that's easy to get wrong; not
having it is the simplicity win.

**The staleness skip — one line in the loop.** `astar.ts:48-51`:

```ts
// features/routing/astar.ts:48-51
while (!open.isEmpty()) {
  const current = open.pop()!;
  pops++;
  if (closed.has(current)) continue;   // ← THE lazy-deletion line
```

Bridge: this is the "dedupe on read" you've written for a queue of jobs
where the same job got enqueued twice. When a node is popped, if it's
already in `closed` (already finalized at its best cost), this is a stale
duplicate from an earlier, worse push — skip it. **The load-bearing
part:** without this `continue`, the search would re-expand finalized
nodes and could relax along a worse path. It's the single line that makes
"push duplicates freely" safe.

**Why pushing duplicates is correct, not just cheap.** When `astar.ts:69`
finds a cheaper `tentative` cost to `next`, it pushes `next` again at the
new lower priority (`astar.ts:72`). Because the heap is a *min*-heap, the
cheaper entry is popped *first* — so by the time the stale, more-expensive
entry surfaces, `next` is already closed and gets skipped. The min-heap
ordering is what guarantees the good entry wins. **Boundary condition:**
this relies on costs being non-negative (so a later push can't be cheaper
than a finalized node's cost) — which the penalty guarantees (`penalty ≥
0`, `cost.ts:16`). Allow negative costs and lazy deletion breaks; you'd
need Bellman-Ford, not Dijkstra.

**The metrics admit the cost.** `pops` (`types.ts:49`) counts *all* pops
including stale ones, and the bench reports it. Lazy deletion's price is
extra pops — a node can sit in the heap multiple times. The bench makes
that visible so you can see A*'s heuristic shrinking the frontier.

### Move 3 — the principle

When an in-place update needs bookkeeping that's easy to corrupt, prefer
"add a new version + ignore the old one on read." You trade a little
memory and a few wasted pops for deleting an entire class of
index-maintenance bugs. The condition that makes it safe here — a
finalized node's cost can never be beaten later — is the same condition
that makes Dijkstra correct, so you're not even adding a new assumption.
This is *the* standard production Dijkstra; the decrease-key version is
the one textbooks show and almost nobody ships.

---

## Primary diagram

```
  Lazy-deletion priority queue — full recap

  ┌─ PQueue (pqueue.ts:4) — generic min-heap, NO index map ──────┐
  │  push: append + siftUp     pop: return min + siftDown        │
  └───────────────────────────┬──────────────────────────────────┘
            push next@new                │ pop (may be stale)
            (duplicates allowed)         ▼
  ┌─ search loop (astar.ts:48) ──────────────────────────────────┐
  │  current = open.pop()                                         │
  │  if closed.has(current) continue   ← lazy-deletion skip       │
  │  closed.add(current); expand; relax → push cheaper duplicates │
  └───────────────────────────────────────────────────────────────┘
   safe because: min-heap pops cheapest first + costs ≥ 0 (cost.ts:16)
```

---

## Elaborate

Lazy deletion is the pragmatic Dijkstra you'll find in most real routers
and in competitive-programming templates — `std::priority_queue` in C++
has no decrease-key, so everyone does exactly this. The theoretical
decrease-key version (with a Fibonacci heap) has better asymptotic
bounds, but the constant factors and implementation risk make it lose in
practice for graphs this size. flattr's choice matches what production
routing engines do. The one thing to keep in mind: it depends on
non-negative edge costs — the same precondition as Dijkstra itself.
Read `01` for the loop, `05` for why even "blocked" edges keep costs
finite and positive.

---

## Project exercises

### EX-04-A — Count the wasted pops

- **What to build:** a test that routes a grid and asserts `pops >
  nodesExpanded` (proving stale entries exist), then reports the ratio.
- **Why it earns its place:** makes the cost of lazy deletion measurable —
  you see exactly how many duplicate entries the heap held.
- **Files to touch:** `features/routing/astar.test.ts` or a bench note.
- **Done when:** the ratio prints and the inequality holds.
- **Estimated effort:** 30 min.

### EX-04-B — Break it with a negative cost

- **What to build:** a one-off cost function returning a negative value
  for some edge; show the returned path is no longer optimal, then
  document *why* (lazy deletion assumes finalized = best).
- **Why it earns its place:** surfaces the load-bearing precondition
  (costs ≥ 0) by violating it.
- **Files to touch:** a scratch test.
- **Done when:** the suboptimal path is demonstrated with a comment
  naming the broken assumption.
- **Estimated effort:** 40 min.

---

## Interview defense

**Q: Your priority queue has no decrease-key. Isn't that a bug for
Dijkstra?**

No — it's the standard production choice. Instead of finding a node in
the heap and lowering its priority (which needs a value→index map you
maintain through every swap), I push a *second* entry at the lower
priority and skip the stale one on pop with `if (closed.has(current))
continue`. The min-heap pops the cheaper entry first, so the stale one is
always already closed when it surfaces.

```
  the part people forget: WHY the skip is safe
  min-heap pops cheapest first  +  costs ≥ 0
  → a finalized node can never be improved later
  → the stale entry is always redundant when it pops
```

**Q: What's the cost of skipping decrease-key?** Extra memory (duplicate
entries) and extra pops — the bench counts them as `pops`. In exchange I
delete the index-map bookkeeping, which is the easiest part of a heap to
corrupt. For graphs this size it's a clear win, and it's what
`std::priority_queue`-based routers do everywhere.

**Q: When would it break?** Negative edge costs — then a finalized node
*could* be improved later, and the closed-set skip would wrongly discard
a better path. flattr's penalty is always ≥ 0, so it's safe by
construction.

**Anchor:** "No decrease-key — push a duplicate, skip the stale on pop
(`astar.ts:51`). Safe because min-heap + non-negative costs mean
finalized always equals best."

---

## See also

- `01-parametric-search-over-cost-fns.md` — the loop that pops/pushes.
- `05-blocked-as-large-finite.md` — keeps even blocked edges positive-cost.
- `audit.md` lens 6 (the NaN guard at push), lens 2 (PQueue depth).
