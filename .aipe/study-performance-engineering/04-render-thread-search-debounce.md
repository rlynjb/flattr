# Render-thread search + debounce — bounding work on the single JS thread

**Industry name:** synchronous compute-in-render + debounce + single-flight
(in-flight deduplication).
**Type:** Industry standard (the controls) applied to a project-specific hot path.

---

## Zoom out, then zoom in

React Native runs your JavaScript on **one thread**. Anything you compute
synchronously during render — including an A* search — blocks that thread, and
while it's blocked, nothing else paints, scrolls, or responds. flattr runs
`directedAstar` *inside a `useMemo` during render* (`MapScreen.tsx`). That's fine
today because the graph is tiny and the search is sub-millisecond — but the way
it's kept fine is the interesting part: a debounce, a single-flight pump, and hard
span caps that bound *how much* work can ever be queued up.

Here's where this lives — the route compute and the build pump straddle the
UI/network boundary.

```
  Zoom out — work on the single JS thread

  ┌─ UI thread (mobile/src/MapScreen.tsx) ─────────────────────────┐
  │  useMemo(() => directedAstar(graph, startId, endId, userMax))   │ ← SYNC search
  │  useMemo(() => graphToGeoJSON(graph, ...))   ← rebuild on userMax│
  │  nearestNode(graph, startPt)  ×2             ← O(N) per render   │
  └───────────────────────────────┬─────────────────────────────────┘
                                   │  region change / route request
  ┌─ useTileGraph.ts (work governor) ▼─────────────────────────────┐
  │  debounce(600ms) → pump() → ONE build at a time → setState      │ ← here
  └───────────────────────────────┬─────────────────────────────────┘
                                   │  Network boundary
  ┌─ Overpass + Open-Meteo (build-time I/O) ▼──────────────────────┐
  │  fetch streets + elevation → buildGraph                         │
  └─────────────────────────────────────────────────────────────────┘
```

The pattern: there's no worker thread here, so the defense is **bounding the
work** — collapse bursts (debounce), never run two builds at once
(single-flight), and refuse oversized inputs (span caps). The search stays cheap
because the graph it runs on is kept small and the rebuilds that feed it are rate-
limited.

## Structure pass

Trace the **control axis** — "who decides when expensive work runs?" — down the
layers. (Cost is the obvious axis; control is the one that makes the seams pop
here.)

```
  One question down the layers: "who decides when expensive work runs?"

  ┌─ React render (MapScreen) ─────────────────────────┐
  │ useMemo deps change → React decides to recompute    │  → REACT decides (eager)
  └───────────────────────┬─────────────────────────────┘
                          │  control flips at the build boundary
  ┌─ onRegionDidChange / ensureBbox ▼───────────────────┐
  │ debounce + covers() gate decide whether to even ask  │  → THE APP decides (gated)
  └───────────────────────┬──────────────────────────────┘
                          │  control flips again at the pump
  ┌─ pump() single-flight ▼──────────────────────────────┐
  │ runs one build; corridor before view; drains next     │  → THE PUMP decides (serialized)
  └────────────────────────────────────────────────────────┘
```

**Axis = control (who triggers work).** At the render layer React is *eager* —
any dep change recomputes the memo immediately, including the synchronous search.
At the region-change layer the app takes control back: a debounce and coverage
checks decide whether a fetch is even worth starting. At the pump layer control
narrows again: exactly one build runs, others wait in a single pending slot.

**Two load-bearing seams.** (1) The `useMemo` dependency array — it's the seam
that decides *which renders pay for a search*. Get the deps wrong (too broad) and
you run A* on renders that didn't change the route. (2) The `pump()` boundary —
the seam where unbounded user gestures (panning, typing) get converted into
bounded, serialized network work. The control axis flips hardest there: from "user
fires events as fast as they can pan" to "one build at a time, ever."

## How it works

### Move 1 — the mental model

You know how a `useMemo` recomputes only when its deps change, and how a debounced
search input waits for the user to stop typing before firing? This is both of
those, guarding an expensive compute. The search is a `useMemo` so it only re-runs
when the route inputs actually change; the *map panning and graph building* behind
it are debounced and serialized so a flurry of pan events doesn't kick off a flurry
of fetches.

The shape — eager memo in front, debounced single-flight behind:

```
  Bounded work on one thread

  user pans rapidly:  | | | | | |   (many region events)
                       \ \ \ | / /
  debounce(600ms):           ▼       (collapse burst → one)
                        [ pending bbox ]
  pump (single-flight):      ▼
                    busy? ── yes ──► drop (will drain later)
                       │
                       no
                       ▼
                  ONE build runs ──► setState ──► graph changes
                                                     │
  render:                                            ▼
                     useMemo(directedAstar) re-runs ONCE (sync, on JS thread)
```

### Move 2 — the step-by-step walkthrough

#### Part 1 — the search is synchronous in render

`directedAstar` runs inside a `useMemo` whose deps are `[graph, startId, endId,
userMax]`. When any of those change, React re-runs the memo *during render* — on
the JS thread, blocking. **Drop the `useMemo` (call it inline) and the search re-runs
on every render, even ones that didn't touch the route** — typing in an unrelated
field would re-route. The memo is the gate that limits the search to renders that
actually changed a route input.

```
  Compute-in-render — the search blocks the thread it renders on

  render() {
    routed = useMemo(
      () => directedAstar(graph, startId, endId, userMax),  ← SYNC, blocks JS thread
      [graph, startId, endId, userMax]                      ← only these re-trigger it
    )
    return <Map>...{routed.fc}...</Map>
  }
  ↑ while directedAstar runs, NOTHING else on the JS thread proceeds.
    Safe ONLY because the graph is small (1621 nodes → sub-ms).
```

#### Part 2 — debounce collapses the pan burst

Map panning fires `onRegionDidChange` continuously. Each one could trigger a graph
fetch. The debounce holds a 600 ms timer that resets on every event, so only the
*last* region in a burst actually schedules a fetch. **Drop the debounce and every
intermediate pan frame fires a fetch** — dozens of Overpass round-trips for one
gesture, instantly blowing the free-tier rate limit.

```
  Debounce — reset the timer on every event, fire only on the lull

  events:  ──e──e─e──e────────e│(600ms quiet)──► fetch(last bbox)
                                └ timer survives the gap → fires once
```

#### Part 3 — coverage gates skip redundant work

Before scheduling, the app checks: is this bbox already inside the base graph, or
the current viewport region? If so, skip — the data's already loaded.
**Drop the coverage check and you refetch areas you already have**, wasting the
most expensive resource (network) on data in memory. This is caching by
containment: the loaded regions *are* the cache, and `covers()`/`bboxContains()`
are the cache-hit test.

```
  Coverage gate — the loaded regions are the cache

  requested bbox ── inside base graph?      ─ yes ─► skip (hit)
                 ── inside current viewport? ─ yes ─► skip (hit)
                 ── otherwise               ────────► schedule fetch (miss)
```

#### Part 4 — the single-flight pump (the backpressure core)

This is the load-bearing skeleton. `pump()` runs **one build at a time**: if a
build is already in flight (`busyRef`), return immediately. Pending requests sit
in two slots — `pendingCorridorRef` and `pendingViewRef` — and the pump always
drains the corridor (route) before the view (pan), so a pending route isn't
starved. When a build finishes, the `finally` calls `pump()` again to drain the
next. **Drop the single-flight and concurrent builds pile onto the one JS thread
and the rate-limited APIs at once** — the screen stalls and the APIs 429.

```
  Single-flight pump — one build, corridor priority, self-draining

  pump():
    if busy: return                       ← in-flight dedup (backpressure)
    pick = pendingCorridor ?? pendingView ← corridor wins (route not starved)
    if none: return
    busy = true
    build(pick) ──finally──► busy = false; pump()  ← drain next
```

#### Part 5 — hard span caps refuse oversized work

Two ceilings: `MAX_LOAD_SPAN_DEG` (don't fetch when zoomed out past a few km) and
`MAX_CORRIDOR_SPAN_DEG` (~13 km — refuse routes too far apart). **Drop the caps
and one zoomed-out gesture asks for a continent of streets** — an unbounded fetch
and an unbounded graph the synchronous search would then choke on. The caps are
the input-size bound that keeps Part 1 (the sync search) safe.

#### Execution trace — a pan burst into one build

```
  Trace — user pans, then the build runs

  t=0ms    onRegionDidChange(bbox1) → clearTimeout, setTimeout(600)
  t=120ms  onRegionDidChange(bbox2) → clearTimeout, setTimeout(600)   ← resets
  t=300ms  onRegionDidChange(bbox3) → clearTimeout, setTimeout(600)   ← resets
  t=900ms  timer fires → covers(view, bbox3)? no → pendingView=bbox3 → pump()
           busy=false → build bbox3 (corridor empty) → busy=true
  t≈1.6s   build done → setView(region) → busy=false → pump() (nothing pending)
           render: graph changed → useMemo re-runs directedAstar ONCE
```

### Move 2.5 — current state vs the scale wall

**Now:** synchronous search is fine — graph is 1621 nodes, search is sub-ms
(measured bench), and the bounds keep it that way. **The wall:** if coverage grows
to a large city, the synchronous search (and the O(N) `nearestNode` twice per
render, see `06`) would start blocking visibly — dropped frames, janky pan.

```
  Phase A (now, safe)               Phase B (city scale, blocks)
  ──────────────────                ─────────────────────────────
  1621-node graph                   100k+ node graph
  directedAstar sub-ms              directedAstar tens of ms
  → invisible on JS thread          → dropped frames during pan
  bounded by span caps              caps still help, but the per-search
                                      cost itself crosses the frame budget
  fix: NONE NEEDED                  fix: move search off the JS thread
                                      (InteractionManager / worklet / native),
                                      + spatial index for nearestNode (06)
                                    → NOT YET BUILT
```

The takeaway is *what doesn't have to change*: the bounding controls (debounce,
pump, caps) are already the right shape; only the *placement* of the compute
(on-thread vs off-thread) would move. The search itself is correct and fast per
node — it's the thread it runs on that becomes the constraint.

### Move 3 — the principle

The general lesson: **with one thread and no worker, you don't make the work
faster — you make there be less of it, less often.** Debounce collapses
frequency, single-flight collapses concurrency, span caps collapse size, and a
memo collapses redundant recompute. Each is a different axis of "bound the work,"
and together they keep a synchronous compute on a shared thread from ever getting
large enough to hurt. When the work itself eventually outgrows the thread, the
move is to relocate it (worker/native), not to bound it harder.

## Primary diagram

The whole governor — eager memo in front, bounded pipeline behind.

```
  Render-thread search + debounce, end to end

  ┌─ UI thread: MapScreen render ──────────────────────────────────┐
  │  inputs: startPt/endPt (coords), userMax, graph                 │
  │  startId/endId = nearestNode(graph, pt)  ×2   (O(N), see 06)    │
  │  routed = useMemo(directedAstar, [graph,startId,endId,userMax]) │ ← SYNC search
  │  heatmap = useMemo(graphToGeoJSON, [graph,userMax])  ← rebuild   │
  └───────────────────────────────┬─────────────────────────────────┘
            region change / ensureBbox │ (gestures, route request)
  ┌─ useTileGraph governor ────────────▼───────────────────────────┐
  │  debounce 600ms → covers() gate → pendingView / pendingCorridor │
  │  pump(): busy? return : run ONE build (corridor first) → setState│
  │  caps: MAX_LOAD_SPAN_DEG, MAX_CORRIDOR_SPAN_DEG (refuse oversize)│
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  Network boundary (rate-limited)
  ┌─ Overpass + Open-Meteo ────────▼───────────────────────────────┐
  │  fetchOverpass → buildGraph(bestEffortElevation) → prefixGraph  │
  └─────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases in this repo.** Three: (1) routing on every render where both
endpoints are set (`MapScreen.tsx:143-154`); (2) loading streets/grades as the
user pans (`useTileGraph.ts` `onRegionDidChange`); (3) bulk-loading the corridor
between two endpoints so they connect (`MapScreen.tsx:131-140` → `ensureBbox`).

**The synchronous search in render** (`mobile/src/MapScreen.tsx`):

```
  mobile/src/MapScreen.tsx  (lines 143-154)

  const routed = useMemo(() => {
    if (!graph || !startId || !endId) return { fc: null, summary: null, found: true };
    const r = directedAstar(graph, startId, endId, userMax);   ← SYNC, on JS thread
    if (!r.path) return { fc: null, summary: null, found: false };
    return {
      fc: routeToGeoJSON(graph, r.path, userMax),
      summary: routeSummary(graph, r.path, userMax),
      found: true,
    };
  }, [graph, startId, endId, userMax]);                        ← only these re-run it
       │
       └─ the dep array is the gate: A* runs only when graph/endpoints/userMax
          change, not on every render. Safe because the graph is small. At city
          scale this line is the first thing to move off the JS thread.
```

**The single-flight pump** (`mobile/src/useTileGraph.ts`):

```
  mobile/src/useTileGraph.ts  (lines 89-129)

  const pump = useCallback(() => {
    if (busyRef.current) return;                    ← in-flight dedup (backpressure)
    let kind, bbox;
    if (pendingCorridorRef.current) {               ← corridor BEFORE view (priority)
      kind = "corridor"; bbox = pendingCorridorRef.current; pendingCorridorRef.current = null;
    } else if (pendingViewRef.current) {
      kind = "view"; bbox = pendingViewRef.current; pendingViewRef.current = null;
    } else return;
    busyRef.current = true;
    (async () => {
      try {
        const osm = await fetchOverpass(bbox);
        const elev = bestEffortElevation(openMeteoProvider(fetch, {delayMs:400, retries:1}));
        const g = await buildGraph(kind, bbox, osm, elev, ...);
        ... setView / setCorridor(region) ...
      } catch { /* keep last region; a later pan retries */ }
      finally {
        busyRef.current = false;
        setLoadingStep(null);
        pump();                                       ← drain the next pending (corridor first)
      }
    })();
  }, []);
       │
       └─ busyRef + the two pending slots ARE the backpressure: unbounded gestures
          collapse into at most one in-flight build and one queued bbox per kind.
          The finally→pump() is the self-draining loop. Remove busyRef and a pan
          burst launches concurrent Overpass calls → 429 + JS-thread contention.
```

**The debounce + coverage gate** (`mobile/src/useTileGraph.ts`):

```
  mobile/src/useTileGraph.ts  (lines 30, 131-151)

  const DEBOUNCE_MS = 600;
  ...
  const onRegionDidChange = useCallback((e) => {
    const { bounds } = e.nativeEvent;
    if (bounds[2]-bounds[0] > MAX_LOAD_SPAN_DEG || bounds[3]-bounds[1] > MAX_LOAD_SPAN_DEG)
      return;                                         ← span cap: zoomed out too far → skip
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;   ← coverage hit → skip
      if (covers(viewRef.current, bounds)) return;                     ← coverage hit → skip
      ...
      pendingViewRef.current = [w-px, s-py, e+px, n+py];               ← pad so small pans don't refetch
      pump();
    }, DEBOUNCE_MS);
  }, [baseGraph, pump]);
       │
       └─ clearTimeout-on-every-event is the debounce; the two coverage checks are
          cache hits against loaded regions; VIEW_PAD widens the fetch so a tiny pan
          stays a hit. Three independent ways to NOT do work, stacked.
```

## Elaborate

Compute-in-render is a known React smell *when the compute is heavy* — the
canonical fix is `useMemo` (which this uses) and, when that's not enough, moving
off the main thread. In React Native that means `InteractionManager.runAfterInteractions`,
a JS worklet (reanimated/worklets-core — which you've used in `contrl` for the
frame-budget ML pipeline), or pushing the search into native. The single-flight
pump is the same shape as a mutex-guarded job queue or a debounced-save with
in-flight dedup — the `busyRef` boolean is a one-slot semaphore. The corridor-
before-view priority is a tiny scheduler: two priority classes, strict
preemption-free ordering. The whole governor is "backpressure without a queue
library" — refs and a boolean — which is the right amount of machinery for a
single-user app and would be wrong for a multi-tenant server (you'd want a real
bounded queue).

Read next: `06-linear-nearest-node-scan.md` (the other per-render cost on this
thread), `05-elevation-batching-and-dedup.md` (what the pump's builds actually do
over the network). The sibling `.aipe/study-runtime-systems/` owns the JS-thread
execution model; `.aipe/study-system-design/` owns the scale-limit tradeoff.

## Interview defense

**Q: "You run A* synchronously during render on React Native's single JS thread.
Isn't that going to block the UI?"**

It would if the graph were large — and that's exactly why I bound the graph
instead of the search. The graph is ~1600 nodes, so A* is sub-millisecond; it's in
a `useMemo` so it only re-runs when the route inputs change. The real defense is
upstream: panning is debounced (600 ms), graph builds run one-at-a-time through a
single-flight pump, and span caps refuse oversized areas. So the search never gets
a graph big enough to block. At city scale I'd move the search off-thread —
InteractionManager or a worklet — but the bounding controls stay the same.

```
  bound the WORK, not the algorithm:
  debounce (frequency) + single-flight (concurrency) + caps (size) + memo (recompute)
  → graph stays small → sync A* stays sub-ms
```

Anchor: *one thread, no worker — so the fix is less work less often, not faster
work.*

**Q: "What's the load-bearing part of the pump people forget?"**

The `finally → pump()` self-drain, plus corridor-before-view priority. The
`busyRef` boolean is the obvious part (one build at a time), but if you forget to
re-pump in the `finally`, a queued request sits forever after the current build
finishes — the screen silently stops loading. And without corridor priority, a
user panning while a route is pending would starve the route behind viewport
fetches.

```
  build done → finally → busy=false → pump() → drain next (corridor first)
  miss the re-pump → pending request stuck forever
```

Anchor: *the single-flight isn't just "don't run two" — it's "and always drain the
next when one finishes."*

## Validate

1. **Reconstruct.** From memory, write the `pump()` control flow: the busy check,
   the corridor-before-view pick, and the self-drain. (Check `useTileGraph.ts:89-129`.)
   What breaks if you remove the `finally`'s `pump()`?
2. **Explain.** Why is `directedAstar` wrapped in `useMemo` with deps
   `[graph, startId, endId, userMax]` rather than called inline?
   (`MapScreen.tsx:143-154`.) Which renders would re-route without the memo?
3. **Apply.** A user pans the map quickly across a new area. Trace what happens
   from `onRegionDidChange` to the route re-rendering, naming the debounce, the
   coverage gate, and the pump. (`useTileGraph.ts:131-151`, `:89-129`.)
4. **Defend.** The graph grows to a large city and pans get janky. Argue what you
   move and what you keep, citing the span caps (`useTileGraph.ts:31,34`), the
   sync search (`MapScreen.tsx:147`), and `nearestNode` (`06`).

## See also

- `01-heuristic-pruning.md` — why the search is cheap per call.
- `06-linear-nearest-node-scan.md` — the other O(N) per-render cost.
- `05-elevation-batching-and-dedup.md` — what the pump's builds do over the wire.
- `.aipe/study-runtime-systems/` — the single JS thread execution model.
- `.aipe/study-system-design/` — the scale-limit architecture tradeoff.
