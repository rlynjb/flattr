# 04 — Tile / Merge / Stitch (graph composition)

*Industry names: spatial tiling · graph union with namespacing · seam stitching.
Type: Project-specific (a classic mesh-construction problem applied to live
graph composition).*

---

## Zoom out, then zoom in

You've merged data from multiple sources before — three API responses combined
into one list, deduped by id. The hard part is always collisions: two sources
with the same id meaning different things. flattr has the same problem but with
*graphs*: the bundled base graph, a freshly built viewport graph, and a route
corridor graph all need to become one graph the router can traverse — and
they're built independently, so their node ids collide and their boundaries
don't connect.

Here's where composition sits — between the regions (built or bundled) and the
single graph everything downstream uses:

```
  Zoom out — composition between regions and the live graph

  ┌─ REGIONS (independently built) ──────────────────────────────┐
  │  base graph   ·   viewport graph   ·   corridor graph         │
  └─────────────────────────────┬───────────────────────────────┘
                                │  ★ prefix → merge → stitch ★
  ┌─ THE LIVE GRAPH (useMemo) ───▼───────────────────────────────┐
  │  one routable Graph — heatmap, zones, A* all read this        │ ← we are here
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **namespaced union plus seam stitching**. The question
it answers is *"how do you combine independently built graph regions into one
graph without id collisions and without disconnecting at the boundaries?"* Three
operations in a fixed order do it: `prefixGraph` (avoid id collisions),
`mergeGraphs` (union), `stitchGraph` (reconnect coincident boundary nodes). Get
the order or any one operation wrong and routing either crashes on a duplicate id
or silently fails with "no route" across a seam.

---

## Structure pass

**Layers.** Three operations, applied in order, each fixing what the previous
left open:

```
  prefixGraph   — namespace every id ("base:n3", "view:n3") so merge is safe
  mergeGraphs   — union nodes/edges/adjacency; union the bbox
  stitchGraph   — add zero-length connectors between same-coordinate nodes
```

**Axis — connectivity (can the router get from any node to any reachable node?).**

| After... | Are regions internally connected? | Are regions connected *to each other*? |
|---|---|---|
| `prefixGraph` | yes (within a region) | no |
| `mergeGraphs` | yes | **no** — same corner, different prefixed ids |
| `stitchGraph` | yes | **yes** — connectors bridge coincident nodes |

That's the whole story in one column: merge alone gives you a graph that *looks*
combined but is actually several disconnected islands. The connectivity axis
only flips to fully-connected after stitch. Skip stitch and a route from the
base region into the corridor region returns `null` — "no route" — even though
the line is right there on screen.

**Seams (literal and figurative).** The figurative seam is the boundary between
two regions; the literal fix is `stitchGraph`'s connector edges. This is the rare
case where the architectural "seam" and the domain "seam" are the same thing —
the connectors are the contract that lets one region's traversal continue into
another's.

---

## How it works

### Move 1 — the mental model

Think of three puzzle pieces cut from the same map. Each piece is internally
complete, but laid side by side they don't *connect* — the road that crosses the
cut is two separate road-ends, one per piece. Composition is: relabel each
piece's pieces so they don't share names by accident (prefix), put them in one
box (merge), then tape the matching road-ends together at the cuts (stitch).

```
  Pattern — prefix, merge, stitch

  base:    n0─n1─n2*         *  = a node at coordinate (47.62, -122.32)
  view:        *n0─n1─n2     †  = the SAME coordinate, different prefixed id

  prefix   base:n0─n1─n2*    view:n0†─n1─n2     (ids can't collide now)
  merge    { base:n0..., view:n0†... }          (one bag, still 2 islands)
  stitch   base:n2* ══0══ view:n0†               (zero-length connector edge)
                    │
                    └─ now traversal crosses from base into view
```

### Move 2 — the walkthrough

#### prefixGraph — make ids collision-proof

Each region is built by its own pipeline run, and every run numbers its nodes
`n0, n1, ...` and edges `e0, e1, ...` from zero. So the base graph and the
viewport graph both contain a node called `n0` that mean *different places*.
Prefix every id with the region name — `base:n0`, `view:n0` — and that's
impossible.

```
  prefixGraph(graph, "view"):
    for each node id:  rename to "view:" + id      (and node.id field)
    for each edge:     rename id, fromNode, toNode  (rewrite the references too)
    for each adjacency key: rename key AND every edge id in its list
```

The boundary case that bites if you're sloppy: you must rewrite **the references,
not just the keys**. An edge's `fromNode`/`toNode` and every id inside an
adjacency list also need the prefix — rename only the top-level keys and the edge
now points at a node id that doesn't exist. This is why `prefixGraph` walks all
three structures.

#### mergeGraphs — union into one graph

Once ids are namespaced, merging is a shallow union: `Object.assign` the node
maps and adjacency maps, concat the edge arrays, and union the bboxes (min of
mins, max of maxes). No conflict resolution needed *because* prefixing already
guaranteed no key collides.

```
  mergeGraphs([g1, g2, ...]):
    for each g:
      assign g.nodes into combined nodes        (prefix guarantees no overwrite)
      assign g.adjacency into combined adjacency
      push g.edges into combined edges
      bbox = union(bbox, g.bbox)
    return { city:"merged", bbox, nodes, edges, adjacency }
```

The boundary case (and a real red flag): `Object.assign` is **last-write-wins**.
If two graphs *did* share an id, the second silently clobbers the first — no
error. The entire safety of merge rests on prefixing having happened first. Miss
a `prefixGraph` call upstream and you get silent data loss, not a crash. → audit
§8.5.

#### stitchGraph — reconnect the seams

After merge, the graph is a bag of disconnected regions. A node at coordinate
`(47.62, -122.32)` in the base region and a node at the *same coordinate* in the
viewport region are now `base:n2` and `view:n0` — different ids, no edge between
them, so the router can't step from one to the other. Stitch finds every group
of nodes that share a coordinate and adds a **zero-length connector edge**
between them.

```
  stitchGraph(graph):
    group node ids by coordinate (lat/lng rounded to 6 decimals)
    for each group with >= 2 nodes:
      for each extra node in the group:
        add a zero-length edge (length 0, grade 0) linking it to the first
        add that edge to both nodes' adjacency lists
```

```
  Pattern — stitching coincident nodes

  group at (47.62, -122.32): [ base:n2, view:n0 ]
                                 │         │
                                 └──0m─────┘   ← connector: lengthM=0, gradePct=0
                                 now adjacency[base:n2] and adjacency[view:n0]
                                 both include the connector ⇒ A* can cross
```

The boundary case: the connector must be **zero length and zero grade**, so it
costs nothing to traverse and never shows up as a steep segment. It's a pure
connectivity bridge, not a real edge. And the coordinate match is *exact* (to 6
decimals) — two nodes that are "close but not identical" won't stitch, which is
why the upstream builds must produce identical coordinates at shared boundaries
(they do, because OSM vertices are shared and the snap in `split.ts` is
deterministic).

#### The order is the invariant

These three run in exactly one order, and the order is load-bearing:

```
  Layers-and-hops — composition order (in useTileGraph's useMemo)

  ┌─ regions ──────┐  hop 1: prefix each   ┌─ namespaced ─┐
  │ base/view/corr │ ────────────────────► │ no id clash  │
  └────────────────┘                       └──────┬───────┘
                          hop 2: merge (union)      │
                          ┌──────────────────◄──────┘
                          ▼
                   ┌─ merged bag ─┐  hop 3: stitch seams  ┌─ routable ─┐
                   │ disconnected │ ────────────────────► │ connected  │
                   └──────────────┘                       └────────────┘
```

Prefix before merge (else collisions), merge before stitch (else nothing to
stitch across). Note the base graph is prefixed *once* at load
(`MapScreen.tsx:30`) while view/corridor are prefixed at build time
(`useTileGraph.ts:113`); the `useMemo` then merges and stitches all of them on
every change.

### Move 3 — the principle

Combining independently built data structures is a two-part problem: avoid
identity collisions (namespacing) and restore the connections the split severed
(stitching). The union in the middle is the easy part; the prefix before it and
the stitch after it are where correctness lives. Whenever you merge graphs,
documents, or scopes built in isolation, ask both questions — *do ids collide?*
and *what edges did the boundary cut?*

---

## Primary diagram

The whole composition, one frame, as it runs in `useTileGraph`'s `useMemo`.

```
  Tile / merge / stitch — full recap

  ┌─ base (bundled) ──┐  ┌─ view (built on pan) ─┐  ┌─ corridor (built on route) ─┐
  │ prefix "base"     │  │ prefix "view"         │  │ prefix "corridor"           │
  └─────────┬─────────┘  └──────────┬────────────┘  └──────────────┬──────────────┘
            └─────────────────┬─────┴──────────────────────────────┘
                              ▼
                   mergeGraphs([...])           ← Object.assign union, last-write-wins
                              │                    (safe ONLY because prefixed)
                              ▼
                   bag of disconnected regions
                              │
                              ▼
                   stitchGraph(...)             ← zero-length connectors between
                              │                    same-coordinate nodes
                              ▼
                   one routable Graph ──► directedAstar / heatmap / zones
```

---

## Implementation in codebase

**Use cases.** Composition runs on every change to coverage: the moment a
viewport build finishes (pan), the moment a corridor build finishes (route), and
at startup with just the base graph. It's what lets a route from inside the
bundled bbox continue into a freshly built corridor — without stitch, those two
regions are separate islands and the route returns "no route."

**The composition pipeline — `mobile/src/useTileGraph.ts` (lines 72-85).**

```
  const graph = useMemo(
    () => baseGraph
      ? stitchGraph(                              ← step 3: reconnect seams
          mergeGraphs([                           ← step 2: union
            baseGraph,                            (already prefixed "base" at load)
            ...(corridor ? [corridor.graph] : []),(prefixed "corridor" at build)
            ...(view ? [view.graph] : []),        (prefixed "view" at build)
          ])
        )
      : null,
    [baseGraph, corridor, view]                   ← recompute on any region change
  );
       │
       └─ the fixed order prefix→merge→stitch IS the invariant. The prefixes were
          applied earlier (load + build); this memo does merge then stitch.
```

**prefixGraph — namespacing — `features/map/tiles.ts` (lines 21-38).**

```
  export function prefixGraph(graph, prefix): Graph {
    const p = (id) => `${prefix}:${id}`;
    for (const id of keys(graph.nodes))
      nodes[p(id)] = { ...graph.nodes[id], id: p(id) };       ← rename key AND .id field
    edges = graph.edges.map(e => ({ ...e, id: p(e.id),
      fromNode: p(e.fromNode), toNode: p(e.toNode) }));        ← rename the REFERENCES too
    for (const id of keys(graph.adjacency))
      adjacency[p(id)] = graph.adjacency[id].map(p);           ← rename key AND every listed edge id
    return { ...graph, nodes, edges, adjacency };
  }
       │
       └─ rewriting fromNode/toNode and the adjacency edge-id lists is the part
          people forget. Miss it and edges point at nonexistent ids.
```

**mergeGraphs — union — `features/map/tiles.ts` (lines 89-108).**

```
  export function mergeGraphs(graphs): Graph {
    for (const g of graphs) {
      Object.assign(nodes, g.nodes);          ← LAST-WRITE-WINS (safe only if prefixed)
      Object.assign(adjacency, g.adjacency);
      edges.push(...g.edges);
      bbox = bbox ? [min, min, max, max] : [...g.bbox];   ← union the bbox
    }
    return { city: "merged", bbox, nodes, edges, adjacency };
  }
       │
       └─ no collision handling by design — prefixGraph upstream is the guarantee.
          This is audit §8.5: the safety is implicit in call order.
```

**stitchGraph — reconnect — `features/map/tiles.ts` (lines 45-86).**

```
  export function stitchGraph(graph): Graph {
    const coordKey = (n) => `${n.lat.toFixed(6)},${n.lng.toFixed(6)}`;  ← exact-coord group
    group node ids by coordKey;
    for (const ids of groups) {
      if (ids.length < 2) continue;                  ← unique coord: nothing to stitch
      const a = ids[0];
      for (let i = 1; i < ids.length; i++) {
        const b = ids[i];
        edges.push({ id:`stitch${n++}`, fromNode:a, toNode:b,
          lengthM:0, riseM:0, gradePct:0, absGradePct:0, kind:"footway" }); ← zero-cost bridge
        adjacency[a].push(id); adjacency[b].push(id); ← make it traversable both ways
      }
    }
    return { ...graph, edges, adjacency };
  }
       │
       └─ lengthM:0, gradePct:0 means the connector is free to cross and never
          flagged steep. The 6-decimal coordKey requires EXACT coincidence —
          which the deterministic snap in split.ts guarantees at shared OSM vertices.
```

Note `tiles.ts:1-3` carries a stale comment ("Tiles don't share boundary nodes,
so routing won't cross seams yet") that predates `stitchGraph` — the stitch
function below it is exactly what now makes routing cross seams. A small doc
drift worth fixing.

---

## Elaborate

This is the classic **mesh-construction / graph-merge** problem the spec calls
out directly (§14.3: "Snap coincident vertices ... or you get a disconnected
graph — classic mesh-construction bug"). It's the same shape as merging two
scene graphs, combining shards of a distributed index, or unioning CRDT
documents: namespace to avoid identity clashes, then reconcile the references
that cross the boundary. The zero-length connector trick — bridging "the same
point known by two names" with a free edge — is a standard way to glue graphs
without rewriting every reference to a canonical id.

The reason flattr needs it at *runtime* (not just build) is the on-device
pipeline (`03-on-device-pipeline.md`): regions are built independently and
on-demand, so they can't be pre-stitched offline. If the system migrated to
served prebuilt tiles (spec §11 D/E), the tiles could share canonical boundary
node ids and stitch could become unnecessary — another piece of the runtime that
the Phase A migration would simplify.

The one fragility (audit §8.5): merge's safety is *implicit in call order*, not
enforced. A type or a runtime guard that refused to merge two graphs sharing any
id would make the contract explicit. It's not built because the only callers
prefix correctly — but it's the kind of implicit invariant that breaks when a
third caller appears.

Read next: `05-honest-fallback-routing.md` — once the graph is composed, what A\*
does when the only path across a seam is too steep, versus genuinely
disconnected.

---

## Interview defense

**Q: I route from the bundled area into a freshly loaded area and get "no
route." Why, and how is it fixed?**
> Because the two regions were built independently and merged, but the node where
> they meet exists twice — once per region, with different prefixed ids and no
> edge between them. Merge unions the data but doesn't connect the seam, so A\*
> hits a dead end. `stitchGraph` fixes it: it groups nodes by exact coordinate
> and adds a zero-length, zero-grade connector edge between coincident nodes, so
> the router can step across. The connector is free, so it never shows as a steep
> segment.

```
  base:n2 (47.62,-122.32)   view:n0 (47.62,-122.32)
        │ merge: two ids, no edge ─► A* dead-ends
        └── stitch: ══0m══ connector ─► A* crosses
```

**Q: Why prefix ids at all — why not merge directly?**
> Every region's build numbers nodes from `n0`. The base graph's `n0` and the
> viewport's `n0` are different places. Merge uses `Object.assign`, which is
> last-write-wins — without prefixing, the second region silently overwrites the
> first's nodes. Prefixing (`base:n0`, `view:n0`) makes collisions impossible, so
> the union is safe. The catch is that the safety lives in call order, not in a
> guard — that's a known fragility.

```
  no prefix: base:n0 ⨯ view:n0 ─► Object.assign clobbers (silent data loss)
  prefix:    base:n0 ✓ view:n0 ─► no clash ─► union safe
```

**Q: What's the load-bearing part people forget?**
> Two: in `prefixGraph`, rewriting the *references* — `fromNode`, `toNode`, and
> the edge ids inside adjacency lists — not just the top-level keys. Miss that and
> edges point at ids that no longer exist. And `stitchGraph`'s connector being
> *zero* length/grade — make it nonzero and it'd register as a real (possibly
> steep) segment and distort routes at every seam.

```
  prefix: rename keys AND fromNode/toNode AND adjacency edge-ids
  stitch: connector must be lengthM=0, gradePct=0 (free, invisible)
```

---

## Validate

1. **Reconstruct.** Write the three-step order (prefix → merge → stitch) and say
   what each fixes (`tiles.ts:21,89,45`). Why can't the order change?
2. **Explain.** In `prefixGraph` (`tiles.ts:21-38`), which three structures get
   rewritten and why is rewriting only the node-map keys insufficient?
3. **Apply.** A viewport build and the base graph share a boundary node at
   `(47.6210, -122.3250)`. Trace it through `stitchGraph` (`tiles.ts:45-86`):
   what coordKey group does it land in, and what edge gets added?
4. **Defend.** `mergeGraphs` (`tiles.ts:94-97`) has no collision handling.
   Defend why that's safe today and name the exact condition under which it
   becomes a silent data-loss bug (`audit.md` §8.5).

---

## See also

- `03-on-device-pipeline.md` — why regions are built independently at runtime.
- `05-honest-fallback-routing.md` — what A\* returns across (or failing to cross)
  a seam.
- `02-bundled-graph-artifact.md` — `prefixGraph("base")` on the bundled graph.
- `audit.md` §2 (data flow), §8.5 (merge collision red flag).
- `.aipe/study-dsa-foundations/` — A\* adjacency traversal over the merged graph.
