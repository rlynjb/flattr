# Linear nearest-node scan — the O(N) snap and its scaling wall

**Industry name:** linear nearest-neighbor scan (un-indexed) vs spatial index
(grid / k-d tree / R-tree).
**Type:** Industry standard (the technique) — here the un-indexed form, named
honestly as a latent cost.

---

## Zoom out, then zoom in

When you tap the map or pick an address, the coordinate isn't a graph node — it's
somewhere *near* one. Routing needs the nearest actual node to start from. flattr
finds it the simplest way that works: loop over every node, compute the distance,
keep the closest. That's O(N) per snap, and it runs **twice per render** (start +
end). At today's 1621 nodes it's invisible. It's also the single clearest example
of a latent scaling cost in the repo — the first thing that breaks if the graph
grows to city scale.

Here's where it sits — on the UI thread, in the render path, feeding the search.

```
  Zoom out — the snap on the render path

  ┌─ UI thread (mobile/src/MapScreen.tsx) ─────────────────────────┐
  │  startId = useMemo(nearestNode(graph, startPt))  ← O(N) scan #1 │ ← here
  │  endId   = useMemo(nearestNode(graph, endPt))    ← O(N) scan #2 │ ← here
  │  routed  = useMemo(directedAstar(graph, startId, endId, max))   │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  reads
  ┌─ features/routing/nearest.ts ──▼───────────────────────────────┐
  │  for id of Object.keys(graph.nodes): haversine(point, node)     │
  │  keep the minimum — NO spatial index                            │
  └─────────────────────────────────────────────────────────────────┘
```

The pattern: **brute-force nearest-neighbor.** It's the correct, dead-simple
baseline. The named alternative — a spatial index that prunes the search to a
local cell — is **not yet built** (spec stretch goal).

## Structure pass

Trace the **cost axis** — "how does the snap cost grow with graph size?" — across
the index-vs-no-index boundary.

```
  One question across two designs: "cost of one snap as N grows?"

  ┌─ this repo (linear scan) ─────────────────────────┐
  │ touch EVERY node, compute haversine, keep min      │  → O(N) per snap
  └───────────────────────┬─────────────────────────────┘
                          ║  the cost curve FLIPS here
  ┌─ spatial index (grid / k-d tree) ─────────────────┐
  │ look up the point's cell → check only local nodes  │  → ~O(1) or O(log N)
  └────────────────────────────────────────────────────┘
```

**Axis = cost (per-snap work vs N).** The seam is the presence or absence of a
spatial index. Across it the *growth curve* flips: linear (every node, every
snap) vs roughly constant (only nearby nodes). At N=1621 both are sub-millisecond
and the difference is academic; at N=100k the linear scan is ~60× more work per
snap, run twice per render, on the thread that paints frames.

**The load-bearing fact about this seam: it's a drop-in.** `nearestNode` has a
clean signature — `(graph, point) → nodeId` — so a spatial index slots behind it
without touching a single caller. The cost is real but the *fix is cheap to
introduce*, which is exactly why it's acceptable to defer.

## How it works

### Move 1 — the mental model

You know how `Array.prototype.find` walks the whole array until it matches, and
how you'd build a hash map or index when that linear walk gets too slow? This is
the linear walk, and the index is the upgrade not yet made. Every snap asks the
same question — "which of these thousands of points is closest to my tap?" — by
checking all of them.

The shape — scan all, keep the running minimum:

```
  Linear nearest-neighbor — touch everything, keep the best

  point •
         \    n1        n2
          \   ·         ·
   best ── n3 ·  ◄── compare to every node, track min distance
          /   ·    n4
         /    n5
  for each node: d = dist(point, node); if d < best: best = d, bestId = node
  → O(N): the work is proportional to the node count, every time
```

### Move 2 — the load-bearing skeleton

The kernel is tiny — three parts. Strip any and it breaks.

#### Part 1 — the running minimum

Track `bestDist` (start at ∞) and `bestId`. For each node, if its distance beats
`bestDist`, replace both. **Drop the running-min and you'd have to sort all
distances** — O(N log N) instead of O(N), strictly worse for "find one minimum."
The running-min is the right structure for a single nearest.

#### Part 2 — the distance metric (haversine)

Distance is haversine (great-circle) — the same metric the A* heuristic uses, so
the snap is consistent with the search's notion of distance. **Use a cheaper
metric (raw lat/lng Euclidean) and near the poles or over long spans the "nearest"
node could be wrong** — though for short spans squared-Euclidean would be a valid
*speed* optimization (skip the sqrt, monotonic in the same order). Today it's
plain haversine, called once per node.

#### Part 3 — the empty guard

If the graph has no nodes, `bestId` stays undefined and the function throws.
**Drop the guard and a degenerate (empty) graph returns `undefined` silently**,
and the caller feeds `undefined` into the search as a node id — a confusing
downstream crash instead of a clear one at the source.

```
  The kernel — running min over a haversine scan

  bestDist = ∞;  bestId = undefined
  for id in graph.nodes:
      d = haversine(point, node[id])     ← Part 2: the metric
      if d < bestDist:                   ← Part 1: running minimum
          bestDist = d;  bestId = id
  if bestId is undefined: throw          ← Part 3: empty guard
  return bestId
```

#### Why it runs twice per render (the multiplier)

The cost isn't one scan — it's two, every render where the graph or an endpoint
changes, because `startId` and `endId` are separate `useMemo`s. And endpoints are
stored as *coordinates*, re-snapped on every graph change (so ids track as
corridor tiles load) — a deliberate correctness choice (`MapScreen.tsx:53-56`,
`123-126`) that *also* means the scan re-runs whenever the merged graph grows.

```
  Per-render snap cost — two scans, re-run as the graph grows

  graph changes (tile loaded) ─► startId useMemo re-runs nearestNode (O(N))
                              ─► endId   useMemo re-runs nearestNode (O(N))
  → 2·O(N) per relevant render, on the JS thread, before the search even starts
```

### Move 2.5 — current state vs the spatial index

**Now:** linear scan, no index. **Acceptable** because N is small and the snap is
folded into a sub-ms render. **The wall:** city-scale N makes 2·O(N) per render a
real frame-budget cost.

```
  Phase A (now, fine)               Phase B (city scale, hurts)
  ──────────────────                ──────────────────────────
  N = 1621 nodes                    N = 100k+ nodes
  scan ≈ microseconds               scan ≈ milliseconds × 2 × per render
  2 scans/render invisible          → eats the frame budget during pan
  fix: NONE NEEDED                  fix: spatial index behind nearestNode's
                                      SAME signature — bucket nodes into a grid
                                      (reuse tileKeyOf from tiles.ts!), check the
                                      point's cell + 8 neighbors → ~O(1)
                                    → NOT YET BUILT (spec stretch goal)
```

What doesn't change: the caller, the signature, the haversine metric. The index is
a pure internal swap. And the repo *already has* a grid-bucketing primitive —
`tileKeyOf` in `tiles.ts:10-12` — so the building block exists; it just isn't wired
into the snap.

### Move 3 — the principle

The general lesson: **a linear scan is the correct baseline; the right time to add
a spatial index is when measurement says N has grown enough to matter — not
before.** The discipline is to (1) keep the slow-but-simple version behind a clean
signature so the upgrade is a drop-in, and (2) name the scaling cost honestly so
it's a known deferral, not a hidden trap. Premature indexing is its own cost
(complexity, a structure to keep in sync with the graph); deferring it behind a
stable interface is the disciplined call here.

## Primary diagram

The full picture — where the scan runs, how often, and the deferred upgrade.

```
  Linear nearest-node scan, end to end

  ┌─ UI thread: MapScreen render ──────────────────────────────────┐
  │  startPt, endPt (COORDINATES, re-snapped as graph grows)        │
  │  startId = useMemo(() => nearestNode(graph, startPt), [g,sPt])  │ ── O(N) #1
  │  endId   = useMemo(() => nearestNode(graph, endPt),   [g,ePt])  │ ── O(N) #2
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  feeds ids to
  ┌─ features/routing/nearest.ts ──▼───────────────────────────────┐
  │  bestDist=∞                                                     │
  │  for id of Object.keys(graph.nodes):                            │
  │     d = haversine(point, node)                                  │
  │     if d < bestDist: bestDist=d, bestId=id     ← running min    │
  │  if !bestId throw                              ← empty guard    │
  │  return bestId                                  NO INDEX        │
  └─────────────────────────────────────────────────────────────────┘
        deferred upgrade (NOT BUILT): grid bucket via tileKeyOf →
        check point's cell + neighbors → ~O(1), same signature
```

## Implementation in codebase

**Use cases in this repo.** Every way an endpoint gets set routes through here:
tap-to-route (`MapScreen.tsx:223-224`), address geocode (`handleRoute` sets
`startPt`/`endPt`), autocomplete pick (`onSelectSuggestion`), and "use current
location." All store a *coordinate*; `startId`/`endId` re-derive the node via
`nearestNode` (`MapScreen.tsx:125-126`).

**The scan itself** (`features/routing/nearest.ts`):

```
  features/routing/nearest.ts  (lines 5-18)

  export function nearestNode(graph: Graph, point: LatLng): string {
    let bestId: string | undefined;
    let bestDist = Infinity;                          ← running min seed
    for (const id of Object.keys(graph.nodes)) {      ← O(N): EVERY node, every call
      const n = graph.nodes[id];
      const d = haversine(point, { lat: n.lat, lng: n.lng });   ← same metric as A* heuristic
      if (d < bestDist) { bestDist = d; bestId = id; }          ← keep the closest
    }
    if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");  ← empty guard
    return bestId;
  }
       │
       └─ `Object.keys(graph.nodes)` is the whole node set; there's no spatial
          pre-filter, so the loop body runs N times. Clean signature
          (graph, point) → id means a grid index drops in here with zero caller
          changes. This is the latent scaling cost — fine at 1621, the first
          wall at city scale.
```

**Called twice per render** (`mobile/src/MapScreen.tsx`):

```
  mobile/src/MapScreen.tsx  (lines 123-126)

  // Re-snap each endpoint coordinate to the nearest node in the CURRENT graph, so
  // the ids track as corridor tiles load (a closer/real node may appear mid-load).
  const startId = useMemo(() => (graph && startPt ? nearestNode(graph, startPt) : null),
                          [graph, startPt]);                 ← O(N) scan, deps include graph
  const endId   = useMemo(() => (graph && endPt ? nearestNode(graph, endPt) : null),
                          [graph, endPt]);                   ← O(N) scan #2
       │
       └─ both memos depend on `graph`, so a tile load (graph grows) re-runs BOTH
          scans before the route search. The re-snap is deliberate correctness —
          endpoints stored as coords so they snap to a better node as corridor
          tiles arrive — but it couples the scan cost to graph growth: bigger
          graph = more nodes scanned, twice, every time the graph changes.
```

**The grid primitive that's already there but unused for snapping**
(`features/map/tiles.ts`):

```
  features/map/tiles.ts  (lines 10-12)

  export function tileKeyOf(lng: number, lat: number): string {
    return `${Math.floor(lng / TILE_W)},${Math.floor(lat / TILE_H)}`;   ← grid bucket key
  }
       │
       └─ this IS the building block for a spatial index — bucket nodes by tileKeyOf,
          then nearestNode checks only the tap's cell + neighbors instead of all N.
          It exists for tiling; it's simply not wired into the snap. The upgrade is
          "reuse this," not "invent something."
```

## Elaborate

Brute-force nearest-neighbor is the textbook O(N) baseline; the standard upgrades
are a **uniform grid** (bucket points into cells, search the query cell plus its
ring — best when points are roughly uniform, which street nodes mostly are), a
**k-d tree** (O(log N) average query, better for skewed distributions, but a tree
to build and keep in sync), or an **R-tree** (the workhorse of GIS, what PostGIS
uses). For a graph that's mostly a uniform street grid, the uniform-grid index is
the natural fit and the repo already has the bucketing primitive (`tileKeyOf`).
The reason deferring is the right call: a spatial index is *state that must stay
consistent with the graph*, and this graph *changes on every tile load* — so the
index would have to rebuild or update incrementally on each merge, which is real
complexity to pay for a cost that's currently microseconds. The honest engineering
move is exactly what the repo does: simplest correct version behind a clean
signature, with the scaling limit named.

Read next: `04-render-thread-search-debounce.md` (the other per-render cost on the
same thread — together they're what crosses the frame budget at scale) and
`01-heuristic-pruning.md` (the search the snap feeds). The sibling
`.aipe/study-system-design/` owns the scale-limit decision; `.aipe/study-dsa-foundations/`
owns spatial indexes as DSA.

## Interview defense

**Q: "You scan every node to snap a tap to the graph — that's O(N). Why is that
okay?"**

Because N is ~1600 and the scan is microseconds, run inside a sub-millisecond
render. It's the correct simple baseline, and I kept it behind a clean signature —
`nearestNode(graph, point)` — so a spatial index drops in without touching any
caller. At city scale it'd matter: it runs twice per render (start and end) and
re-runs whenever the graph grows, so 2·O(N) on the frame thread. The fix is a
uniform grid — and I already have the bucketing primitive, `tileKeyOf`, used for
tiling. I just haven't needed to wire it in.

```
  now:  N=1600 → 2·O(N) per render = microseconds → fine
  scale: N=100k → 2·O(N) per render = ms × per frame → grid index behind same signature
```

Anchor: *linear scan is the correct baseline; index when measurement says N grew
enough to matter — and keep it a drop-in until then.*

**Q: "Why does it run twice per render and re-run on graph changes?"**

Endpoints are stored as coordinates, not node ids, and re-snapped against the
current graph — so as corridor tiles load and a closer real node appears, the
endpoint tracks to it. That's a correctness choice. The cost is that both the start
and end snaps re-run on every graph change, so the per-snap cost is coupled to
graph growth. At small N that's free; it's the thing to watch as coverage grows.

```
  coords (not ids) → re-snap on graph change → 2·O(N) re-runs as graph grows
```

Anchor: *the most-forgotten cost here isn't the scan — it's that it's two scans,
re-run on graph growth.*

## Validate

1. **Reconstruct.** From memory, write `nearestNode`: the running-min, the metric,
   the empty guard. (Check `nearest.ts:5-18`.) Why a running-min instead of sorting?
2. **Explain.** Why does `startId` re-run on every `graph` change, and what
   correctness property does that buy? (`MapScreen.tsx:123-126`, and the comment at
   `:53-56`.)
3. **Apply.** Sketch how you'd add a uniform-grid spatial index behind
   `nearestNode` reusing `tileKeyOf` (`tiles.ts:10-12`) — what state, when is it
   built, and why is the function's caller untouched?
4. **Defend.** Argue when to add the spatial index and when not to, citing the
   current node count (1621, `mobile/assets/graph.json`), the twice-per-render call
   (`MapScreen.tsx:125-126`), and the fact that the graph changes on every tile
   load (so the index must stay in sync).

## See also

- `04-render-thread-search-debounce.md` — the other O(N)/sync cost on the JS thread.
- `01-heuristic-pruning.md` — the search this snap feeds start/goal ids into.
- `.aipe/study-system-design/` — graph scale as an architecture limit.
- `.aipe/study-dsa-foundations/` — spatial indexes (grid / k-d tree) as DSA.
