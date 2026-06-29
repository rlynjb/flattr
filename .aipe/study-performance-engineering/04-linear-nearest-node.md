# Linear Nearest-Node Scan — the latent scaling cliff

**Industry name(s):** brute-force nearest-neighbor / linear scan; the fix is a
spatial index (k-d tree / grid bucket / R-tree). **Type:** Industry standard
(spatial search).

## Zoom out, then zoom in

Every route starts by turning a tapped lat/lng into a graph node id. flattr does
that with the simplest possible thing — loop over every node, keep the closest.
It's O(N), it runs twice per route, and at today's 1621 nodes it's invisible.
This file is about why it's fine *now* and exactly when it becomes the bottleneck.

```
  Zoom out — where snapping sits

  ┌─ UI (JS thread) ──────────────────────────────────────────┐
  │  MapScreen.tsx:133-134                                     │
  │    startId = nearestNode(graph, startPt)  ← we are here    │
  │    endId   = nearestNode(graph, endPt)                     │
  └───────────────────────────┬───────────────────────────────┘
                              │ feeds
  ┌─ Algorithm core ──────────▼───────────────────────────────┐
  │  directedAstar(graph, startId, endId, userMax)            │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"given a coordinate, which graph node is closest?"* The
honest framing — this is the one place in flattr where the data-structure choice
is *knowingly* the naive one, with a named upgrade waiting.

## Structure pass

**Layers.** One function, two cost regimes depending on N:

```
  nearestNode (nearest.ts)  →  called per endpoint per graph change (MapScreen)
  O(N) loop                    re-runs as corridor tiles load (graph grows)
```

**Axis: cost — "how does this scale with node count N?"**

```
  One question across graph sizes
  "cost of one snap as N grows?"

  N = 1,621 (base)      → 1,621 haversines  → sub-ms        [now]
  N = 20,000 (city)     → 20,000 haversines → noticeable
  N = 200,000 (region)  → 200,000 × 2/route → the cliff
```

**Seam.** The boundary that matters is the call site
(`MapScreen.tsx:133-134`): it's inside a `useMemo` keyed on `[graph, startPt]`,
so it re-runs every time the merged graph changes — and the graph changes every
time a corridor/viewport tile loads. So the scan isn't once per route; it's once
per *graph version* per endpoint. As coverage grows, both N *and* call frequency
grow together.

## How it works

### Move 1 — the mental model

It's `Array.reduce` to a minimum, spelled out as a loop: walk all nodes, compute
distance to each, remember the best. The same shape as finding the smallest number
in a list — except the "compare" is a haversine call.

```
  Linear nearest-neighbor — the shape

  point •
         compare to every node, keep min
   n1 ─ d1
   n2 ─ d2  ← best so far
   n3 ─ d3
   ...
   nN ─ dN          O(N) distance computations, one pass
```

### Move 2 — the walkthrough

**The scan.** The entire function is one loop:

```ts
// features/routing/nearest.ts:5-18  — O(N) over every node, twice per route
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {     // ← every node, every call
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });  // a trig call per node
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

`Object.keys(graph.nodes)` also allocates an array of all ids on every call —
minor at 1621, linear with N. Each iteration is a haversine (several trig ops).

**Why it's correct to leave it naive right now.** Two reasons, both honest:

- **N is small and bounded.** Base graph is 1621 nodes
  (`mobile/assets/graph.json`), and `MAX_CORRIDOR_SPAN_DEG`/`MAX_LOAD_SPAN_DEG`
  (`useTileGraph.ts:66,69`) cap how much more can ever be merged in. The work
  ceiling from lens 1 keeps N from exploding.
- **Re-snapping is a feature.** Endpoints are stored as *coordinates*, not ids
  (`MapScreen.tsx:58-60`), and re-snapped from the *current* graph
  (`MapScreen.tsx:133-134`) so a closer real node can appear as corridor tiles
  load. That correctness behavior *requires* re-running the snap — which is why
  the scan's frequency is tied to graph growth.

**Where the cliff is.** The scan is O(N) per call × 2 endpoints × (graph
versions). Hold the route count fixed and grow coverage: at 200k nodes a single
snap is 200k haversines, and it runs on the JS thread (lens 7) right before A*.
That's when you'd feel it — a stutter between tap and route.

```
  Execution trace — cost of one nearestNode call by N

  N         haversines   array alloc   verdict
  1,621        1,621       1,621 ids    free          [today, MEASURED size]
  20,000      20,000      20,000 ids    ~ms, ok
  200,000    200,000     200,000 ids    JS-thread stall   ← the cliff
```

**The fix — a spatial index.** Build a k-d tree (or a uniform grid bucket) over
the nodes once when the graph changes; query is O(log N) (k-d) or O(1) average
(grid). The build is O(N log N) amortized over many snaps. You already have the
tree-building muscle from reincodes (`BinarySearchTree.ts`, `Graph.ts`) — a 2-D
k-d tree is a BST that alternates split axis by depth. The grid-bucket version is
even simpler and matches the tiling flattr already uses: hash each node into a
cell, search the tap's cell + 8 neighbors.

```
  Phase A (now)              Phase B (at scale)
  ──────────────             ──────────────────
  linear scan O(N)/call      k-d tree: build O(N log N), query O(log N)
  no build step              or grid bucket: build O(N), query O(1) avg
  fine ≤ ~20k nodes          trigger: N > ~50k OR snap shows on a device profile
  what doesn't change:       nearestNode's signature — drop-in behind it
```

### Move 3 — the principle

The naive O(N) scan is the *correct default* when N is small and bounded — adding
a k-d tree now would be speculative complexity for a problem you don't have. The
discipline is to **name the cliff and the fix explicitly** (which flattr's own
context does: "linear nearest-node scan — the latent scaling cliff; k-d tree is
the fix") so the upgrade is a known move triggered by a measurement, not a
rewrite-in-a-panic later.

## Primary diagram

```
  Nearest-node snap — now vs the fix

  ┌─ MapScreen.tsx (JS thread, per graph version) ────────────┐
  │  startId = nearestNode(graph, startPt)                     │
  │  endId   = nearestNode(graph, endPt)                       │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ NOW: nearest.ts ─────────▼────────────┐  ┌─ FIX: spatial index ─────┐
  │  for id in all nodes:                  │  │  build once per graph:    │
  │    d = haversine(point, node)          │  │   k-d tree  OR grid hash  │
  │    track min                           │  │  query: tap's cell + ring │
  │  O(N) per call, twice per route        │  │  O(log N) / O(1) avg      │
  └────────────────────────────────────────┘  └───────────────────────────┘
   trigger to switch: N > ~50k or snap shows on an on-device profile
```

## Elaborate

Nearest-neighbor on point sets is the canonical use case for k-d trees (Bentley,
1975) and, for uniformly-dense data like a street grid, uniform grid buckets are
often faster in practice because of cache locality and no tree traversal. flattr's
existing tile grid (`features/map/tiles.ts:10-12`, `tileKeyOf`) is *already* a
spatial hash — the grid-bucket nearest-neighbor would reuse that exact keying
scheme, making it the lower-effort fix of the two. This is the kind of latent
issue a profiler would surface instantly; flattr has no profiler (lens 2), so it's
caught here by reasoning about N instead.

## Interview defense

**Q: Your nearest-node is O(N) — why is that acceptable?**

> Because N is small and bounded. Base graph is 1621 nodes and the corridor/view
> span caps keep merged N from exploding, so a snap is sub-millisecond. Adding a
> k-d tree now would be speculative complexity. I've named the cliff explicitly:
> past ~50k nodes, or the moment it shows on a device profile, I'd index. The fix
> is a drop-in behind `nearestNode` — and flattr already has a tile grid I'd reuse
> as the spatial hash.

```
  N small → O(N) scan fine     N > ~50k → grid bucket (reuse tileKeyOf) / k-d tree
```

Anchor: *naive is the right default until a measured N says otherwise.*

**Q: Why re-snap on every graph change instead of caching the node id?**

> Because endpoints are coordinates, not ids. As corridor tiles load, a closer
> real node appears, and I want the route to use it — so I re-derive the id from
> the current graph (`MapScreen.tsx:133-134`). That correctness need is exactly
> what ties the scan's frequency to graph growth, which is why the cliff is about
> N *and* call count.

```
  tap → store coord → graph grows → re-snap to nearer node → route
```

Anchor: *the re-snap is a feature, and it's why frequency scales with coverage.*

## See also

- `02-heuristic-pruning.md` — the search that runs right after the snap.
- `05-single-flight-pump.md` — what grows the graph (and thus N).
- `audit.md` lens 4 (CPU) and lens 8 (red flag #3).
- Cross-guide: `study-dsa-foundations` (k-d tree as a BST variant), `study-system-design` (the tile grid).
