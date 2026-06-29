# Coordinates, not ids — endpoints as source-of-truth

**Industry name(s):** stable source-of-truth + derived lookup / normalize-late. **Type:**
Project-specific (the *choice* of which representation is canonical is the lesson).

## Zoom out, then zoom in

When you set a route endpoint, the obvious thing to store is "the node the user picked." flattr
deliberately does *not*. It stores the raw `{lat, lng}` the user tapped, and re-derives "which graph node
is nearest" on every render. The reason is timing: the graph is still streaming in when you pick an
endpoint, so "the nearest node" is a moving target — and you want it to track.

```
  Zoom out — where the endpoint representation lives

  ┌─ UI state (MapScreen) ────────────────────────────────────────┐
  │  ★ startPt {lat,lng} ★   ★ endPt {lat,lng} ★  ← canonical here │
  │            │                      │                            │
  │            ▼ useMemo              ▼ useMemo                     │
  │     startId = nearestNode    endId = nearestNode               │
  │            (graph, startPt)        (graph, endPt)              │
  └────────────────────────────┬──────────────────────────────────┘
                              feeds the route memo [01]
```

The thing on the map is a coordinate; the thing the router needs is a node id; the bridge between them is
recomputed continuously. That bridge is what this file is about.

## Structure pass

**Layers:** (1) user gesture → coordinate, (2) coordinate state, (3) derived node id, (4) router input.

**Axis traced — "what is the source of truth for an endpoint?"**

```
  axis = "which representation is canonical?"

  ┌─ coordinate {lat,lng} ─┐   canonical — set by tap/geocode/GPS
  │  CANONICAL             │   never derived from anything
  └───────────┬────────────┘
              │ seam: nearestNode(graph, pt) — derives DOWN
  ┌─ node id ─▼────────────┐   DERIVED — recomputed each render
  │  ephemeral             │   against the CURRENT graph
  └────────────────────────┘
```

**The seam is `nearestNode`** (`MapScreen.tsx:133-134`). The axis flips across it: above, the coordinate
is fixed and authoritative; below, the id is disposable and recomputed. That flip is the whole design —
if you stored the id as canonical, there'd be nothing to re-derive when a better node appears, and the
seam would carry no contract.

## How it works

### Move 1 — the mental model

Think of a controlled form input where you store the *raw string* and derive the *parsed value* —
`const value = useMemo(() => parseFloat(text), [text])`. You keep the user's literal input as truth and
re-parse downstream. Same shape: keep the literal coordinate, re-resolve the node.

```
  normalize-late shape

   raw truth ──────────►  derive  ──────────►  resolved value
   {lat,lng}              nearestNode          node id
   (user picked)          (against current     (router needs this)
                           graph)
        │                      ▲
        │   graph changes ─────┘  re-derives automatically
        ▼
   never recomputed — only set by user action
```

The strategy in one sentence: **store what the user meant (a place), derive what the system needs (a
node), and let the derivation re-run as the system's knowledge grows.**

### Move 2 — the walkthrough

**The canonical state.** Two pieces of state, both coordinates, both nullable (`MapScreen.tsx:59-60`):

```ts
const [startPt, setStartPt] = useState<{ lat: number; lng: number } | null>(null);
const [endPt, setEndPt]     = useState<{ lat: number; lng: number } | null>(null);
```

Every way to set an endpoint writes a coordinate, never an id — map tap (`:241-242`), geocode result
(`:195`), suggestion pick (`:255-256`), current-location (`:226`). There is no `setStartId` anywhere.

**The derivation.** Two memos resolve coordinate → id against the *current* graph (`MapScreen.tsx:133-134`):

```ts
const startId = useMemo(() => (graph && startPt ? nearestNode(graph, startPt) : null), [graph, startPt]);
const endId   = useMemo(() => (graph && endPt   ? nearestNode(graph, endPt)   : null), [graph, endPt]);
```

Note the dep arrays: `[graph, startPt]`. The id re-derives when *either* the coordinate changes (user
picked a new place) *or the graph changes* (a tile loaded). That second trigger is the entire reason this
pattern exists.

**Why it matters — the streaming-tiles trace.** Walk what happens when you tap an endpoint before its
tile has loaded:

```
  execution trace — id re-snaps as the corridor loads

  t0  user taps far point → setEndPt({lat,lng})
      graph = base only; nearestNode finds a FAR base-edge node
      endId = "base:1234"  (a poor snap — nothing better exists yet)

  t1  ensureBbox fires → corridor tile fetch starts  [03]

  t2  corridor lands → graph memo rebuilds (base + corridor)
      endId memo re-runs (graph changed)
      nearestNode now finds a REAL node next to the tapped point
      endId = "corridor:5678"  (correct snap)

  t3  routed memo re-runs (endId changed) → route reconnects  [01]
```

If the id were canonical, `endId` would be frozen at `"base:1234"` from t0 — a stale, wrong node — and the
route would either fail or snap to the wrong street even after the right tile arrived. Storing the
coordinate makes the snap self-correcting.

```
  Comparison — id-canonical vs coord-canonical

  id-canonical (NOT used)          coord-canonical (flattr)
  ─────────────────────            ────────────────────────
  store endId at tap time          store endPt at tap time
  tile loads → id unchanged   ✗    tile loads → id re-derives  ✓
  stuck on stale base node         re-snaps to real node
  route wrong / fails              route reconnects
```

**Swap falls out for free.** Because endpoints are plain coordinate state, swapping From/To is just
swapping two state values (`MapScreen.tsx:211-217`):

```ts
const handleSwap = () => {
  setFromText(toText); setToText(fromText);
  setStartPt(endPt);  setEndPt(startPt);   // swap coords; ids + route re-derive
  setRouteError(null);
};
```

The ids re-derive, A\* re-runs in the reversed direction, and the uphill/downhill coloring flips — all
from swapping two coordinates. No id bookkeeping.

### Move 3 — the principle

Pick the representation that's *stable under the changes you expect*, and derive everything else from it.
The user's intent (a place) is stable; the system's resolution of it (a node) depends on data that's still
arriving. Make the stable thing canonical and the volatile thing derived, and the system self-corrects as
data lands instead of going stale.

## Primary diagram

```
  Coordinates-not-ids — full picture

  ┌─ ways to set an endpoint (all write coordinates) ─────────────┐
  │  map tap   geocode   suggestion   current-location            │
  └──────┬──────────┬─────────┬────────────┬──────────────────────┘
         └──────────┴────┬────┴────────────┘
                         ▼
              ┌─ startPt/endPt {lat,lng} ─┐  ← canonical state
              └────────────┬──────────────┘
                           │ useMemo [graph, pt]  ← re-derives on
                           ▼                          coord OR graph change
              ┌─ startId/endId (nearestNode) ─┐  ← derived, ephemeral
              └────────────┬──────────────────┘
                           ▼
                   routed memo (A*)  [01]   markers (:305-306)
```

## Elaborate

This is the frontend version of "normalize late" / "store the input, derive the view" — the same instinct
behind keeping a controlled input's raw string and parsing on read, or keeping a timestamp and formatting
at render. The general database analog is storing a natural key and resolving the surrogate key at query
time rather than caching a foreign key that can go stale.

The cost: `nearestNode` runs every time the graph changes, which on a streaming corridor is several times
per route. It's cheap (a linear-ish scan, `features/routing/nearest.ts`) compared to the A\* it feeds, so
the tradeoff is clearly worth it. Read next: `03-single-flight-tile-pump.md` (what changes `graph`),
`01-render-time-astar.md` (what consumes the derived ids).

## Interview defense

**Q: Why store endpoints as coordinates instead of node ids?**

Because the graph streams in. At tap time the only graph I have is the bundled base, so the nearest node
is whatever base edge happens to be closest — usually wrong. If I froze that id, the route would stay
pinned to it even after the correct tile loaded. Storing the coordinate and re-deriving the id with a
`useMemo` keyed on `[graph, pt]` means the snap self-corrects: when the corridor tile lands, the graph
changes, the id re-derives, and the endpoint jumps to the real node. The id is derived state; the
coordinate is the truth.

```
  the part people forget: the id memo depends on GRAPH, not just the point

  [graph, startPt] ──► re-snap when EITHER changes
       ▲
       └─ drop `graph` from deps and the snap freezes at tap-time
          → stale node → route fails after the right tile arrives
```

**Anchor:** "Endpoints are coordinates; node ids are derived against the current graph, so they re-snap as
tiles stream in — the id memo depends on `graph`, which is the part that makes it self-healing."

## See also

- `01-render-time-astar.md` — consumes `startId`/`endId`
- `03-single-flight-tile-pump.md` — produces the changing `graph`
- `05-debounced-controlled-inputs.md` — the same store-raw/derive idea for text input
- `study-system-design` — base/viewport/corridor graph merge architecture
