# Trees, Tries & Balanced Indexes

**Industry names:** binary heap (the one tree flattr has) · k-d tree / spatial
index · trie / prefix tree · balanced BST / B-tree. **Type:** Industry standard.

## Zoom out, then zoom in

This is the file where the honest answer is mostly **not yet exercised** — and
that's the lesson. flattr has exactly *one* tree: the binary heap inside
`PQueue`, and it's an *implicit* tree (an array, covered in full in `03`). It
has *zero* explicit pointer-based trees, no balanced BST, no trie, no B-tree,
no k-d tree. The interesting part is the one place a tree *should* exist and
doesn't: `nearestNode()` snaps a tapped coordinate to the closest graph node
with an O(N) linear scan. That's the single clearest "a spatial tree would earn
its keep here" gap in the codebase.

```
  Zoom out — trees in flattr: one implicit, one missing

  ┌─ Algorithm layer ─────────────────────────────────────────┐
  │  nearestNode(graph, point)   ← O(N) scan over all nodes    │ ★ GAP
  │     nearest.ts:8  "for id of Object.keys(graph.nodes)"     │
  │                                                            │
  │  PQueue (binary heap)        ← the ONLY tree, and it's     │
  │     pqueue.ts  array-as-tree    implicit (see file 03)     │
  └────────────────────────────────────────────────────────────┘

  not present anywhere:  BST · AVL/red-black · B-tree · trie · k-d tree
```

Zoom in: a balanced tree buys you `O(log n)` lookup *by structure* — you pay a
little to keep the data ordered so queries skip most of it. `nearestNode`
pays nothing to organize and so pays `O(N)` on every query. We'll teach what
the tree *would* be and exactly when flattr would need it.

## The structure pass

One real tree (the heap), several absent ones. Trace the **lookup-cost** axis
to see why the gap matters.

```
  Axis: cost of "find the thing I'm looking for"

  structure        flattr status      lookup cost     would replace
  ──────────────   ────────────────   ────────────    ──────────────────
  binary heap      PRESENT (pqueue)   O(log n) pop    —
  k-d tree         not yet exercised  O(log N) avg    nearestNode O(N) scan
  trie             not yet exercised  O(key length)   address autocomplete
  balanced BST     not yet exercised  O(log n)        nothing currently
  B-tree           not yet exercised  O(log n) disk   nothing (no DB engine)
```

**The seam:** `nearestNode()` sits at the boundary between the UI (a tap, a
`LatLng`) and the router (a node id `search()` can start from). That seam is
crossed on *every* route request. The contract is "give me the closest node";
the implementation is a full scan. That's the load-bearing joint where a
spatial tree would change the cost class — and the one place in flattr where
the absent tree is *felt*.

## How it works

### Move 1 — the mental model

You already hold the one tree flattr has: the heap from `03`, an array where
the index *is* the tree position. The trees flattr *lacks* all share one idea —
**order the data spatially or by prefix so a query prunes whole subtrees
instead of scanning everything.** A k-d tree does it for 2-D points: split the
plane on alternating axes (latitude, then longitude, then latitude…), and a
nearest-neighbor query can discard half the points at each level.

```
  k-d tree — the structure nearestNode() would use (not present)

  split on lat:            (lat 0.001)
                          /            \
  split on lng:     (lng 0.0005)    (lng 0.0015)
                     /     \           /      \
                  pt       pt        pt       pt

  query for nearest to a tap:
    descend to the leaf the tap falls in,        ← O(log N)
    then check only subtrees that COULD hold a
    closer point (prune by axis distance)
```

### Move 2 — the walkthrough

#### The one tree flattr has — and why it's implicit

The heap (`pqueue.ts`) is a complete binary tree, but it's stored as a flat
array with index arithmetic (`03` walks this fully). It earns "tree" status
because the parent≤child invariant is a tree property — but there are no node
objects and no pointers. flattr uses the *implicit* form because the heap is
always complete (filled left to right), which is exactly the shape that maps
cleanly to an array. **Pointer-based trees show up when the shape is
irregular** — a BST after arbitrary inserts, a trie branching on characters, a
k-d tree splitting on coordinates. flattr has none of those.

#### The gap — nearestNode's O(N) scan

Here's the actual code, `nearest.ts:5-18`:

```ts
// nearest.ts:5-18 — linear scan, O(N) over every node, every call
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {   // EVERY node, no pruning
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });
    if (d < bestDist) { bestDist = d; bestId = id; }   // running min
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

Read it: it's a **running-minimum linear scan** — the same shape as
`Math.min(...arr)` written out by hand. Correct, simple, zero structure to
maintain. Cost: `O(N)` haversine computations per call, where N is every node
in the graph.

```
  Current: O(N) scan          Possible: O(log N) k-d tree query

  ┌─ nearest.ts:8 ─────────┐   ┌─ k-d tree (not built) ────────┐
  │ for id in ALL nodes:   │   │ descend to leaf region        │
  │   d = haversine(...)   │   │ prune subtrees that can't      │
  │   track running min    │   │ hold a closer point            │
  │ → N haversines         │   │ → ~log N haversines (avg)      │
  └────────────────────────┘   └────────────────────────────────┘
       called on every            same answer, fewer distance
       route request              computations
```

**Is this a bug?** No — it's a deliberate, defensible choice at flattr's
current scale. The graph is a static `mobile/assets/graph.json` for one city's
walkable area. If N is a few thousand nodes and `nearestNode` runs once per
tap, an O(N) scan is sub-millisecond and a k-d tree would be *premature*. The
honest framing: it's the right call *now*, and it's the first thing to change
if the graph grows to a metro-area node count or `nearestNode` moves into a hot
loop (e.g. snapping a live GPS track every frame). The build-and-maintain cost
of a k-d tree only pays off past that threshold.

#### What a trie would be for — not yet exercised

A trie (prefix tree) keys on the *characters of a string*, branching one
character per level, so "find all entries starting with `Pike St`" is
`O(prefix length)` not `O(entries)`. flattr has `pipeline/geocode.ts` for
address→coordinate, but **no autocomplete structure** — type-ahead over street
names is the place a trie would land. It's `not yet exercised`; there's no
prefix query anywhere in the repo today.

#### Balanced BST / B-tree — not yet exercised, and why

A self-balancing BST (AVL, red-black) keeps ordered data with `O(log n)`
insert/lookup/delete; a B-tree is the disk-friendly, high-fan-out version that
every relational DB index is built from. flattr has **neither**, and correctly
so — there's *no live database* (the project context is explicit: graph is a
static artifact, no SQL server). With no mutable ordered dataset and no
on-disk index, a balanced search tree has nothing to do. This is the cleanest
kind of `not yet exercised`: not a gap to fill, just a structure this problem
shape doesn't call for.

### Move 3 — the principle

Trees buy you `O(log n)` by *paying to keep data organized* — spatially
(k-d tree), by prefix (trie), or by order (BST/B-tree). flattr only builds the
one tree where the organization is free: the heap, complete by construction, so
an array encodes it with no maintenance. Everywhere else it either doesn't need
ordered lookup (no BST/B-tree) or accepts the O(N) scan because the scale
doesn't justify the structure (`nearestNode`). The generalizable judgment: a
tree earns its place only when query frequency × dataset size makes the scan
hurt more than the structure costs to maintain. flattr is below that line
today — and knowing *where* the line is, is the skill.

## Primary diagram

flattr's tree story: one present, the rest mapped to where they'd go.

```
  Trees in flattr — present vs the deliberate gaps

  PRESENT
  ┌──────────────────────────────────────────────────────────┐
  │  binary heap (PQueue)   implicit, array-as-tree           │
  │  pqueue.ts              complete → no pointers needed      │
  └──────────────────────────────────────────────────────────┘

  NOT YET EXERCISED — mapped to where each would live
  ┌──────────────────────────────────────────────────────────┐
  │  k-d tree   →  nearest.ts:8   O(N) scan → O(log N) query  │ ← the felt gap
  │  trie       →  address autocomplete (no UI for it yet)    │
  │  balanced   →  nothing — no mutable ordered dataset       │
  │  B-tree     →  nothing — no DB engine, static graph.json  │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The k-d tree (Bentley, 1975) is the classic nearest-neighbor structure for
low-dimensional points; for geographic queries an R-tree or a simple uniform
grid index is often used instead, and a grid is arguably the *better* fit for
flattr because the graph already has a `bbox` and `zones.ts` already tiles that
bbox into a grid (`zones.ts:23-42`) — the spatial bucketing machinery half
exists. B-trees (Bayer–McCreight, 1972) are the foundation of every database
index; their absence here is a direct consequence of flattr having no database.
Tries power autocomplete and routing tables. The pattern across all of them: a
balanced index is a *space-for-time* trade — extra structure maintained on
write so reads can prune.

Read next: `06` (binary search — the other "prune by structure" idea, also
absent) and `02` (the `Map`/`Set` flattr uses *instead of* ordered trees).

## Interview defense

**Q: Your nearest-node lookup is O(N). Is that a problem?**

Not at flattr's current scale, and here's the reasoning. The graph is a static
single-city artifact; `nearestNode` runs once per route request over a few
thousand nodes — sub-millisecond. A k-d tree or grid index would be premature.
It becomes worth building when the node count grows to metro scale *or*
`nearestNode` moves into a hot loop like per-frame GPS snapping.

```
  now:   N small, called rarely → O(N) scan is fine
  later: N large OR per-frame   → k-d tree / grid index, O(log N)
  the grid machinery half-exists already in zones.ts (bbox tiling)
```

Anchor: "the structure earns its place only when query-rate × N beats its
maintenance cost — flattr's below that line, and I know where the line is."

**Q: Where's the one tree in this codebase?**

The binary heap in `PQueue` (`pqueue.ts`), and it's *implicit* — a flat array
where the index encodes the tree position, no pointers. It can be implicit
because a heap is always a complete tree, which maps cleanly to an array.
Pointer-based trees only show up when the shape is irregular, and flattr has
no irregular-shaped tree.

Anchor: "complete tree → array encoding; irregular tree → pointers, and flattr
has none of the latter."

## See also

- `03-stacks-queues-deques-and-heaps.md` — the heap, the one tree, in full.
- `06-sorting-searching-and-selection.md` — binary search, the sibling
  "prune by structure" idea, also `not yet exercised`.
- `02-arrays-strings-and-hash-maps.md` — the hash structures used instead of
  ordered trees.
- `08-dsa-foundations-practice-map.md` — k-d tree and trie as ranked gaps.
