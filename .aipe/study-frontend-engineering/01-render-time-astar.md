# Render-time A\* — routing computed inside `useMemo`

**Industry name(s):** derived state via memoized selector / compute-in-render. **Type:**
Project-specific (the *placement* — running a graph search on the render thread — is the notable part;
`useMemo` itself is industry-standard).

## Zoom out, then zoom in

You know how `useMemo` is the standard place to put a derived value — filtering a list, formatting a
date, anything you don't want to recompute on every keystroke? flattr puts an *entire A\* shortest-path
search* in one. The router isn't an effect, isn't a worker, isn't a service call — it's a pure function
of `(graph, startId, endId, userMax)` evaluated during render.

```
  Zoom out — where the router sits in the frontend

  ┌─ UI layer (mobile/src) ──────────────────────────────────────┐
  │  MapScreen render pass                                        │
  │    useMemo: startId/endId  (nearestNode)                      │
  │    useMemo: ★ routed = directedAstar(...) ★  ← we are here    │
  │    JSX: <GeoJSONSource data={routed.fc}>                      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ calls into shared engine
  ┌─ engine (features/routing) ▼─────────────────────────────────┐
  │  astar.ts  →  pqueue.ts (binary heap)  →  cost.ts            │
  └───────────────────────────────────────────────────────────────┘
```

The router lives in the *render path of a component*. That's the whole point of this file: not what A\*
is (that's `study-dsa-foundations`), but what it means to run it where React runs render.

## Structure pass

**Layers:** (1) React render pass in `MapScreen`, (2) the `useMemo` selector that calls the router,
(3) the pure engine function `directedAstar`.

**Axis traced — "when does this work run?"** Hold that one question across the layers:

```
  axis = "when does the route get computed?"

  ┌─ MapScreen render ──────────┐  every render React calls the
  │  React decides to re-render │  function body top to bottom
  └──────────────┬──────────────┘
                 │ seam: useMemo dep-array gate
  ┌─ routed memo ▼──────────────┐  runs ONLY if graph/startId/
  │  recompute IFF deps changed │  endId/userMax changed
  └──────────────┬──────────────┘
                 │ seam: pure function call (sync, blocking)
  ┌─ directedAstar ▼────────────┐  runs to completion on the
  │  full graph search, sync    │  JS thread before render returns
  └─────────────────────────────┘
```

**The load-bearing seam is the `useMemo` dependency array** (`MapScreen.tsx:162`). That array is the
only thing standing between "recompute the route" and "reuse last route." Everything about the
performance profile flips across that seam: above it, React's render cadence (fast, frequent); below it,
a blocking graph search (potentially slow). When the dep array is right, the search runs only on real
input changes. When it's wrong, you either recompute A\* on every render (jank) or serve a stale route
(correctness bug).

## How it works

### Move 1 — the mental model

The shape is a **memoized selector**: inputs in, derived value out, cached until an input changes. You've
built this a hundred times — `const filtered = useMemo(() => items.filter(...), [items, query])`. flattr's
version just has a much heavier function in the slot.

```
  the memoized-selector shape

   inputs ───────────────►  pure fn  ───────────────►  cached output
   graph                    directedAstar             { fc, summary, found }
   startId                       │                          │
   endId                    deps unchanged?  ── yes ──► reuse last value
   userMax                       │ no
                                 ▼
                            recompute (blocking)
```

The strategy: treat the route as *derived state*, not *stored state*. There is no `setRoute(...)`
anywhere. The route is never in `useState` — it's recomputed from the source-of-truth inputs every time
one of them moves. That's the right instinct (no stale-route bug possible). The cost is *where* the
recompute happens.

### Move 2 — the walkthrough

**The selector itself.** Here's the actual code, annotated (`MapScreen.tsx:151-162`):

```ts
const routed = useMemo(() => {
  if (!graph || !startId || !endId) {                    // guard: nothing to route yet →
    return { fc: null, summary: null, found: true };     //   found:true means "no error, just empty"
  }
  const r = directedAstar(graph, startId, endId, userMax); // ← the blocking search, on the JS thread
  if (!r.path) return { fc: null, summary: null, found: false }; // found:false = "no route exists"
  return {
    fc: routeToGeoJSON(graph, r.path, userMax),          // path → colored GeoJSON for the map layer
    summary: routeSummary(graph, r.path, userMax),       // path → {distanceM, climbM, steepCount}
    found: true,
  };
}, [graph, startId, endId, userMax]);                    // ← the seam: recompute gate
```

Read the return shapes carefully — `found` is a three-way signal folded into the result, not a separate
state. `found:true + fc:null` = "no endpoints yet." `found:false` = "endpoints set, but disconnected."
`found:true + fc:set` = "here's your route." `RouteSummaryCard` decodes this (`RouteSummaryCard.tsx:17-24`).
That's a clean way to avoid a separate `routeError` state for the "no route" case.

**What triggers a recompute.** Four deps, and the *interesting* one is `graph`. Watch the chain:

```
  recompute triggers — execution trace

  user drags userMax slider 8 → 5
     └─► userMax state changes → MapScreen re-renders
         └─► routed deps changed (userMax) → A* re-runs → new fc

  corridor tile lands (useTileGraph)
     └─► graph useMemo rebuilds (new merged graph)
         └─► startId/endId re-derive (nearestNode on new graph)  [02]
             └─► routed deps changed (graph + maybe ids) → A* re-runs
                 └─► route re-snaps and reconnects across the new tile
```

That second path is the elegant part: when a tile loads mid-route, the graph changes, the ids re-snap,
and A\* automatically re-runs against the now-connected corridor. You never wrote "recompute the route
when a tile arrives" — it falls out of the dependency graph. → `02-coords-not-ids-endpoints.md` for the
id re-derivation, `03-single-flight-tile-pump.md` for what makes `graph` change.

**Where it bites: the single JS thread.** `directedAstar` is synchronous. React calls your component
function, hits the `useMemo`, and *blocks inside A\** until it returns — nothing else on the JS thread
runs in that window.

```
  Layers-and-hops — the blocking window on the JS thread

  ┌─ JS thread (single) ──────────────────────────────────────────┐
  │  React render starts                                           │
  │    │ hop: call routed memo                                     │
  │    ▼                                                           │
  │  directedAstar runs ███████████████  ← UI frozen this whole    │
  │    │ hop: returns fc                     window, no input/      │
  │    ▼                                     gesture processed      │
  │  render returns → commit → native draw                        │
  └────────────────────────────────────────────────────────────────┘
  ┌─ native thread (MapLibre) ────────────────────────────────────┐
  │  map keeps panning — but new GeoJSON only lands after commit   │
  └────────────────────────────────────────────────────────────────┘
```

On the bundled Capitol Hill base graph this is imperceptible. On a wide merged corridor it's a real cost,
and it's *inferred* here, not measured — the structure guarantees the coupling; `study-performance-
engineering` owns the millisecond number. The honest read: this was the right call for the project's
scope (one neighborhood, hand-rolled engine, "the graph work is the point"), and it's the first thing
you'd move to `useTransition` or a worklet if the graph grew.

### Move 2.5 — current vs future

```
  Phase A (now)                    Phase B (if graph grows)
  ───────────────                  ────────────────────────
  A* in useMemo, sync,             A* wrapped in useTransition
  blocks JS thread                 (keeps UI responsive, route
                                   updates as a low-pri render)
                                   — OR moved to a Worklet/worker
  fine for one neighborhood        needed past ~1 city of edges

  what does NOT change: the selector shape. routed stays derived
  from (graph, startId, endId, userMax). Only the *scheduling*
  changes — same inputs, same output, same dep array.
```

That's the payoff of keeping the route as derived state: the migration is a scheduling change, not a
state-architecture rewrite.

### Move 3 — the principle

Derive, don't store, when the value is a pure function of state you already own — it makes stale state
structurally impossible. The tradeoff you accept is *when* the derivation runs: a `useMemo` runs on the
render thread, so the heavier the function, the more it couples compute cost to your frame budget. Cheap
derivations belong in render; expensive ones eventually need a scheduler (`useTransition`) or a different
thread (worker/worklet) — but they can keep the exact same selector shape.

## Primary diagram

```
  Render-time A* — full picture

  ┌─ MapScreen render pass (JS thread) ───────────────────────────┐
  │                                                               │
  │  source state ──► startId/endId memo ──► routed memo          │
  │  graph,startPt,        (nearestNode)        (directedAstar)   │
  │  endPt,userMax              │                    │            │
  │                            deps                 deps          │
  │                       [graph,startPt]    [graph,startId,      │
  │                       [graph,endPt]       endId,userMax]      │
  │                                                 │             │
  │                                  ┌──────────────┴───────────┐ │
  │                                  │ {fc, summary, found}      │ │
  │                                  └──────┬──────────┬─────────┘ │
  └─────────────────────────────────────────┼──────────┼──────────┘
                                            │ fc       │ summary+found
                                            ▼          ▼
                            ┌─ MapLibre GeoJSONSource ─┐  ┌─ RouteSummaryCard ─┐
                            │  route-line layer (:296) │  │  card (:367)       │
                            └──────────────────────────┘  └────────────────────┘
```

## Elaborate

Compute-in-render with memoization is the React idiom that replaced the old "store derived data in state
and keep it in sync with an effect" anti-pattern (the source of countless stale-state bugs). The React
docs explicitly recommend deriving during render over `useEffect`+`setState` for anything computable from
existing state. flattr follows this correctly — the *only* unusual thing is the weight of the function.

The escape hatches when a render-time derivation gets too heavy, in order of reach: `useMemo` (already
here, caches across renders), `useDeferredValue`/`useTransition` (React 19 is installed — keeps the old
value visible while the new one computes at low priority), then off-thread (a worker, or a Reanimated
worklet given this is RN). Read next: `03-single-flight-tile-pump.md` (what makes `graph` change),
`02-coords-not-ids-endpoints.md` (the id derivation feeding this memo).

## Interview defense

**Q: Why is running A\* in a `useMemo` risky, and what's the load-bearing part people forget?**

The risk is the dependency array. `useMemo` memoizes on a shallow compare of its deps — the part people
forget is that if a dep is a freshly-built object each render (like a graph rebuilt by another memo), the
compare *fails every render* and the "memoized" search runs every time. Here `graph` is itself a `useMemo`
output (`useTileGraph.ts:132-145`), so it's stable *unless its own deps change* — which is exactly the
behavior you want, but it only works because the upstream memo is disciplined. Get that wrong and A\* runs
on every keystroke.

```
  the dep-array seam — the part that breaks if you forget

  stable graph memo ──► routed memo recomputes only on real change  ✓
  graph rebuilt inline ──► routed recomputes EVERY render (jank)     ✗
```

**Anchor:** "The route is derived state in a `useMemo`, gated by `[graph, startId, endId, userMax]` — so
stale routes are impossible by construction, and the only cost is that A\* runs on the JS render thread,
which is fine for one neighborhood and would move to `useTransition` if the graph grew."

**Q: How does the route update when a map tile finishes loading?**

I never wrote a "tile loaded → recompute route" handler. The tile-fetch hook rebuilds the merged `graph`
memo; `graph` is a dep of the `routed` memo; A\* re-runs automatically. It's reactive data flow, not an
imperative callback — that's the value of keeping the route derived.

## See also

- `02-coords-not-ids-endpoints.md` — the `startId`/`endId` derivation that feeds this memo
- `03-single-flight-tile-pump.md` — what makes the `graph` dependency change
- `04-data-driven-map-layers.md` — where `routed.fc` is consumed
- `study-dsa-foundations` — the A\* algorithm internals (heuristic, priority queue)
- `study-runtime-systems` — why a sync function in render blocks the single JS thread
- `study-performance-engineering` — the actual cost in milliseconds
