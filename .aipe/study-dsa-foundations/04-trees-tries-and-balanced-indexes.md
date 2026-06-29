# Trees, Tries & Balanced Indexes

**Industry names:** binary tree, complete binary tree, trie (prefix tree),
balanced BST (red-black/AVL), B-tree, k-d tree, spatial index.
**Type:** Industry standard.

---

## Zoom out — where this concept lives

This is a mixed file: flattr exercises *one* tree (the heap, viewed as a
tree) and pointedly does **not** exercise the rest of the family. That's
not a flaw to paper over — the absence of a spatial index in `nearest.ts`
is the single clearest algorithmic gap in the repo, and naming it
precisely is more useful than pretending a trie is hiding somewhere.

```
  Zoom out — trees in flattr (one present, several absent)

  ┌─ Present ───────────────────────────────────────────────────┐
  │  pqueue.ts: binary heap = complete binary tree in an array   │ ← we are here
  └──────────────────────────────────────────────────────────────┘
  ┌─ not yet exercised ─────────────────────────────────────────┐
  │  k-d tree / grid index  → would replace nearest.ts O(N) scan │
  │  balanced BST / B-tree  → no ordered-range queries in repo   │
  │  trie                   → no prefix/autocomplete in engine   │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** First the tree that *is* here — the heap as a complete binary
tree, which earns its O(log n) from tree height. Then the trees that
*aren't*, named at the exact line where they'd belong, so you know what
you're looking at when you see the linear scan.

---

## Structure pass — one axis across the tree family

The axis that separates these trees is **what the tree orders by, and what
query that makes cheap.**

```
  Axis: "what does the tree order by → what query is O(log n)?"

  binary heap   → orders by priority   → "give me the min"   ✓ pqueue.ts
  balanced BST  → orders by key        → "range / nearest key" ✗ absent
  k-d tree      → orders by coordinate → "nearest point"     ✗ absent (nearest.ts gap)
  trie          → orders by prefix     → "all words with prefix" ✗ absent
  B-tree        → orders by key, fat   → "disk-friendly range"  ✗ absent
```

The seam that matters: `nearest.ts` asks a **nearest-point** query and
answers it with a linear scan because there's no coordinate-ordered tree.
The heap answers a **min** query in `O(log n)` *because* it's a tree. Same
family, opposite outcomes — that contrast is the lesson.

---

## How it works

### Move 1 — the mental model

A tree earns its `O(log n)` from one thing: **height**. If a balanced tree
has `n` nodes, it's about `log n` levels deep, so any operation that walks
one root-to-leaf path does `log n` work. The heap is the simplest member
of the family: a *complete* binary tree, which means it's as short and
dense as possible.

```
  Complete binary tree — every level full except the last (left-packed)

              level 0:        ●            height = log n
                            /   \
              level 1:    ●       ●        n=7 nodes → height 2
                         / \     / \
              level 2:  ●   ●   ●   ●      push/pop walk one path: log n

  "complete" = no gaps → maps perfectly to a flat array (file 03)
```

### Move 2 — the one tree present, then the absent ones

#### The heap is a tree (the array is the implementation)

File 03 walked the heap as an array. Here's the same structure as a tree,
because that's where the `O(log n)` comes from.

```ts
// features/routing/pqueue.ts:50-57 — siftUp walks one path UP the tree
private siftUp(i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;   // step UP one tree level
    if (this.heap[parent].priority <= this.heap[i].priority) break;
    this.swap(i, parent);
    i = parent;
  }
}
```

```
  siftUp = walk one root-ward path → bounded by tree height = log n

  index 11 ──parent──► 5 ──parent──► 2 ──parent──► 0
  (a leaf)                                        (root)
  worst case: 4 swaps for n≈16, i.e. log2(16)=4 → O(log n)
```

The `(i-1)>>1` is "go up one level"; `2i+1`/`2i+2` in `siftDown`
(`pqueue.ts:60-61`) are "go down to the two children." The completeness
guarantee — push always appends, pop always removes the last — is what
keeps the tree balanced, so the height stays `log n` and the operations
stay `O(log n)`. **Break completeness** (leave a gap mid-array) and the
index arithmetic points at the wrong nodes; the tree-in-array trick falls
apart. That's why `push` appends and `pop` swaps in the last element
rather than leaving a hole.

#### not yet exercised — k-d tree / spatial index (the nearest.ts gap)

This is the gap worth dwelling on. `nearestNode` snaps a tapped coordinate
to the closest graph node — and it does it by checking *every* node.

```ts
// features/routing/nearest.ts:5-18 — O(N) linear scan, no spatial index
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {   // ← scans ALL N nodes
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

```
  Comparison — linear scan (actual) vs k-d tree (the fix)

  ┌─ nearest.ts now: O(N) ──────────┐  ┌─ k-d tree: O(log N) avg ────────┐
  │ tap → check node 1              │  │ tap → descend tree, prune        │
  │      → check node 2             │  │   half the plane each level      │
  │      → ... → check node N       │  │      ●  split on lng             │
  │ every snap touches all N nodes  │  │     / \                          │
  │ a city graph: tens of thousands │  │   ●    ●  split on lat           │
  │   of nodes, every tap           │  │  visit only the relevant cells   │
  └─────────────────────────────────┘  └──────────────────────────────────┘
```

A **k-d tree** alternates splitting on lat then lng at each level, so a
nearest-neighbor query descends to the right region and prunes the rest —
`O(log N)` average. A simpler option that fits flattr perfectly: a
**uniform grid index** (bucket nodes by cell, like `zones.ts` already
buckets edges — `zones.ts:27-42`), then a tap only checks its own cell and
neighbors. The repo already *has* the grid-bucketing pattern in
`zones.ts`; `nearest.ts` just doesn't reuse it.

**Why it's the clearest gap:** `nearestNode` is called twice per route
(start + goal). On the small test graphs it's invisible. On a real city
`graph.json`, the snap can rival the search itself in cost (file 01's
complexity table). This is the first thing to optimize, and you've got the
bucketing pattern one file over.

#### not yet exercised — balanced BST / B-tree

No red-black tree, AVL tree, or B-tree in the repo. They'd belong if
flattr needed **ordered range queries** — "all nodes between elevation X
and Y," "edges sorted by grade." It doesn't; `zones.ts` does a one-shot
full sort instead (file 06). For an in-memory, build-once static graph,
a balanced BST would be over-engineering. **When it becomes relevant:** if
the graph went dynamic (edges added/removed at runtime) and you needed to
keep something sorted incrementally.

#### not yet exercised — trie

No prefix tree. A trie answers "all keys starting with this prefix" in
`O(prefix length)`. **Where it'd belong:** address autocomplete in the
`AddressBar.tsx` mobile component — but that lives in `mobile/` and
currently does geocoding (`pipeline/geocode.ts`), not local prefix
matching. If you ever wanted offline address suggestions over the graph's
street names, that's the trie's job.

### Move 3 — the principle

Every tree in this family is the same bet: **pay `O(log n)` per operation
by keeping data ordered along the tree's axis, so a query walks one path
instead of scanning everything.** flattr takes that bet exactly once — the
heap, ordered by priority. Everywhere else it scans linearly. That's a
fine call for a static graph *except* at `nearest.ts`, where the scan runs
per route and the ordering axis (geographic coordinate) is the most
natural tree key there is.

---

## Primary diagram

The tree family in flattr: what's present, what's absent, and where each
absent one would attach.

```
  Trees in flattr — present (✓) and not yet exercised (✗)

  ┌─ pqueue.ts ─────────────────────────────────────────────────┐
  │ ✓ complete binary tree (heap)   ordered by: priority        │
  │   → "give me the min" in O(log n)   [siftUp/siftDown = path] │
  └──────────────────────────────────────────────────────────────┘
  ┌─ nearest.ts ────────────────────────────────────────────────┐
  │ ✗ k-d tree / grid index         WOULD order by: coordinate  │
  │   current: O(N) linear scan over all nodes                  │
  │   fix: reuse zones.ts grid-bucketing → O(log N) / O(1) avg  │
  └──────────────────────────────────────────────────────────────┘
  ┌─ (no home in current repo) ─────────────────────────────────┐
  │ ✗ balanced BST / B-tree   ordered by: key   (no range query)│
  │ ✗ trie                    ordered by: prefix (no autocomplete)│
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The heap-as-complete-tree is Williams (1964) again — the completeness is
exactly what lets the tree collapse into an array (file 03). k-d trees are
Bentley (1975), built for this nearest-neighbor problem. The grid-index
alternative is cruder but often faster in practice for uniformly-dense
data like a street graph, and flattr already has the ingredient in
`zones.ts`. You've built a BST in reincodes (`BinarySearchTree.ts` with
all traversals, successor/predecessor) — that's the *ordered* tree flattr
doesn't need, but the same node-and-pointer machinery underpins k-d trees,
which it *does* need at `nearest.ts`. The practice map (file 08) ranks the
spatial index as the top hands-on build. Read file 06 next for the sort
that a B-tree would replace, file 05 for the graph the heap serves.

---

## Interview defense

**Q: What's the data structure behind the priority queue, and where does
its `O(log n)` come from?**

```
  complete binary tree → height = log n → one sift = one path = log n
```

*Model answer:* "A complete binary tree packed into a flat array. Children
of index `i` are at `2i+1`/`2i+2`, parent at `(i-1)>>1`. `siftUp` and
`siftDown` each walk a single root-to-leaf path, and since the tree is
complete its height is `log n`, so both are `O(log n)`. Completeness is
what lets it live in an array with no pointers — push appends, pop swaps
the last element up, so there's never a gap."

*Anchor:* `O(log n)` is tree height; completeness is what keeps it that.

**Q: `nearestNode` is `O(N)`. How would you fix it, and why isn't it fixed
already?**

*Model answer:* "Replace the linear scan with a spatial index — a k-d tree
for `O(log N)` average, or simpler, a uniform grid bucketing nodes by
cell, which the repo already does for edges in `zones.ts`. A tap then only
checks its cell and neighbors. It's not fixed because on the small test
graphs `O(N)` is invisible; the cost only shows up on a full city
`graph.json`, where the snap can rival the search. It's the first thing
I'd optimize, and the bucketing pattern is already one file over."

*Anchor:* the grid-bucketing pattern already exists in `zones.ts`;
`nearest.ts` just doesn't reuse it.

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the heap as an array.
- `06-sorting-searching-and-selection.md` — the sort a B-tree replaces.
- `08-dsa-foundations-practice-map.md` — the spatial index as the top
  practice build.
- sibling **performance-engineering** — the latency cost of the `O(N)`
  snap.
