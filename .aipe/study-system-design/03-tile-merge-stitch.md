# Tile Merge & Stitch

**Industry names:** graph composition / namespacing + union / spatial seam
stitching. **Type:** Project-specific (composing independently-built graph
tiles into one routable graph).

---

## Zoom out, then zoom in

The on-device re-run (`02-on-device-pipeline-rerun.md`) hands you a *separate*
graph for each area — the base, a corridor, a viewport — each built in its own
`buildGraph` call. But A* needs **one** connected graph to route over. If you
just dumped them into one object, two problems hit immediately: the ids collide
(every build numbers edges `e0, e1, ...`), and the tiles don't actually
*connect* — a node at the shared edge of two tiles is two separate nodes with
the same coordinates. This pattern fixes both.

```
  Zoom out — where tile algebra lives

  ┌─ RUNTIME (Expo RN) ──────────────────────────────────────────────────┐
  │  base graph   corridor graph   viewport graph   (3 separate builds)   │
  │      │              │                │                                 │
  │      └──────────────┴────────────────┘                                │
  │                     ▼                                                  │
  │  ★ features/map/tiles.ts ★  ← THIS CONCEPT                            │ ← here
  │   prefixGraph (namespace) → mergeGraphs (union) → stitchGraph (join)  │
  │                     │                                                  │
  │                     ▼                                                  │
  │         ONE routable graph → directedAstar(...)                       │
  └────────────────────────────────────────────────────────────────────── ┘
```

Zoom in: the concept is **composing independently-built graph tiles into a
single connected graph the router can cross.** The question it answers: *how do
separately-built pieces become one thing A* can traverse end to end?*

## Structure pass

**Layers.** One module, three pure functions that run in sequence:
`prefixGraph` → `mergeGraphs` → `stitchGraph`. Each is a layer of the
composition.

**Axis — `dependency` (do the tiles reference each other?).** Trace whether the
graphs are connected as you move through the three functions:

```
  "are the tiles connected into one routable graph?" — across the 3 steps

  ┌──────────────────────────────────┐
  │ after prefixGraph                 │  → still 3 ISLANDS, ids now unique
  └──────────────────────────────────┘
        │  mergeGraphs (union into one object)
        ▼
  ┌──────────────────────────────────┐
  │ after mergeGraphs                 │  → 1 object, but STILL 3 islands
  └──────────────────────────────────┘  (no edges cross tile boundaries!)
        │  stitchGraph (add zero-cost connectors)
        ▼
  ┌──────────────────────────────────┐
  │ after stitchGraph                 │  → 1 CONNECTED graph, A* can cross
  └──────────────────────────────────┘
```

**Seam.** The tile boundary itself. The whole point of `stitchGraph` is that
the coincident nodes at a shared boundary are the seam — and without an explicit
connector edge there, A* can't get from one tile to the next. `stitchGraph` is
the code that turns a geographic seam into a graph edge.

## How it works

### Move 1 — the mental model

You've merged objects before — `Object.assign(target, a, b)`. The catch with
graphs is that merging the *data* doesn't merge the *connectivity*. Picture two
puzzle pieces with the same edge: laying them next to each other doesn't fuse
them; you need glue along the shared edge. Here the "glue" is zero-cost edges
between nodes that sit at the exact same coordinate in different tiles.

The strategy in one sentence: **namespace ids so they don't collide, union the
records, then add zero-cost edges at coincident coordinates so the router can
cross.**

```
  The pattern — namespace, union, stitch

   tile A: e0,e1  n0,n1          tile B: e0,e1  n0,n1   ← id collision!
        │ prefixGraph("base")         │ prefixGraph("view")
        ▼                             ▼
   base:e0  base:n0 ...          view:e0  view:n0 ...   ← unique now
        └──────────── mergeGraphs ────────────┘
                        ▼
          one object, two islands (no crossing edges)
                        │ stitchGraph
                        ▼
        base:n7 ●═══0-cost═══● view:n3   ← same lat/lng, now joined
                  A* can cross here
```

### Move 2 — the walkthrough

**Step 1 — `prefixGraph`: namespace every id.** Each build numbers its
edges/nodes from scratch, so they collide on merge. `prefixGraph` rewrites every
id with a tile prefix:

```ts
// features/map/tiles.ts:21-38 (prefixGraph)
const p = (id: string) => `${prefix}:${id}`;          // 22: "base:n0", "view:n0"
// re-key nodes (23-26), edges' id/fromNode/toNode (27-32),
// and the adjacency map's keys + values (33-36)
```

After this, `base:n0` and `view:n0` are distinct even though both were `n0`. The
prefix comes from the build kind — `"base"` (`MapScreen.tsx:30`), `"corridor"`,
`"view"` (`useTileGraph.ts:198`).

**Step 2 — `mergeGraphs`: union the records.** Pure object merge — concatenate
edges, assign node/adjacency maps, union the bboxes:

```ts
// features/map/tiles.ts:89-108 (mergeGraphs)
Object.assign(nodes, g.nodes);          // 95: union node map
Object.assign(adjacency, g.adjacency);  // 96: union adjacency map
edges.push(...g.edges);                 // 97: concat edge array
// 98-105: bbox = min/max over all tiles
```

This is where namespacing pays off: `Object.assign` would silently overwrite on
key collision. Because step 1 made keys unique, nothing is lost. **But the
result is still disconnected** — no edge spans two tiles. That's step 3's job.

```
  Layers-and-hops — the three steps inside the merge useMemo

  ┌─ Hook: useTileGraph (useMemo, ts:132-145) ───────────────────────────┐
  │                                                                       │
  │  [baseGraph, corridor.graph, view.graph]   ← 3 prefixed tiles         │
  │            │ hop 1: mergeGraphs(parts)                                │
  │            ▼                                                          │
  │  one object, 3 islands                                               │
  │            │ hop 2: stitchGraph(merged)                              │
  │            ▼                                                          │
  │  one CONNECTED graph                                                 │
  └───────────────┬──────────────────────────────────────────────────── ┘
                  │ hop 3: returned as `graph`
                  ▼
  ┌─ Component: MapScreen ───────────────────────────────────────────────┐
  │  directedAstar(graph, startId, endId, userMax)  (MapScreen.ts:155)    │
  └────────────────────────────────────────────────────────────────────── ┘
```

**Step 3 — `stitchGraph`: join coincident nodes.** This is the load-bearing
part. Group nodes by rounded coordinate; wherever ≥2 nodes share a coordinate
(i.e., they're the same physical point in different tiles), add a zero-cost edge
between them:

```ts
// features/map/tiles.ts:45-86 (stitchGraph)
const coordKey = (n) => `${n.lat.toFixed(6)},${n.lng.toFixed(6)}`; // 46: ~0.1mm
// 47-53: build coordKey → [node ids] map
// 60-84: for each coord with 2+ nodes:
const anchor = ids[0];                              // 62: pick one as anchor
for (const other of ids.slice(1)) {
  edges.push({ id: `stitch${n++}`, fromNode: anchor, toNode: other,
               lengthM: 0, riseM: 0, gradePct: 0, absGradePct: 0,  // 67-80: zero cost
               kind: "footway" });
  // 81-82: add to adjacency BOTH directions
}
```

The stitch edge has zero length and zero grade, so crossing it costs the router
nothing — it's a pure connector. The 6-decimal coordinate key (~0.1mm) is how
"same physical point" is detected: two tiles built over the same street will
have produced nodes at identical lat/lng (because `split.ts` snaps to 7
decimals, `split.ts:9-11`), and `stitchGraph` finds them by that match.

**Why two graphs come out of the merge.** `useTileGraph` runs this twice: once
for *routing* including degraded regions (`useTileGraph.ts:132-145`) and once
for *display* excluding them (`useTileGraph.ts:150-162`). Same merge+stitch
algebra, different input set — the source-of-truth split from `audit.md` §3.

#### Move 2 variant — what breaks if you remove each step

The kernel is three operations, each guarding a distinct failure:

1. **`prefixGraph`** — remove it and `mergeGraphs`'s `Object.assign`
   (`tiles.ts:95`) silently overwrites colliding ids; the corridor's `n0`
   clobbers the base's `n0`, corrupting connectivity. *Breaks: id integrity.*
2. **`mergeGraphs`** — remove it and you have N separate graph objects; A* can
   only see whichever one you hand it. *Breaks: single-graph routing.*
3. **`stitchGraph`** — remove it and you have one object that is still N
   disconnected islands; a route from base into corridor returns "no route"
   even though the streets physically connect. *Breaks: cross-tile traversal —
   the subtle one, because the merge "looks" done.*

There is no optional hardening here; all three are load-bearing. That's the
tell that this is a real pattern, not glue code.

### Move 3 — the principle

The principle is **merging data is not merging structure.** Any time you combine
independently-built graph-shaped things — scene graphs, dependency graphs,
spatial tiles — you have to handle id collisions (namespace) *and* re-establish
the cross-piece links (stitch) separately. The stitch step is the one people
forget because the merged object looks complete; it isn't connected until you
explicitly add the boundary edges. flattr makes this safe by building the
connector detection on a coordinate match that the upstream `split.ts` snapping
guarantees.

## Primary diagram

```
  Tile merge & stitch — the full picture

  ┌─ inputs: 3 independently-built tiles ────────────────────────────────┐
  │  base (config.ts:10 bbox)   corridor (route bbox)   view (pan bbox)   │
  └───────────────────────────────┬────────────────────────────────────── ┘
                                   │ each: prefixGraph(g, kind)   ts:21-38
                                   ▼  (ids → "base:..", "view:..")
  ┌─ mergeGraphs (ts:89-108) ────────────────────────────────────────────┐
  │  Object.assign nodes+adjacency, concat edges, union bbox              │
  │  RESULT: one object, still 3 disconnected islands                    │
  └───────────────────────────────┬────────────────────────────────────── ┘
                                   │ stitchGraph (ts:45-86)
                                   ▼  group by coordKey (6-dec), zero-cost
  ┌─ one CONNECTED graph ────────────────────────────────────────────────┐
  │  base:n7 ●══0══● view:n3   (same lat/lng → stitch edge, both ways)    │
  │                              ↓                                        │
  │              directedAstar(graph, start, end, userMax)               │
  └────────────────────────────────────────────────────────────────────── ┘

  run TWICE: routing graph (incl. degraded) + display graph (excl. degraded)
```

## Elaborate

This is the same problem any tiled spatial system faces — map renderers, mesh
LOD systems, distributed graph stores all have a "seam stitching" step. The
classic bug is exactly the step-3 failure: the merge looks complete, queries
inside a tile work, and only *cross-tile* queries silently fail because the
boundary was never joined. flattr sidesteps the hardest part of stitching —
deciding which nodes are "the same" — by leaning on the build-time snapping
contract (`split.ts:9-11` snaps coordinates to 7 decimals), so coincident points
are bit-identical and a `.toFixed(6)` key catches them.

The zero-cost connector is the other clean choice: rather than re-running
intersection detection across tiles, it just adds a free edge between coincident
nodes and lets A* treat them as one. Read `02-on-device-pipeline-rerun.md` for
where the tiles come from and `04-honest-fallback-routing.md` for why degraded
tiles are merged for routing but not for display.

## Interview defense

**Q: You build graph tiles separately — how do they become one routable graph?**
Three pure steps in `features/map/tiles.ts`: `prefixGraph` namespaces ids so
merges don't collide (`tiles.ts:21-38`), `mergeGraphs` unions the records
(`tiles.ts:89-108`), and `stitchGraph` adds zero-cost edges between nodes at
identical coordinates so A* can cross tile boundaries (`tiles.ts:45-86`).

```
  prefix (unique ids) → merge (one object) → stitch (zero-cost seam edges)
       guards id          guards single-      guards cross-tile
       collision          graph routing       connectivity
```
Anchor: *merging the data isn't merging the connectivity — stitch is the part
people forget.*

**Q: How does stitch know two nodes are the same point?**
Coordinate match at 6 decimals (~0.1mm), `tiles.ts:46`. It works because the
build pipeline snaps every coordinate to 7 decimals (`split.ts:9-11`), so the
same physical intersection produces bit-identical lat/lng across separate
builds. Group by that key; any group of 2+ gets joined.

**Q: The load-bearing part people forget?**
`stitchGraph`. After `mergeGraphs` the object *looks* complete — all nodes and
edges are present — but it's N disconnected islands. Routes inside a tile work;
cross-tile routes return "no route." The stitch edges (`tiles.ts:64-83`) are
what make it one graph.

## See also

- `02-on-device-pipeline-rerun.md` — produces the tiles this composes
- `01-build-time-graph-artifact.md` — the base tile
- `04-honest-fallback-routing.md` — why degraded tiles merge for routing only
- `audit.md` §2 (data flow), §3 (the two derived graphs)
- neighboring: **study-dsa-foundations** (graph adjacency, A* traversal)
