# Tile merge + stitch

**Industry names:** graph composition / namespaced merge / boundary stitching /
spatial tile assembly. **Type:** Project-specific.

---

## Zoom out, then zoom in

The base artifact and each on-device build are *independent* graphs with their own
node ids. Drop them in one bag and two problems appear: ids collide (two tiles both
have a node `"42"`), and a road that crosses a tile boundary is split into two
disconnected halves. Merge + stitch fixes both, so routing crosses seams that were
built separately.

```
  Zoom out — merge+stitch sits between the builds and the router

  ┌─ RUNTIME (phone) ───────────────────────────────────────────┐
  │  baseGraph        corridor build       viewport build        │
  │      └──────┬──────────┴──────────┬───────┘                  │
  │             ▼ prefixGraph (namespace ids)                    │
  │     ★ mergeGraphs([...]) → stitchGraph ★  ← we are here      │
  │             ▼ one connected, collision-free graph            │
  │          directedAstar(graph, start, end, userMax)           │
  └──────────────────────────────────────────────────────────────┘
```

You've merged two arrays of records with overlapping ids and had to re-key one side
to avoid clobbering — same instinct. Here it's three steps: prefix every id with its
source (`base:`, `corridor:`, `view:`), union the maps, then add zero-length
connector edges between nodes that sit at the *same coordinate* but got different
prefixed ids. The question it answers: *how do independently-built regions become
one routable graph?*

---

## The structure pass

**Layers:** per-region graph → prefixed graph → merged graph → stitched graph.

**Axis = connectivity (can the router walk from any node to any other?).**

```
  One question down the layers: "is the graph connected across regions?"

  ┌───────────────────────────────────┐
  │ per-region builds                 │  → connected WITHIN a region only
  └───────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ prefixGraph + mergeGraphs       │  → coexist, but still DISconnected
      └─────────────────────────────────┘     (boundary nodes have different ids)
          ┌─────────────────────────────┐
          │ stitchGraph                 │  → CONNECTED (coincident nodes linked)
          └─────────────────────────────┘

  connectivity flips only at stitch — merge alone is not enough
```

**Seam = `stitchGraph`.** This is where the connectivity axis flips. Before it,
the merged graph *looks* whole but a route from base into a corridor tile fails —
the boundary node exists twice under two ids with no edge between them. The original
`tiles.ts:1` header even admits the earlier state: *"Tiles don't share boundary
nodes, so routing won't cross seams yet."* Stitch is the line that closed that gap.

---

## How it works

#### Move 1 — the mental model

Three pure transforms in sequence. Namespace (avoid id collisions) → union (one bag)
→ bridge (connect coincident boundary nodes with zero-cost edges).

```
  Pattern — prefix · merge · stitch

  region A {1,2,3}   region B {1,2,3}      ← same ids, would collide
        │ prefixGraph        │ prefixGraph
        ▼                    ▼
  {A:1,A:2,A:3}        {B:1,B:2,B:3}        ← namespaced, no collision
        └────────┬───────────┘ mergeGraphs
                 ▼
  {A:1,A:2,A:3,B:1,B:2,B:3}                 ← merged, but A:3 & B:1 may be the
                 │ stitchGraph                 SAME point with no edge between them
                 ▼
  ... + zero-length edge (A:3 ↔ B:1) where coords coincide  ← now routable
```

#### Move 2 — the walkthrough

**Prefix namespaces every id so merges can't collide.** Re-key nodes, edges, *and*
adjacency references:

```ts
// features/map/tiles.ts:21 — prefixGraph: "prefix:" on every id and reference
const p = (id: string) => `${prefix}:${id}`;
nodes[p(id)] = { ...graph.nodes[id], id: p(id) };          // node ids
edges = graph.edges.map((e) => ({ ...e, id: p(e.id),
  fromNode: p(e.fromNode), toNode: p(e.toNode) }));         // edge endpoints too
adjacency[p(id)] = graph.adjacency[id].map(p);              // and adjacency keys+values
```
What breaks if you skip prefixing the *references* (fromNode/toNode/adjacency
values), not just the keys: edges point at the old un-prefixed ids and the graph is
silently broken. Every reference has to move together. The prefix is set at build
time per region — `prefixGraph(g, kind)` where `kind` is `"corridor"` or `"view"`
(`useTileGraph.ts:198`), and `"base"` for the bundled graph (`MapScreen.tsx:30`).

**Merge unions the maps and the bbox.** Plain `Object.assign` works *because* prefix
already guaranteed no key collisions:

```ts
// features/map/tiles.ts:89 — mergeGraphs: union nodes/adjacency/edges, union bbox
for (const g of graphs) {
  Object.assign(nodes, g.nodes);        // safe: ids are namespaced
  Object.assign(adjacency, g.adjacency);
  edges.push(...g.edges);
  bbox = bbox ? [min, min, max, max] : [...g.bbox];   // grow the covered box
}
```

**Stitch is the load-bearing step — it restores connectivity.** Group nodes by
6-decimal coordinate; any coordinate shared by ≥2 nodes (from different tiles) gets
zero-length connector edges:

```ts
// features/map/tiles.ts:45 — stitchGraph: bridge coincident boundary nodes
const coordKey = (n) => `${n.lat.toFixed(6)},${n.lng.toFixed(6)}`;
// ...group ids by coordKey...
for (const ids of byCoord.values()) {
  if (ids.length < 2) continue;                 // unique point → nothing to stitch
  for (let i = 1; i < ids.length; i++) {
    edges.push({ id: `stitch${n++}`, fromNode: ids[0], toNode: ids[i],
      lengthM: 0, riseM: 0, gradePct: 0, absGradePct: 0, kind: "footway" });  // zero cost
    adjacency[ids[0]].push(id);  adjacency[ids[i]].push(id);
  }
}
```
What breaks without stitch: a route from the base area into a freshly-loaded
corridor tile returns "no route" even though the roads visibly touch — the boundary
node exists as `base:X` and `corridor:Y` with no edge between them. The connector's
`lengthM: 0` and `gradePct: 0` mean it costs nothing to traverse, so it never
distorts the route — it's pure connectivity glue.

**Where it all fires: two `useMemo`s, two graphs.** The merge runs twice with
different inclusion rules:

```ts
// mobile/src/useTileGraph.ts:132 — routing graph: include EVERYTHING (even degraded)
graph = stitchGraph(mergeGraphs([baseGraph, ...corridor, ...view]));
// :150 — display graph: EXCLUDE degraded regions (bogus flat grades shouldn't paint)
displayGraph = stitchGraph(mergeGraphs([base, ...(!corridor.degraded && corridor), ...]));
```
Same merge+stitch machinery, two policies: routing favors connectivity (flat grades
still connect), display favors honesty (→ `04-honest-fallback-routing.md`).

The hops, drawn:

```
  Layers-and-hops — three regions to one graph

  ┌─ base (artifact) ─┐  ┐
  │ base:* ids        │  │
  └───────────────────┘  │  hop 1: prefixGraph (namespace)
  ┌─ corridor (built) ┐  ├──────────────────────────► mergeGraphs (union)
  │ corridor:* ids    │  │                                   │
  └───────────────────┘  │                          hop 2: stitchGraph
  ┌─ view (built) ────┐  │                          (zero-len edges at
  │ view:* ids        │  ┘                           coincident coords)
  └───────────────────┘                                      │
                                                             ▼
                                              one connected graph → directedAstar
```

#### Move 3 — the principle

Composing independently-built data requires both **namespacing** (so ids don't
collide) and **bridging** (so logically-adjacent things are physically linked).
Merge handles the first; it's tempting to stop there because the result *looks*
whole. Stitch handles the second — and connectivity is exactly the property that
doesn't survive a naive union. Whenever you assemble a graph from separately-built
pieces, the boundary-stitching step is the one people forget.

---

## Primary diagram

```
  Tile merge + stitch — full pattern

  baseGraph ──prefixGraph("base")──┐
  corridor  ──prefixGraph("corridor")──┤
  view      ──prefixGraph("view")──────┤
                                       ▼
                               mergeGraphs([...])
                               · Object.assign nodes/adjacency
                               · concat edges
                               · union bbox
                                       │  (collision-free, but seams disconnected)
                                       ▼
                               stitchGraph
                               · group nodes by 6-dp coordinate
                               · ≥2 at a point → zero-length connector edge
                                       │
                                       ▼
                          one connected graph ── directedAstar / heatmap / zones
```

---

## Elaborate

This is the spatial-data version of module namespacing + a join. The prefix is
exactly how bundlers avoid symbol collisions across modules; the stitch is a spatial
join on coordinate equality. The 6-decimal `toFixed(6)` is the tolerance — ~0.1 m,
fine because `split.ts` snaps shared OSM vertices to identical coordinates upstream
(`split.ts:8`), so genuinely-coincident boundary nodes really do match to the
decimal.

The merge feeds the router (`06-parametric-search-engine.md`) and the display
(heatmap/zones). The two-graph split (routing-includes-degraded vs
display-excludes-degraded) is the seam into `04-honest-fallback-routing.md`.

Graph-traversal mechanics (BFS/adjacency, why connectivity matters for A*) →
`study-dsa-foundations`. The schema of `Node`/`Edge` →
`study-data-modeling`.

---

## Interview defense

**Q: Why isn't `mergeGraphs` enough — why a separate stitch step?**
Merge gives you collision-free coexistence, but two tiles built independently don't
share node *objects* — the road crossing their boundary is two halves with different
prefixed ids and no edge between them. Routing returns "no route" across a seam that
visibly connects. Stitch adds zero-length connector edges at coincident coordinates
to restore connectivity.

```
  merge only:  base:X ●     ● corridor:Y   (same point, no edge → unroutable)
  + stitch:    base:X ●━━━━━● corridor:Y   (zero-cost connector → routable)
```
Anchor: merge namespaces; stitch reconnects. Connectivity is the property a union
loses.

**Q: Won't the zero-length edges distort routes?**
No — `lengthM`, `riseM`, `gradePct`, `absGradePct` are all 0 (`tiles.ts:67`), so the
cost function adds nothing. They're connectivity glue, invisible to cost.
Anchor: zero-cost connector = pure topology, no distortion.

**Q: Why merge twice (routing vs display)?**
Routing includes degraded (flat-grade) regions because flat grades still connect —
excluding them would re-break "no route." Display excludes them so bogus all-green
doesn't paint over real grades. Same machinery, two policies (`useTileGraph.ts:132`
vs `:150`).
Anchor: connectivity for routing, honesty for display.

---

## See also

- `02-on-device-pipeline-rerun.md` — produces the regions this merges.
- `04-honest-fallback-routing.md` — why routing and display graphs differ.
- `06-parametric-search-engine.md` — consumes the stitched graph.
- `audit.md` lenses 2, 4 — data flow, the coverage-as-cache check.
</content>
