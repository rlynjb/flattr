# Trees, tries & balanced indexes

**Industry names:** binary search tree (BST) · self-balancing trees (AVL,
red-black, B-tree) · trie / prefix tree · spatial index (k-d tree, R-tree,
quadtree). **Type:** Industry standard. **Status in this repo:
`not yet exercised`** — every lookup here is a hash map or a linear scan. This
file teaches the foundation briefly and names exactly where each tree *would*
land in `flattr`.

---

## Zoom out, then zoom in

The repo's lookups are either keyed (`O(1)` hash map — see **02**) or full scans
(`O(V)` linear — `nearestNode`). Trees fill the gap between those two: they give
you **ordered** and **range/nearest** queries that a hash map can't and a scan is
too slow for. There's no tree in `flattr` today — but there are two places
screaming for one.

```
  Zoom out — where a tree would slot in (none exist yet)

  ┌─ Input layer ──────────────────────────────────────────────────┐
  │  nearestNode(point) → linear scan O(V)   ← ★ wants a SPATIAL TREE│
  │  features/routing/nearest.ts:5-18           (k-d tree / R-tree)  │
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ Mobile UI layer (mobile/src/AddressBar.tsx) ──────────────────┐
  │  address autocomplete                    ← ★ wants a TRIE        │
  │  (prefix match on street names)             (not yet built)     │
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ Aggregation layer ─────▼────────────────────────────────────────┐
  │  percentile() → full sort O(n log n)     ← a BALANCED INDEX or    │
  │  features/grade/zones.ts:5-14               selection avoids it   │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: a tree keeps elements in an order *and* keeps itself shallow, so
"find," "find the neighbor," and "find everything in a range" are all `O(log n)`
instead of `O(n)`. The price is that the tree must stay balanced — an unbalanced
BST degrades to a linked list (`O(n)`).

---

## The structure pass

**Layers.** Trees are a family; they layer by *what order they impose*:

```
  One question — "what query does this make cheap?" — across the tree family

  ┌──────────────────────────────────────────────┐
  │ BST / balanced (AVL, RB)  → ordered key lookup │  ← range, predecessor, min/max
  └────────────────────┬───────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ B-tree                → disk-page lookup  │  ← database & filesystem indexes
       └───────────────┬─────────────────────────┘
           ┌───────────▼───────────────────────┐
           │ trie                  → prefix lookup│  ← autocomplete, "starts with"
           └───────────┬───────────────────────┘
               ┌───────▼─────────────────────┐
               │ spatial (k-d, R-tree)         │  ← nearest-point, bbox overlap
               └───────────────────────────────┘  ← ★ what nearest.ts wants
```

**Axis = query type.** Hold "what am I asking?" constant. Hash map answers
"exact key?" Tree answers "key, *and* its neighbors / range / prefix / nearest in
space." The seam between hash map and tree is precisely: *do you need order, or
just membership?* `flattr`'s node table needs only membership → hash map, correct
(**02**). `nearestNode` needs *spatial proximity* → it should be a tree but isn't.

---

## How it works

### Move 1 — the mental model

You know `Array.prototype.indexOf` is `O(n)` but binary search on a *sorted*
array is `O(log n)` — you halve the search space each step. A balanced tree is
that halving made dynamic: it stays sorted as you insert and delete, so every
lookup is a root-to-leaf walk down `log n` levels.

```
  A BST: ordered, balanced, root-to-leaf walk

  search for 6:           the invariant:
        8                 left subtree  < node < right subtree
       / \                so at each node you go ONE way → O(height)
      4   12              balanced height = log n
     / \                  unbalanced (sorted inserts) = n  ← the failure mode
    2   6  ◄── found in 2 hops, not 4 scans
```

### Move 2 variant — the load-bearing skeleton

A balanced search tree's kernel, named by what breaks:

**1. The ordering invariant — `left < node < right`.** *Remove it* and you can't
prune: you'd have to check both subtrees, collapsing back to `O(n)`. The invariant
is what lets you discard half the tree at each node.

**2. The balance operation — rotations / rebalancing.** *Remove it* and a BST
built from sorted input becomes a linked list — height `n`, every operation
`O(n)`. This is the part people skip when hand-rolling a BST, and it's why
production code reaches for a *self-balancing* variant (AVL, red-black) or a
library. (Rein's `reincodes/BinarySearchTree.ts` is a plain BST — insert/search/
delete + traversals + successor/predecessor — *without* rebalancing, which is the
classic teaching version; production needs the balanced one.)

**3. The traversal — in-order yields sorted order.** Walking left → node → right
visits keys in ascending order. *This is the tree's superpower over a hash map*:
a hash map can't give you "all keys between X and Y" or "the next key after this
one" without sorting everything first.

**The trie is a different shape — keyed by character position:**

```
  Trie for {"pike","pine","pin"} — prefix-keyed tree

         root
          │ p
          ●
          │ i
          ●
        n │ k
      ┌───┴───┐
   (pin)●     ●
      e │     │ e
   (pine)●  (pike)●

  type "pi" → walk to the 'i' node → every leaf below is a completion
  O(length of prefix), independent of how many words are stored
```

### Move 2.5 — what flattr would gain

**Spatial index for `nearestNode` (the strongest case).** Today
`nearest.ts:5-18` scans *every node* and haversines each one — `O(V)` per
snap, run once for the start and once for the goal on every route request. A k-d
tree or R-tree built over the node coordinates turns that into `O(log V)` average.

```
  nearestNode today vs with a spatial tree

  TODAY (nearest.ts:7-15)              WITH k-d TREE
  ┌────────────────────────┐          ┌──────────────────────────┐
  │ for id in all nodes:    │          │ descend tree by lat/lng   │
  │   d = haversine(...)    │  ───►    │ prune subtrees that can't │
  │   track best            │          │   contain a closer point  │
  │ O(V) — every node       │          │ O(log V) average          │
  └────────────────────────┘          └──────────────────────────┘
  for a city-sized graph (V in the 100k+), this is the difference between
  a snappy tap-to-route and a visible stall.
```

When does it become worth it? The spec keeps the MVP to a small bbox (§11
decision E), so `V` is small and the linear scan is fine *today*. The moment the
graph grows to all of Seattle, this is the first index to add.

**Trie for address autocomplete.** `mobile/src/AddressBar.tsx` does address
entry. Prefix-matching street names as the user types ("pin" → "Pine St",
"Pike Pl") is the textbook trie use case — `O(prefix length)` regardless of how
many streets exist. Not built; this is where it'd go.

### Move 3 — the principle

**Reach for a tree when you need *order* or *proximity*, not just membership.**
A hash map is strictly better for exact-key lookup (`O(1)` beats `O(log n)`). The
tree earns its `log n` only when the query is "nearest," "range," "prefix," or
"next" — questions a hash map structurally cannot answer. `flattr` correctly uses
hash maps everywhere it needs membership; the gap is exactly the one spatial
query (`nearestNode`) where a tree would win.

---

## Primary diagram

The decision: hash map vs tree vs scan, mapped onto `flattr`'s actual lookups.

```
  Which structure for which lookup in flattr

  query needed              right structure       in this repo
  ───────────────────────────────────────────────────────────────────
  "node by exact id"    →   hash map O(1)      →   nodes: Record ✓ (02)
  "edges at a node"     →   hash map O(1)      →   adjacency: Record ✓ (02)
  "nearest node to pt"  →   spatial tree O(logV)→  LINEAR SCAN O(V) ✗ (nearest.ts)
  "street by prefix"    →   trie O(len)        →   NOT BUILT ✗ (AddressBar.tsx)
  "grades in a range"   →   balanced index     →   full sort O(n logn) ~ (zones.ts)
                                                    ↑ ✓ exists  ✗ gap  ~ suboptimal
```

---

## Implementation in codebase

**Use cases.** There are no trees in the repo. The honest finding is the *absence*
and where it costs. The one place a tree's job is being done by a worse structure:

```
  features/routing/nearest.ts  (lines 5-18)  — the scan a tree would replace

  export function nearestNode(graph: Graph, point: LatLng): string {
    let bestId; let bestDist = Infinity;
    for (const id of Object.keys(graph.nodes)) {   ← O(V): touches EVERY node
      const d = haversine(point, {lat:n.lat, lng:n.lng});
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    ...
  }
       │
       └─ correct and fine for the MVP's small bbox. A k-d tree over (lat,lng)
          would prune to O(log V) — the upgrade to make when V grows to a full
          city. It's not premature now: spec §11-E keeps the bbox small on
          purpose. (See 06 for the binary-search version of the same idea on a
          single sorted axis.)
```

---

## Elaborate

The BST is foundational (1960s); the insight that it must *self-balance* to stay
`O(log n)` produced AVL trees (1962) and red-black trees (1972), and the
disk-optimized B-tree (Bayer & McCreight, 1972) is what every relational database
index actually is — including the pgvector/Postgres indexes in Rein's AdvntrCue.
Tries (Fredkin, 1960) power autocomplete and IP routing tables. Spatial trees
(k-d tree, Bentley 1975; R-tree, Guttman 1984) are what real map software uses for
exactly `nearestNode`'s job. The database-index angle lives in
`.aipe/study-data-modeling/`; the spatial-index-as-a-scaling-move lives in
`.aipe/study-system-design/`. Next read for the *flat* version of "find in sorted
data": **06**, binary search.

---

## Interview defense

**Q: "There are no trees in this repo. Where would the first one go?"**

A spatial index over `nearestNode` (`nearest.ts:5-18`). It's a linear `O(V)` scan
today, run twice per route request. A k-d tree makes it `O(log V)`. It's correct
to defer — the MVP bbox keeps `V` small (spec §11-E) — but it's the first index
to add when the graph grows to a full city.

```
  nearest.ts: O(V) scan ──[V grows]──► k-d tree O(log V)
  defer rule: index when the scan shows up in a profile, not before
  anchor: nearest.ts:7-15
```

**Q: "Why a trie for autocomplete and not a hash map?"**

A hash map answers exact keys; autocomplete needs *prefix* matches. A trie walks
the prefix once and every leaf below is a completion — `O(prefix length)`,
independent of dictionary size. That'd land in `mobile/src/AddressBar.tsx`.

**Q: "What breaks if you hand-roll a BST without balancing?"**

Sorted inserts make it a linked list — `O(n)` per op, the whole `log n` benefit
gone. Production uses a self-balancing variant; the plain BST is the teaching
version.

---

## Validate

1. **Reconstruct:** State the BST ordering invariant and explain why in-order
   traversal yields sorted keys.
2. **Explain:** Why is `nearest.ts:5-18` `O(V)` and what tree makes it
   `O(log V)`? Why is deferring it correct for the current MVP (spec §11-E)?
3. **Apply:** Sketch a trie for `{"pine","pike","pin"}` and trace the lookup for
   prefix `"pi"`.
4. **Defend:** Argue when a hash map (`nodes: Record`, `types.ts:23`) is the right
   call over a tree, and when the choice flips.

---

## See also

- **02-arrays-strings-and-hash-maps.md** — the hash maps that handle membership today.
- **06-sorting-searching-and-selection.md** — binary search, the flat-array cousin.
- **05-graphs-and-traversals.md** — `nearestNode` feeds the search its start/goal.
- `.aipe/study-data-modeling/` — B-tree database indexes.
- `.aipe/study-system-design/` — spatial indexing as a scaling move.
