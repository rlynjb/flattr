# 04 — Coordinates as endpoint state

**Industry names:** source-of-truth vs derived state; "store the stable identity,
derive the volatile reference." **Type:** Project-specific state-design choice.

## Zoom out, then zoom in

The everyday mistake this avoids: storing a *derived id* in state and then fighting
to keep it in sync. flattr's route endpoints could be stored as graph node ids —
that's what A\* needs. Instead they're stored as **coordinates**, and the node id
is **derived** from the current graph every render. The reason is subtle and good:
the graph *grows* as tiles load, so a node id picked early can become wrong, but a
coordinate is forever.

```
  Zoom out — endpoint state in the route pipeline

  ┌─ source state (useState) ─────────────────────────────────────┐
  │  startPt / endPt : { lat, lng }   ← STABLE, never goes stale   │ ← we are here
  └───────────────────────────────┬───────────────────────────────┘
                                   │ useMemo nearestNode(graph, pt)
  ┌─ derived state ───────────────▼───────────────────────────────┐
  │  startId / endId : node id     ← re-snaps as the graph grows   │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ feeds A* (pattern 01)
  ┌─ derived state ───────────────▼───────────────────────────────┐
  │  routed = directedAstar(graph, startId, endId, userMax)        │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "which representation is the source of truth — the
geographic point, or the graph node?" flattr's answer: the *point*. The node is a
projection of the point onto whatever graph currently exists.

## Structure pass

**Layers:** (1) `startPt`/`endPt` coords in state → (2) `startId`/`endId` derived
via `nearestNode` → (3) A\* consumes the ids.

**Axis — state (what's mutable, what's stable, what's the source of truth?):**

```
  Axis: "what's the source of truth, and what's a projection?"

  ┌─ startPt / endPt (coords) ────┐  SOURCE OF TRUTH — set by tap,
  │  immutable until user changes │  geocode, suggestion, swap
  └───────────┬───────────────────┘
  ┌─ startId / endId (node id) ───▼┐ PROJECTION — recomputed every
  │  nearestNode(currentGraph, pt) │ render; changes when graph grows
  └────────────────────────────────┘
```

**Seam (load-bearing):** the `nearestNode` memo (`MapScreen.tsx:133–134`). The
state axis flips here: above it, the value is stable and user-owned; below it, the
value is volatile and graph-owned. That's the boundary that makes endpoints
"re-snap" for free as corridor tiles arrive.

## How it works

### Move 1 — the mental model

It's the same instinct as storing a `userId` (stable) and deriving the `user`
object from the current `users` list (volatile) instead of caching the whole user
object and watching it go stale.

```
  Pattern — stable identity in state, volatile reference derived

   startPt {lat,lng} ──(stable)──► state
            │
            │ every render: nearestNode(currentGraph, startPt)
            ▼
   startId ──(volatile: changes when graph changes)──► A*
```

The kernel — what breaks if you invert it (store the id):
- store `startId` in state, and when a corridor tile adds a *closer* node, the
  stored id now points at a worse node — the route starts from the wrong place,
  and there's no signal to update it. You'd need an effect to re-run `nearestNode`
  and `setState`, which double-renders and races the tile load.
- store `startPt` and *derive* `startId`, and the re-snap is automatic: the memo
  re-runs whenever `graph` changes, picks the now-closest node, A\* re-routes.
  No effect, no race.

### Move 2 — the walkthrough

**The source state** — `MapScreen.tsx:58–60`:

```tsx
// Endpoints are stored as COORDINATES, not node ids: the nearest node is re-derived
// from the current graph, so endpoints re-snap correctly as route-corridor tiles load.
const [startPt, setStartPt] = useState<{ lat: number; lng: number } | null>(null);
const [endPt, setEndPt]     = useState<{ lat: number; lng: number } | null>(null);
```

**The derivation** — `MapScreen.tsx:133–134`:

```tsx
const startId = useMemo(() => (graph && startPt ? nearestNode(graph, startPt) : null), [graph, startPt]);
const endId   = useMemo(() => (graph && endPt   ? nearestNode(graph, endPt)   : null), [graph, endPt]);
```

Walk it:

**Every setter writes a coordinate, never an id.** Trace the inputs:
- map tap → `setStartPt({ lat, lng })` (`:241`)
- geocode result → `setStartPt({ lat: a.lat, lng: a.lng })` (`:187, 195`)
- autocomplete pick → `setStartPt({ lat: r.lat, lng: r.lng })` (`:255`)
- current location → `setStartPt({ lat, lng })` (`:227–228`)
- swap → `setStartPt(endPt)` (`:215`) — swaps *coordinates*, ids re-derive

Five entry points, all coordinates. There is no `setStartId` anywhere. The id is
*never* a thing the app stores.

**The memo re-snaps on two triggers.** Deps `[graph, startPt]`:
- `startPt` changes → user moved the endpoint → obviously re-derive.
- **`graph` changes → a tile loaded → re-derive against the bigger graph.** This
  is the payoff. When the corridor pump (pattern `02`) commits a new region,
  `graph` gets a new identity, this memo re-runs, and if the new tile contains a
  node closer to `startPt`, `startId` updates to it.

```
  Execution trace — endpoint re-snaps as a tile loads

  t0  startPt = {47.62, -122.32}   graph = base only
      nearestNode → "base:417"  (300 m away, base graph is sparse here)
      startId = "base:417"

  t1  corridor tile commits → graph = base+corridor (new identity)
      memo re-runs (graph dep changed)
      nearestNode → "corridor:88"  (12 m away, real street node)
      startId = "corridor:88"      ← re-snapped, no effect, no setState

  t2  A* memo re-runs (startId dep changed) → route now starts at the real node
```

**Why this matters for routing connectivity.** A node id from the sparse base
graph might sit in a *different connected component* than the destination until
the corridor tiles stitch them together (`useTileGraph.ts` `stitchGraph`). By
keeping endpoints as coords and re-snapping, the start/end land on the *freshly
loaded, connected* nodes the moment those nodes exist — which is exactly when A\*
can find a path. Store the id and you'd be stuck pointing at a stale,
possibly-disconnected node.

```
  Layers-and-hops — coord survives, id re-projects, across the tile-load seam

  ┌─ user intent (coords) ───────────────────────────────────────┐
  │ startPt stays {47.62,-122.32} through every tile load          │
  └───────────────────────────┬───────────────────────────────────┘
                              │ re-projected each time graph changes
  ┌─ graph (grows via pump) ──▼───────────────────────────────────┐
  │ base → base+view → base+corridor → … nearestNode picks current │
  └───────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Store the most *stable* representation of intent; derive the volatile one. A
coordinate is what the user means ("route from here"); a node id is an
implementation detail of whatever graph happens to be loaded. Putting the stable
thing in state and deriving the volatile thing through a memo means the system
self-corrects as data arrives — no sync effects, no stale-id bugs, no races. The
test for any piece of state: "could a future data load make this value wrong?" If
yes, it's derived, not stored.

## Primary diagram

```
  Coords-as-endpoint-state — full picture (MapScreen.tsx)

  setters (all write COORDS):
    tap :241   geocode :187/195   suggestion :255   current-loc :227   swap :215
                            │
                            ▼
  ┌─ source state ──────────────────────────────────────────────┐
  │ startPt / endPt : {lat,lng}   (stable until user changes it) │
  └───────────────┬──────────────────────────────────────────────┘
                  │ useMemo nearestNode(graph, pt)   deps:[graph, pt]
                  ▼   re-runs on user-change OR graph-grows
  ┌─ derived ───────────────────────────────────────────────────┐
  │ startId / endId   (re-snaps to the closest current node)     │
  └───────────────┬──────────────────────────────────────────────┘
                  ▼
            directedAstar(graph, startId, endId, userMax)  → route
```

## Elaborate

This is the "single source of truth" principle from Redux/Flux doctrine applied at
the component level: keep one canonical representation, derive everything else.
The flattr-specific sharpening is that the *graph itself is mutable data that
arrives over time*, so any value computed against "the graph" is inherently
volatile and must be derived, not stored. The same reasoning shows up in any app
where a foreign key resolves against a paginated/streaming list — store the key,
resolve on read. Read next: `01-render-thread-astar.md` (the consumer of
`startId`/`endId`), `02-single-flight-pump.md` (why `graph` changes identity),
`study-system-design` (the graph-as-growing-data model).

## Interview defense

**Q: "Why store endpoints as coordinates instead of graph node ids?"**
Because the graph grows as tiles load, so a node id can go stale — a closer or
better-connected node may appear after you picked one. Coordinates never go stale.
I store `startPt`/`endPt` as `{lat,lng}` and *derive* `startId`/`endId` via a
`useMemo(nearestNode(graph, pt))`. The memo's `graph` dep makes the endpoints
re-snap automatically whenever a tile commits — no sync effect, no stale-id race.

```
  startPt (stable) ─► useMemo nearestNode(graph,pt) ─► startId (re-snaps on graph change)
```
*Anchor: store the stable identity (the point), derive the volatile reference
(the node).*

**Q: "What bug does that prevent?"**
Routing failure across connected components. A base-graph node might be in a
different component than the destination until corridor tiles stitch them. Storing
the id pins you to that stale node; deriving it means start/end re-snap onto the
freshly loaded, now-connected nodes the instant they exist — which is exactly when
A\* can find a path.

```
  store id  → stale node in old component → "no route"
  derive id → re-snaps to new connected node → route found
```
*Anchor: the test — "could a future data load make this value wrong?" If yes,
derive it.*

## See also

- `01-render-thread-astar.md` — consumes `startId`/`endId` as memo deps.
- `02-single-flight-pump.md` — the corridor loads that change `graph` and trigger
  the re-snap.
- `audit.md` §2.
