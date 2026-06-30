# 01 — Render-thread A\*

**Industry names:** derived state / compute-in-render; "expensive work in render."
**Type:** Project-specific (the *shape* is universal; running a graph search here
is the repo's notable choice).

## Zoom out, then zoom in

You know the everyday version of this: a `const total = useMemo(() => items.reduce(...), [items])`.
Derived state — compute a value from source-of-truth during render instead of
storing it in its own `useState`. flattr does the same thing, except the "reduce"
is **A\* shortest-path search over a street graph**.

```
  Zoom out — where the route lives in the render

  ┌─ App layer (React / MapScreen) ───────────────────────────────┐
  │  source state: startPt, endPt, userMax, graph                 │
  │        │                                                       │
  │        ▼  useMemo (RENDER THREAD)                              │
  │  ★ routed = directedAstar(graph, startId, endId, userMax) ★    │ ← we are here
  │        │  → routeToGeoJSON + routeSummary                      │
  └────────┼───────────────────────────────────────────────────────┘
           │  data={routed.fc}
  ┌─ Native map layer (MapLibre) ▼────────────────────────────────┐
  │  <GeoJSONSource id="route"> <Layer id="route-line">           │
  └───────────────────────────────────────────────────────────────┘
```

The route is not stored anywhere. It is **recomputed from scratch every time its
inputs change**, inside a `useMemo`, on the JS thread, mid-render. That's the
concept: the route is *derived state*, and the derivation is a search algorithm.

## Structure pass

**Layers:** (1) source state in `MapScreen` → (2) a `useMemo` that runs A\* →
(3) GeoJSON props → (4) native MapLibre render.

**Axis — cost (where does CPU time go, on which thread?):**

```
  One axis: "who pays the CPU, and on which thread?"

  ┌─ source state change ─────────┐   cheap, JS thread
  │  setUserMax / setStartPt      │   → triggers re-render
  └──────────────┬────────────────┘
  ┌─ routed memo ▼────────────────┐   ★ EXPENSIVE, JS thread ★
  │  directedAstar (heap + search)│   → blocks the JS event loop
  └──────────────┬────────────────┘
  ┌─ native draw ▼────────────────┐   cheap for JS, native thread
  │  MapLibre renders the line    │   → gestures stay smooth regardless
  └───────────────────────────────┘
```

**Seam (load-bearing):** the `useMemo` boundary at `MapScreen.tsx:151`. Above it,
state changes are trivial. *At* it, the cost axis flips from "cheap" to "a graph
search blocks the thread." That's the boundary to study — and the one to move
work across if it ever janks.

## How it works

### Move 1 — the mental model

The shape is "input changed → recompute the answer, don't cache it as state."
React's `useMemo` is a guard: re-run the function only when a dep changes,
otherwise return the last result. flattr leans on that guard hard — the function
it guards is A\*.

```
  Pattern — derived state with an algorithm inside

   inputs:  graph ─┐
            startId ┼─► [ useMemo guard ]──► route GeoJSON + summary
            endId  ─┤        │
            userMax ┘        └─ deps unchanged → return cached result
                                deps changed   → RUN directedAstar again
```

The whole trick: A\* result = `f(graph, startId, endId, userMax)`. Pure function
of four inputs. Because it's pure, `useMemo` is *safe* to use — same inputs, same
output, no side effects. That's exactly why derived-in-render works here and
wouldn't if A\* touched the network or wrote state.

### Move 2 — the walkthrough

**The memo body** — `MapScreen.tsx:151–162`:

```tsx
const routed = useMemo(() => {
  if (!graph || !startId || !endId) {                    // ① guard: nothing to route yet
    return { fc: null, summary: null, found: true };     //    found:true = "no endpoints", not "no route"
  }
  const r = directedAstar(graph, startId, endId, userMax); // ② the search — runs on the JS thread
  if (!r.path) return { fc: null, summary: null, found: false }; // ③ found:false = genuinely no path
  return {
    fc: routeToGeoJSON(graph, r.path, userMax),          // ④ path → colored GeoJSON line
    summary: routeSummary(graph, r.path, userMax),       // ⑤ path → distance/climb/steep-count
    found: true,
  };
}, [graph, startId, endId, userMax]);                    // ⑥ deps — ANY change re-runs A*
```

Walk it:

**① The guard.** Bridge from what you know: this is the `loading`/`empty` branch
of a `fetch()` state machine, except it's synchronous. `found: true` with a null
`fc` means "no endpoints yet — show nothing," distinct from `found: false`
meaning "endpoints set, but A\* found no path." Two different UI states
(`RouteSummaryCard.tsx:17–24` reads exactly this). The boundary that bites:
conflating the two would show "No route" before the user has even picked points.

**② The search on the JS thread.** `directedAstar` is the repo's hand-rolled A\*
(binary-heap priority queue, admissible haversine heuristic — `study-dsa-foundations`
owns the algorithm). It runs **synchronously, inside render, on the JS thread.**
There is no `await`, no worker, no `InteractionManager`. While it runs, the JS
event loop is blocked: no other JS state update, no JS-driven overlay repaint.

```
  Layers-and-hops — what blocks and what doesn't during A*

  ┌─ JS thread ───────────────────────────────────────────┐
  │  render() → routed memo → directedAstar  ◄── BLOCKED   │
  │  (other setState, AddressBar typing, toggles wait)     │
  └───────────────────────────┬───────────────────────────┘
                              │ result crosses the bridge once
  ┌─ Native (UI) thread ──────▼───────────────────────────┐
  │  MapLibre pan/zoom/gestures  ◄── SMOOTH (separate)     │
  └───────────────────────────────────────────────────────┘
```

This is the part to name in an interview. RN runs JS on one thread and native UI
on another, so *map gestures stay buttery even mid-search* — but anything
JS-driven (the loading card, a button press, the slider) waits behind A\*.

**③–⑤ Path → render data.** `r.path` (a node-id list) becomes a colored GeoJSON
`LineString` (`routeToGeoJSON`) and a `RouteSummary` (`routeSummary`). Still pure,
still in the memo. The color comes from the signed grade vs `userMax`, which is
why `userMax` is a dep — bump the slider and the *same path* recolors (and may
re-route, since the cost function changes).

**⑥ The deps — the cost trap.** `[graph, startId, endId, userMax]`. Every one of
these changes often:
- `graph` changes on **every corridor/viewport tile load** (`useTileGraph`
  returns a new merged graph object).
- `startId`/`endId` change when endpoints re-snap as tiles load (pattern `04`).
- `userMax` changes on every preset tap.

So A\* re-runs on every tile that lands while a route is active. Today that's
fine — small graph, fast search. The honest read: **this is correct and cheap
now, and it's the first thing that janks if the covered area grows.** The deps
being tight is what makes it acceptable; if any dep changed identity needlessly
(e.g. a new `graph` object that's structurally identical), you'd pay for nothing.

### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (if it janks)
  ─────────────────────            ──────────────────────────
  A* in useMemo, render thread     A* off-thread (worklet /
  synchronous                      InteractionManager / worker)
  graph small → fast               result fed back as useState
  deps tight → bounded re-runs     memo just reads the state
  JS thread blocks briefly         JS thread never blocks on search
```

What *doesn't* change in the migration: `routeToGeoJSON`, `routeSummary`,
`RouteSummaryCard`, the `found`/`fc`/`summary` shape, and the layer. Only *where
A\* runs* moves. That's the payoff of keeping the search pure — it's relocatable.

### Move 3 — the principle

Derived-in-render is the right default: don't store what you can compute, and let
`useMemo` guard the cost. The line you watch is *how* expensive the derivation is
relative to the frame budget. A reduce is free. A graph search is free *until the
graph grows*. The skill isn't avoiding compute-in-render — it's knowing the one
dep that will eventually make it too expensive, and keeping the work pure so you
can move it off-thread without touching anything downstream.

## Primary diagram

```
  Render-thread A* — full picture

  ┌─ MapScreen source state ──────────────────────────────────────┐
  │  startPt/endPt ─► startId/endId (useMemo nearestNode)          │
  │  userMax ──────────────────┐                                   │
  │  graph (from useTileGraph) ─┤                                  │
  └────────────────────────────┼──────────────────────────────────┘
                               │ deps: [graph, startId, endId, userMax]
  ┌─ routed = useMemo (JS thread, render) ─▼──────────────────────┐
  │  guard → directedAstar → routeToGeoJSON + routeSummary        │
  │  out: { fc, summary, found }                                  │
  └───────────┬───────────────────────────────┬───────────────────┘
              │ fc                             │ summary, found
  ┌─ MapLibre ▼─────────────┐   ┌─ RouteSummaryCard ▼─────────────┐
  │ <GeoJSONSource id=route>│   │ "Flat all the way" / "No route" │
  │ <Layer route-line>      │   │ (reads found/summary)           │
  └─────────────────────────┘   └─────────────────────────────────┘
```

## Elaborate

Compute-in-render is the React-idiomatic answer to "where does derived data live"
— the alternative (mirror it into `useState` + a `useEffect` that recomputes) is
the classic anti-pattern that causes double-renders and stale data. flattr gets
the idiom right; it just happens to guard an unusually expensive function. The
deeper lineage is the same one behind spreadsheet recalculation and React Server
Components: declare the output as a function of inputs, let the framework decide
when to recompute. Read next: `study-runtime-systems` (why JS-thread blocking
matters), `study-performance-engineering` (how to measure the jank threshold),
`study-dsa-foundations` (the A\* and the heap).

## Interview defense

**Q: "Walk me through how the route gets on the map."**
The route is derived state — a `useMemo` at `MapScreen.tsx:151` that runs A\*
(`directedAstar`) over the current graph, then shapes the path into GeoJSON and a
summary. Source-of-truth is the two endpoint coordinates plus `userMax`; the
route is recomputed whenever any of those (or the graph) changes. It's stored
nowhere.

```
  startPt/endPt/userMax/graph ─► useMemo[A*] ─► GeoJSON ─► <Layer>
```
*Anchor: the route is a pure function of four inputs, guarded by useMemo.*

**Q: "What's the risk in that, and when does it bite?"**
A\* runs synchronously on the JS thread during render. The graph is small now so
it's fast, but the memo re-runs on every tile load and every slider tap, and the
search cost grows with coverage. When it gets slow it blocks the JS event loop —
map gestures stay smooth (native thread) but every JS-driven overlay freezes. The
fix is to move the search off-thread and feed the result back as state; because
A\* is pure, nothing downstream changes.

```
  JS thread:    render → A* (BLOCKS) ─────────┐
  Native thread: gestures stay smooth ◄────────┘ (separate thread)
```
*Anchor: the load-bearing fact people miss — RN's two-thread model means gestures
survive but JS overlays don't.*

**Q: "Why not store the route in `useState`?"**
Because then you'd need a `useEffect` to recompute it when endpoints change,
which double-renders and risks showing a stale route for one frame. Derived-in-
render is correct *because* A\* is pure — same inputs, same output, no side
effects — so the memo is the right guard.

## See also

- `04-coords-as-endpoint-state.md` — how `startId`/`endId` (two of the memo deps)
  are themselves derived.
- `03-declarative-data-driven-map-layers.md` — where `routed.fc` lands.
- `02-single-flight-pump.md` — why `graph` changes identity (each tile load),
  re-triggering this memo.
- `audit.md` §1, §8 (red flag #1).
