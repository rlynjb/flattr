# Linear nearest-node scan — the latent scaling cliff

> Industry name: **brute-force nearest-neighbor (O(N) linear scan)**, fixed by a
> **k-d tree / spatial grid**. Type: Industry standard.

When you tap the map to set a start or end, flattr snaps that coordinate to the
nearest graph node by scanning *every* node. At 1621 nodes that's invisible. The
problem is it re-runs on every graph rebuild and scales linearly with a graph that
only grows. This is a latent cliff, not a current fire.

## Zoom out — where this concept lives

The snap sits in the core engine, called from the mobile render path in two
`useMemo`s that re-fire whenever the merged graph changes.

```
  Zoom out — nearest-node in the snap path

  ┌─ Mobile (MapScreen.tsx) ──────────────────────────────────┐
  │  startId = useMemo(nearestNode(graph, startPt), [graph,…]) │ ← re-fires on
  │  endId   = useMemo(nearestNode(graph, endPt),   [graph,…]) │   every rebuild
  └──────────────────────────┬─────────────────────────────────┘
                             │ calls
  ┌─ Core engine (features/routing/nearest.ts) ─▼─────────────┐
  │  ★ for each id in graph.nodes: haversine, track min        │ ← we are here
  │     O(N) scan, N = merged node count (1621 base → larger)  │
  └──────────────────────────┬─────────────────────────────────┘
                             │ result feeds
  ┌─ A* (directedAstar) ─────▼────────────────────────────────┐
  │  needs start/goal node ids                                │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this is the `.find()`-the-closest-thing loop you've written a hundred
times. Fine for small arrays, a cliff for large ones — and the fix (a k-d tree) is
exactly the kind of from-scratch data structure already in your reincodes portfolio
(BinaryHeap, BST). Same move, spatial version.

## Structure pass — the skeleton

**Axis traced: cost per snap as a function of graph size.** It's linear, and the
seam that would flip it to logarithmic — a spatial index — doesn't exist yet.

```
  One axis — "cost per snap" — and the missing seam

  ┌─ current: nearest.ts ─────────────────────────────────────┐
  │  scan ALL nodes, haversine each → O(N)                    │  → N=1621: cheap
  │                                  → N=10k+: cliff           │
  └──────────────────────────┬─────────────────────────────────┘
        MISSING seam: spatial index (k-d tree / grid)
  ┌─ would-be: indexed lookup ──▼─────────────────────────────┐
  │  query nearest in O(log N)                                │  → N=10k: still fast
  └────────────────────────────────────────────────────────────┘
```

The seam isn't there. That's the finding: there's no spatial index between the tap
and the node set, so cost is bound to N, and N is the merged graph that grows with
every loaded tile.

## How it works

### Move 1 — the mental model

You have a list of points and a target; you want the closest. The brute-force
answer is: walk the whole list, compute distance to each, keep the minimum. That's
`nearest.ts` exactly — `Object.keys(graph.nodes)`, haversine to each, track best.

```
  The pattern — linear min-scan

   target ●
          for each node:  d = haversine(target, node)
                          if d < best: best = d, bestId = id
   nodes: · · · · · · · · · · · · · · · ·   ← touches every one, O(N)
```

The thing that makes it a cliff: it's not the absolute cost (1621 haversines is
nothing), it's *where* and *how often* it runs — on the JS render thread
(`03` shares the thread with A*, `audit.md` R2), inside a `useMemo` that re-fires on
every graph rebuild, over a graph that only grows as tiles load.

### Move 2 — the walkthrough

**The scan.** The whole function is the brute-force min:

```ts
// features/routing/nearest.ts:5-17 — O(N) linear scan
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {       // ← every node, every call
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });  // ← haversine each
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

`Object.keys(graph.nodes)` materializes the full id array every call, then one
haversine per node. Measured base graph: **1621 nodes** (`node -e` over
`mobile/assets/graph.json`). So 1621 haversines per snap, today.

**Where it re-fires.** Two `useMemo`s, both depending on `graph`:

```ts
// mobile/src/MapScreen.tsx:133-134 — re-snap on every graph change
const startId = useMemo(() => (graph && startPt ? nearestNode(graph, startPt) : null), [graph, startPt]);
const endId   = useMemo(() => (graph && endPt   ? nearestNode(graph, endPt)   : null), [graph, endPt]);
```

`graph` is the *merged* graph — base + corridor + viewport, rebuilt by
`stitchGraph(mergeGraphs(...))` whenever a tile loads (`useTileGraph.ts:132-145`).
So the sequence on a route is: tap sets `startPt` → snap (scan base 1621) → corridor
tiles load → `graph` rebuilds larger → both `useMemo`s re-fire → snap *again* over
the now-larger merged node set. The deliberate reason endpoints are stored as
coordinates and re-snapped (a closer real node may appear as tiles load,
`MapScreen.tsx:56-58,131-132`) is exactly what makes the scan repeat.

```
  Execution trace — re-snap as the graph grows

  step          graph size   nearestNode cost
  tap start     1621         1621 haversines
  corridor load 1621+M       (1621+M) haversines   ← re-snap, bigger
  viewport load 1621+M+V     (1621+M+V) haversines ← re-snap again
                             all on the JS thread, per rebuild
```

### Move 2.5 — current state vs the fix

```
  Phase A: NOW                    Phase B: k-d tree fix
  ─────────────                   ──────────────────────
  nearest.ts O(N) scan            build k-d tree once per graph
  re-run per rebuild, on graph    query O(log N) per snap
  N=1621 today → cheap            N=10k → still ~13 comparisons
  cliff is latent, not hit        index rebuild amortized vs per-snap scan
```

What doesn't change: the call sites (`MapScreen.tsx:133-134`) and the coordinate-
based re-snap design stay identical — only `nearestNode` swaps its internals for an
index query. The fix is a from-scratch k-d tree (the same caliber of data structure
already in reincodes: BinaryHeap, BST) or a coarse spatial-hash grid keyed like the
elevation cell-key already in the repo. Not yet built because at 1621 nodes the scan
is invisible — but the cliff is one dense-city corridor away.

### Move 3 — the principle

O(N) is free until N grows, and the dangerous version is the O(N) that re-runs on a
growing N inside a hot path you don't measure. The fix is to put a spatial index
between the query and the data so cost decouples from N. The judgment call is *when*
— and here, honestly, not yet: 1621 nodes doesn't justify a k-d tree. But naming the
cliff and the trigger (merged graph crossing into thousands of nodes, especially on
the render thread) is the work, so the fix lands before the jank, not after.

## Primary diagram

```
  Linear nearest-node scan — full recap

  ┌─ MapScreen.tsx:133-134 — re-snap on every graph rebuild ──┐
  │  startId/endId = useMemo(nearestNode(graph, pt), [graph]) │
  └──────────────────────────┬─────────────────────────────────┘
                             │ graph = merged (grows per tile)
  ┌─ nearest.ts:5-17 ────────▼────────────────────────────────┐
  │  for id in Object.keys(graph.nodes):   ← O(N)             │
  │    haversine(point, node); track min                     │
  │  N = 1621 (base) → larger as corridor/viewport merge      │
  │                                                            │
  │  FIX: k-d tree / spatial grid → O(log N), built per graph │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Nearest-neighbor in 2D is the textbook k-d tree use case (Bentley, 1975): partition
space on alternating axes, prune subtrees that can't contain a closer point, query
in O(log N) average. For a graph that grows incrementally, a coarse spatial-hash
grid is often simpler and good enough — bucket nodes by quantized cell (the repo
already has a cell-key pattern in `elevCache.ts`), then search the query cell plus
its 8 neighbors. flattr hasn't needed either yet. This pairs with `01-heuristic-
pruning.md`: the snap picks A*'s start/goal, so both run on the same render thread,
and a slow snap delays the search that follows it. See `study-dsa-foundations` for
the k-d tree as an algorithm.

## Interview defense

**Q: Your nearest-node is O(N) — why is that okay, and when isn't it?**

It's okay because N is 1621 today and the scan is sub-millisecond. It stops being
okay because it re-fires on every graph rebuild — and the graph grows as route-
corridor and viewport tiles merge in — all on the JS render thread. So the cost is
O(N) where N only increases and the work shares a thread with paint. The fix is a
k-d tree or a spatial-hash grid to get O(log N); I'd build it when the merged graph
crosses a few thousand nodes, not before — at 1621 it'd be premature.

```
  N=1621  → 1621 ops → fine
  N=20k   → 20k ops × every rebuild × render thread → jank
  k-d tree → ~15 ops → flat
```

Anchor: *"O(N) on a growing N in a hot path is a latent cliff — index it before
the jank, not after."*

**Q: k-d tree or spatial grid — which would you pick here?**

Spatial grid, probably. The repo already quantizes coordinates to cells for the
elevation cache (`cellKey`), so a grid reuses a pattern that's already there and
handles incremental insertion trivially as tiles merge. A k-d tree is tighter
asymptotically but rebalancing on every graph rebuild costs more than a grid's
constant-cell bucketing for this access pattern.

Anchor: *"reuse the cell-key quantization the elevation cache already proved."*

## See also

- `01-heuristic-pruning.md` — the A* search this snap feeds.
- `04-zones-percentile-sort.md` — the other latent CPU cliff (lower priority).
- `audit.md` lens 4 (CPU), R3 (this finding), R2 (shared render thread).
- `study-dsa-foundations` — k-d tree / spatial index as algorithms.
