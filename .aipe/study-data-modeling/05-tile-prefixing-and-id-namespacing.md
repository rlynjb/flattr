# Tile Prefixing and ID Namespacing

**Industry name(s):** id namespacing / key prefixing on merge / surrogate-key
re-keying. **Type:** Project-specific (the flattr tiling merge), instance of a
standard id-collision pattern.

---

## Zoom out, then zoom in

When you `UNION` two tables that each have their own auto-increment `id`, you get
collisions — both have an `id = 1` meaning different rows. The fix is to
namespace the keys before merging. flattr builds each map tile as an
*independent* graph with its own `n0, n1, e0…` ids, then merges tiles for
pan-to-load coverage — so it has exactly this collision problem, and solves it
by prefixing every id. Here's where the re-keying sits.

```
  Zoom out — re-keying happens on the merge path

  ┌─ Runtime (mobile/useTileGraph.ts) ─────────────────────────────┐
  │  build tile A (n0,n1,e0…)   build tile B (n0,n1,e0…)  ← COLLIDE │
  │            │ prefixGraph("view")     │ prefixGraph("corridor")  │
  │            ▼                         ▼                          │
  │     view:n0, view:e0…          corridor:n0…   ★ namespaced ★    │ ← we are here
  │            └──────────► mergeGraphs ◄──────────┘                │
  │                            │ stitchGraph (connect coincident)   │
  └────────────────────────────▼───────────────────────────────────┘
                          one merged Graph (display + routing)
```

Zoom in: each tile's ids are local (`n0`, `e0`), so two tiles collide on every
id. `prefixGraph` re-keys *every* id and *every* reference to it — nodes, edge
PKs, edge FKs, and adjacency — under a per-tile prefix, so the merged graph has
globally-unique keys. The question: *how do you merge independently-keyed
graphs without corrupting the relations?*

---

## The structure pass

**Layers.** Two: the *per-tile* graph (locally-keyed, built by `buildGraph`) and
the *merged* graph (globally-keyed, consumed by A* and the heatmap).

**Axis — "is every reference to an id updated when the id changes?"** This is the
referential-consistency question — re-keying a PK is only safe if every FK and
index pointing at it moves too.

```
  One question: when an id is re-keyed, do ALL its references follow?

  re-keyed thing          references that MUST update together
  ──────────────          ────────────────────────────────────
  node id (PK)            ── adjacency KEYS, edge.fromNode, edge.toNode
  edge id (PK)            ── adjacency VALUES (the edgeId lists)
  edge.fromNode/toNode    ── (the FK itself)

  prefixGraph updates ALL of them in one pass — that's the invariant it keeps
```

**Seam.** The load-bearing boundary is `prefixGraph` (`tiles.ts:21-38`): it's the
one function that mutates ids at runtime, and it's the one place the FK +
adjacency consistency from `02` and `04` is *actively maintained* rather than
just built-once. If it re-keyed nodes but forgot `edge.fromNode`, the merge would
produce dangling FKs — exactly the integrity failure `04` warns about. It
doesn't, and that's the point of this file.

---

## How it works

### Move 1 — the mental model

Prefixing ids on merge is the `UNION` collision fix you've done in SQL: when two
sources share a key space, namespace them (`'A:' || id`) before combining. The
twist with a *graph* is that a node id isn't just a PK — it's referenced by edge
FKs *and* by the adjacency index. So re-keying one id means rewriting it in three
places at once, or the relations break.

```
  The kernel: re-key the PK AND every reference, atomically

  node "n0"  ──prefix "view:"──►  "view:n0"
       │ but "n0" also appears as:
       ├─ adjacency KEY            → must become "view:n0"
       ├─ edge.fromNode / toNode   → must become "view:n0"
       └─ adjacency VALUE (edge id)→ edge "e0" → "view:e0"
  miss any one → dangling reference in the merged graph
```

### Move 2 — the walkthrough

**`prefixGraph` — re-key every id and every reference.** Watch it rewrite all
four places one `p()` at a time:

```ts
// features/map/tiles.ts:21-38
export function prefixGraph(graph: Graph, prefix: string): Graph {
  const p = (id: string) => `${prefix}:${id}`;          // the namespacing function

  const nodes: Record<string, Node> = {};
  for (const id of Object.keys(graph.nodes)) {
    nodes[p(id)] = { ...graph.nodes[id], id: p(id) };   // ① re-key node store + node.id
  }
  const edges: Edge[] = graph.edges.map((e) => ({
    ...e,
    id: p(e.id),                                        // ② re-key edge PK
    fromNode: p(e.fromNode),                            // ③ re-key edge FK (from)
    toNode: p(e.toNode),                                // ③ re-key edge FK (to)
  }));
  const adjacency: Record<string, string[]> = {};
  for (const id of Object.keys(graph.adjacency)) {
    adjacency[p(id)] = graph.adjacency[id].map(p);      // ④ re-key adjacency keys AND values
  }
  return { ...graph, nodes, edges, adjacency };
}
```

Four rewrites, and *all four* matter (line refs: ① 24-26, ② 30, ③ 31-32, ④
34-36):
- ① the `nodes` Record key *and* the embedded `node.id` — both, or `nodes[id].id`
  disagrees with its key.
- ② the edge's own PK.
- ③ the edge's FKs — this is the one that keeps referential integrity across the
  re-key. Forget it and every edge dangles.
- ④ the adjacency keys (node ids) *and* the values (edge ids) — `.map(p)` over
  the list re-keys the edge-ids it points at.

This is the runtime counterpart to the build-time `buildAdjacency` (`02`): both
keep the FK and the adjacency index in lockstep. `prefixGraph` does it under
mutation; `buildAdjacency` does it from scratch.

```
  prefixGraph keeps all references consistent (the merge invariant)

  before (tile-local):   "n0" ──edge e0──► "n1"      adjacency: n0→[e0]
        │ prefix "view:"
        ▼
  after (namespaced):  "view:n0" ──edge view:e0──► "view:n1"
                       adjacency: view:n0 → [view:e0]
  PK, FK, and index all carry the prefix → no dangling references
```

**`mergeGraphs` — assume namespaced, just union.** Once tiles are prefixed,
merging is a plain union — no collision handling needed, because the prefixes
already guarantee disjoint key spaces:

```ts
// features/map/tiles.ts:89-108 (trimmed)
export function mergeGraphs(graphs: Graph[]): Graph {
  const nodes = {}; const adjacency = {}; const edges: Edge[] = [];
  for (const g of graphs) {
    Object.assign(nodes, g.nodes);       // safe ONLY because keys are prefixed-disjoint
    Object.assign(adjacency, g.adjacency);
    edges.push(...g.edges);
    // ...union the bbox...
  }
  return { city: "merged", bbox, nodes, edges, adjacency };
}
```

`Object.assign` is last-write-wins on key collision — so this is *correct only
because* `prefixGraph` ran first and made collisions impossible. The two
functions are a contract: prefix, then merge. Skip the prefix and `merge` would
silently clobber `n0` from tile B over `n0` from tile A.

**`stitchGraph` — the deliberate re-connection.** Prefixing makes tiles disjoint
— which is *too* disjoint: two tiles that physically share a boundary node now
have two differently-prefixed ids for the same point, so routing can't cross the
seam. `stitchGraph` (`tiles.ts:45-86`) finds nodes at the same coordinate
(rounded to 6 decimals) and adds zero-length connector edges between them:

```ts
// features/map/tiles.ts:60-83 (trimmed) — connect coincident cross-tile nodes
for (const ids of byCoord.values()) {
  if (ids.length < 2) continue;          // unique coordinate — nothing to stitch
  const a = ids[0];
  for (let i = 1; i < ids.length; i++) {
    const b = ids[i];
    edges.push({ id: `stitch${n++}`, fromNode: a, toNode: b,
                 lengthM: 0, riseM: 0, gradePct: 0, absGradePct: 0, ... });
    (adjacency[a] ??= []).push(id);      // and keep adjacency in sync (both ends)
    (adjacency[b] ??= []).push(id);
  }
}
```

So the data-modeling arc of a merge is: **prefix to make ids disjoint → union →
stitch to re-link the points that should be the same.** The id namespacing is
what makes the first two safe; the stitch is what fixes the over-disjointness the
prefix introduced.

### Move 2 variant — the load-bearing skeleton

The kernel of "merge independently-keyed graphs": **namespace every id and every
reference, then union, then re-link coincident points.**

- *Skip the prefix* → `n0` from two tiles collide; `Object.assign` clobbers one;
  edges dangle or point at the wrong node. The merge silently corrupts.
- *Prefix the PKs but not the FKs (③)* → every edge dangles in the merged graph
  — the exact integrity failure `04` describes, but self-inflicted.
- *Prefix but don't stitch* → routing can't cross tile seams (the file's own
  comment, `tiles.ts:2-3`, flags this). Correctness-of-coverage, not corruption.

Skeleton = "prefix PK + FK + index together." Hardening = the stitch (coverage)
and the bbox union (display extent).

### Move 3 — the principle

Re-keying a primary key is only safe if you re-key every reference to it in the
same operation. flattr's `prefixGraph` does the graph version of `UPDATE ...
CASCADE` — PK, FK, and the materialized index all move under one prefix pass. The
general lesson: an id is never *just* a PK; it's a PK plus every FK and index
entry that names it, and a re-key that touches one without the others is a
dangling-reference bug waiting in the merged data.

---

## Primary diagram

The full merge pipeline: prefix → union → stitch, with what each step keeps
consistent.

```
  Merge pipeline — id namespacing keeps relations intact across tiles

  tile A (n0,e0…)          tile B (n0,e0…)        ← same local key space (collide)
       │ prefixGraph("view")     │ prefixGraph("corridor")
       │  re-keys PK + FK +      │   (tiles.ts:21-38)
       │  adjacency keys+values  │
       ▼                         ▼
  view:n0, view:e0…        corridor:n0…           ← disjoint key spaces
       └────────► mergeGraphs (Object.assign) ◄────┘   (tiles.ts:89)
                       │ safe BECAUSE prefixed
                       ▼
              merged graph (city "merged")
                       │ stitchGraph (tiles.ts:45)
                       ▼
       zero-length connector edges join coincident
       cross-tile nodes → routing crosses seams
       (adjacency updated for both ends — stays consistent)
```

---

## Elaborate

ID namespacing on merge is the same move as table-prefixing in a shared
database, tenant-prefixed keys in a multi-tenant KV store, or
`source_system + native_id` composite keys in a data warehouse — anywhere two
independently-keyed sources combine into one key space. The flattr-specific
wrinkle is that the "rows" are graph nodes with FKs *and* a materialized
adjacency index, so the re-key has to touch four places, not one — which is
exactly why it's worth studying as a data-modeling pattern: it makes the
"a PK has more references than you think" lesson concrete. The stitch step is the
inverse concern — having made everything disjoint, you have to deliberately
re-introduce the few identities you actually wanted shared.

Cross-link: *why* tiles are built independently and merged (the fetch pump,
rate-limit budget, corridor-vs-viewport priority) is architecture →
`study-system-design`. Here we care only that the merge keeps ids and references
consistent.

---

## Interview defense

**Q: You merge independently-built graphs. How do you avoid id collisions?**
Each tile is built with its own local ids (`n0, e0…`), so every tile collides on
every id. `prefixGraph` (`tiles.ts:21`) namespaces them — and the key detail is
it re-keys *four* things together: the node PK and embedded `node.id`, the edge
PK, the edge FKs (`fromNode`/`toNode`), and both the keys and values of
`adjacency`. Then `mergeGraphs` is a plain `Object.assign` union, safe *only
because* prefixing made the key spaces disjoint.

```
  prefix PK + FK + adjacency(keys+values) together
  → Object.assign union is then collision-free
```
Anchor: "an id is a PK plus every FK and index entry that names it — re-key all
of them in one pass, like UPDATE CASCADE."

**Q: After prefixing, how does routing cross a tile boundary?**
Prefixing makes coincident boundary nodes *too* disjoint — same coordinate, two
different prefixed ids. `stitchGraph` (`tiles.ts:45`) finds nodes at the same
rounded coordinate and inserts zero-length connector edges, updating adjacency on
both ends. So the merge is: prefix to disjoin, union, then stitch back the points
that should've been one.

```
  view:n0  ──stitch (0-length edge)──►  corridor:n3   (same coordinate)
  routing now crosses the seam
```
Anchor: "prefix over-disjoins; stitch re-links the coincident points — the
zero-length connector is the seam-crossing edge."

---

## See also

- `01-graph-as-entity-model.md` — the FK + adjacency relations that prefixGraph re-keys
- `02-derived-and-denormalized-fields.md` — adjacency consistency, kept here under mutation
- `04-integrity-without-a-database.md` — the dangling-FK failure prefixGraph avoids by re-keying FKs
- `03-indexes-vs-query-patterns.md` — merging grows N, pressuring the un-indexed `nearestNode`
- `study-system-design` — the fetch pump, tiling, and rate-limit budget behind the merge
