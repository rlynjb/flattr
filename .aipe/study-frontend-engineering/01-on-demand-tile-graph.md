# On-Demand Tile Graph with Single-Flight Pump
### industry names: incremental data loading + single-flight / request coalescing — Project-specific (custom hook)

---

## Zoom out, then zoom in

The whole app keys off one data structure: a `Graph` of grade-annotated
streets. The bundled `graph.json` only covers one neighborhood (Capitol Hill).
The moment the user pans away or routes to a distant address, you need *more*
graph than you shipped — fetched live, stitched into what you already have,
without firing fifty overlapping requests at a rate-limited free API.

That's this hook's job. Here's where it sits.

```
  Zoom out — where useTileGraph lives in the data flow

  ┌─ UI layer (MapScreen.tsx) ───────────────────────────────┐
  │  pan map ─► onRegionDidChange   set endpoints ─► ensureBbox│
  └──────────────────────────┬────────────────────────────────┘
                            │  calls into the hook
  ┌─ Hook layer (useTileGraph.ts) ★ THIS CONCEPT ★ ──────────┐ ← we are here
  │  debounce → pump() single-flight gate → setState(region)  │
  │  graph = stitch(merge(base, corridor, view))              │
  └──────────────────────────┬────────────────────────────────┘
                            │  async network build
  ┌─ Network / build layer ──▼────────────────────────────────┐
  │  fetchOverpass → buildGraph → openMeteo elevation          │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: it's a **custom hook that wraps a static base graph and lazily
extends it** with two kinds of fetched region — the *viewport* (what's on
screen) and the *corridor* (the box spanning both route endpoints) — while
guaranteeing only one fetch runs at a time, corridor first. The question it
answers: *how do I give the UI an always-current `graph` without ever
overrunning the rate limit?*

---

## Structure pass

**Layers** — three nested levels inside the hook:

```
  outer:  the merged graph         (what the UI reads: one `graph` value)
  middle: region cache + triggers  (view/corridor state, debounce, ensureBbox)
  inner:  the pump (single-flight)  (the one place a fetch actually fires)
```

**Axis traced — "who controls when a fetch happens?"** Hold that one question
across the layers:

```
  axis = "who decides a network fetch fires?"  — trace it downward

  ┌─────────────────────────────────────────────┐
  │ outer: the UI                                │ → USER GESTURE decides
  │   (pan, set endpoints) just signals intent   │   (pan / route)
  └───────────────────┬─────────────────────────┘
      ┌───────────────▼───────────────────────────┐
      │ middle: debounce + coverage checks         │ → POLICY decides
      │   "is this already covered? settled 600ms?"│   (skip or queue)
      └───────────────┬───────────────────────────┘
          ┌───────────▼───────────────────────────┐
          │ inner: pump() + busyRef                │ → THE GATE decides
          │   "am I free? what's highest priority?"│   (run exactly one)
          └─────────────────────────────────────────┘
```

The answer flips at each altitude: the user *wants* a fetch, policy decides
*whether it's worth one*, the gate decides *which one and when*. That contrast
is the lesson — three different controllers, one for each layer.

**Seams** — two load-bearing boundaries:

- **UI ↔ hook seam** (`onRegionDidChange` / `ensureBbox`): the UI hands over
  *bounds*, not requests. Control of *whether and when* flips from caller to
  hook here. This is the seam you'd mock to test the hook.
- **state ↔ ref seam** *inside* the hook: `view`/`corridor` state drive
  re-render; `busyRef`/`pendingRef`/`viewRef` hold control state read
  synchronously. The axis "is this value allowed to be stale within a tick?"
  flips here — state can lag a render, refs cannot.

Now the mechanics hang on that skeleton.

---

## How it works

### Move 1 — the mental model

You already know the shape: it's a **debounced fetch feeding a cache, behind a
mutex**. Same primitive as a typeahead that won't fire on every keystroke and
won't let two in-flight requests clobber each other — except here the "cache"
is a merged graph and the "mutex" is a boolean ref called `busyRef`.

The kernel is a single-flight queue with priority:

```
  Single-flight pump — the kernel shape

         requests arrive (debounced)
        ┌──────────────┬──────────────┐
        │ pendingCorridor  pendingView │   ← two slots, latest wins each
        └──────┬───────────────┬───────┘
               │   pump()      │
               ▼               ▼
        ┌─────────────────────────────┐
        │  busyRef === false ?         │  ← the gate
        │     yes → take ONE           │  corridor checked first (priority)
        │     no  → return (try later) │
        └──────────────┬──────────────┘
                       │ run async build
                       ▼
            on finish: busyRef=false; pump() again  ← drains next
```

One plain sentence: **debounce intent into two latest-wins slots, then let a
self-recursive pump drain them one at a time, corridor before viewport.**

### Move 2 — the step-by-step walkthrough

#### The merged graph is derived, not assembled imperatively

You know `useMemo` for "recompute this value when its inputs change." The
`graph` the UI reads is exactly that: merge the base graph with whatever
corridor and view regions exist, then stitch coincident boundary nodes so a
path can cross from one independently-built region into another. When `view`
or `corridor` state changes, the merged graph recomputes; nothing mutates in
place.

```
  Deriving the displayed graph

  base ──┐
  corridor ─┼─► mergeGraphs([...]) ─► stitchGraph(...) ─► graph
  view ──┘        (union nodes/edges)   (zero-length connector
                                          edges at shared coords)
```

The boundary condition: without `stitchGraph`, each region is built
independently with prefixed ids (`base:`, `view:`, `corridor:`), so two nodes
at the *same coordinate* from different regions aren't linked — routing would
hit a wall at every seam. Stitch is what makes the union *connected*.

#### Debounce turns a flood of pan events into one settled request

`onRegionDidChange` fires constantly while the map moves. You know the move:
clear the prior timer, set a new one, only act when the gesture settles
(600 ms here). Inside the settled callback, two coverage checks act as the
cache hit — if the base graph or the current viewport already contains the
new bounds, return without queueing anything.

```
  Debounce + coverage gate (the viewport trigger)

  pan event ──► clearTimeout(prev) ; setTimeout(600ms, () => {
                  if base covers bounds      → return  (cache hit)
                  if current view covers it  → return  (cache hit)
                  else pendingView = padded(bounds) ; pump()
                })
```

Boundary condition: drop the coverage checks and every micro-pan inside the
already-loaded area queues a redundant Overpass build — straight into the rate
limit.

#### The pump is the single-flight gate — the load-bearing part

This is the kernel. `busyRef` is a boolean held in a ref (not state) because
`pump` must read it *synchronously* the instant it's called — it cannot wait
for a re-render to learn whether a build is already running. If `busyRef` is
true, return immediately. Otherwise pick one pending request — **corridor
before view, always** — flip `busyRef` true, run the async build, and in the
`finally` flip it back and call `pump()` again to drain the next.

```
  pump() — the priority single-flight gate (pseudocode)

  function pump():
    if busyRef is true: return                 // already building — bail
    if pendingCorridor exists:                 // corridor wins priority
        kind = "corridor"; bbox = pendingCorridor; pendingCorridor = null
    else if pendingView exists:
        kind = "view";     bbox = pendingView;     pendingView = null
    else:
        return                                 // nothing to do
    busyRef = true                             // claim the lock
    run async:
        osm  = await fetchOverpass(bbox)
        elev = bestEffortElevation(openMeteo)  // flat-on-failure
        g    = await buildGraph(kind, bbox, osm, elev, ...)
        setState(region = prefixGraph(g, kind))  // triggers re-render
    finally:
        busyRef = false                        // release the lock
        pump()                                 // drain the next (corridor first)
```

What breaks if you remove each part:

- **drop `busyRef`** → two builds run concurrently → two Overpass + two
  Open-Meteo round-trips at once → 429 rate-limit, the exact failure the user
  flagged.
- **drop the corridor-first check** → a pending route fetch gets starved by
  continuous panning; the user taps Route and the line never appears because
  viewport builds keep jumping the queue.
- **drop the recursive `pump()` in `finally`** → the second queued request
  never fires; pan-then-pan loads only the first region.

Skeleton vs hardening: the gate + the two slots + the recursive drain are the
skeleton. `bestEffortElevation` (degrade to flat instead of failing), the
`VIEW_PAD` padding so small pans don't refetch, and the `MAX_LOAD_SPAN_DEG`
zoom guard are hardening layered on top.

#### Latest-wins slots, not a queue of every request

The two `pending*Ref` slots hold *one* bbox each. A newer pan overwrites the
older pending view. You don't want a backlog of stale viewports — by the time
the gate frees up, only the *latest* view matters. This is request coalescing:
collapse N intents into the most-recent-1.

#### ensureBbox is the corridor trigger, and it can refuse

When both endpoints are set, an effect in `MapScreen` computes the box spanning
them (+ margin) and calls `ensureBbox`. It checks coverage against the current
corridor (cache hit → return true), and refuses outright if the span is wider
than `MAX_CORRIDOR_SPAN_DEG` (~13 km) by returning false — too far to route.
Otherwise it sets `pendingCorridor` and pumps.

```
  ensureBbox — the corridor trigger (UI → hook seam)

  both endpoints set ──► ensureBbox(spanBox):
      if span too wide        → return false   (UI shows "too far")
      if corridor covers it   → return true    (cache hit)
      else pendingCorridor = spanBox ; pump() ; return true
```

### Move 3 — the principle

**When fetches are expensive and rate-limited, the UI should express *intent*
and a single gate should decide *execution*.** The user pans and types as fast
as they like; debounce + coverage + single-flight collapse that into the
minimum number of builds, in priority order. The general lesson:
separate "what the user wants loaded" from "what actually gets fetched, and
when" — and put a mutex between them.

---

## Primary diagram

The full picture — triggers, debounce, the two slots, the gate, the merge.

```
  useTileGraph — full data flow (JS thread throughout)

  ┌─ UI (MapScreen) ──────────────────────────────────────────────┐
  │  pan ─► onRegionDidChange        both endpoints ─► ensureBbox   │
  └──────────┬──────────────────────────────────┬──────────────────┘
             │ debounce 600ms + coverage          │ coverage + span guard
             ▼                                     ▼
  ┌─ slots ──────────────┐              ┌──────────────────────────┐
  │ pendingViewRef (1)   │              │ pendingCorridorRef (1)   │
  └──────────┬───────────┘              └────────────┬─────────────┘
             └──────────────┬───────────────────────┘
                            ▼
  ┌─ pump() — single-flight gate ─────────────────────────────────┐
  │  busyRef? ── true ─► return                                    │
  │     │false                                                     │
  │     ▼  take corridor if pending, else view                     │
  │  busyRef = true                                                │
  └────────────┬───────────────────────────────────────────────────┘
               │  async (off-thread network, on-thread build)
               ▼
  ┌─ build ──────────────────────────────────────────────────────┐
  │ fetchOverpass → buildGraph(+ bestEffortElevation) → prefixGraph│
  └────────────┬───────────────────────────────────────────────────┘
               ▼ setView / setCorridor (state)              finally:
  ┌─ derived graph (useMemo) ─────────────────────┐         busyRef=false
  │ stitch(merge(base, corridor, view)) ─► graph  │         pump() again
  └───────────────────────────────────────────────┘
               ▼
        UI re-renders with extended graph
```

---

## Implementation in codebase

**Use cases in this repo:**

1. **Pan beyond the bundled area** — user drags the map; `onRegionDidChange`
   fires; after 600 ms of stillness, if the new viewport isn't already covered,
   a viewport build loads streets + grades for the screen
   (`MapScreen.tsx:263` wires `onRegionDidChange`; hook at `useTileGraph.ts:131-151`).
2. **Route between distant addresses** — both endpoints set; the effect at
   `MapScreen.tsx:131-140` calls `ensureBbox` with the spanning box so start
   and end land in one connected component (otherwise "No route").
3. **Stay under the free-tier rate limit** — the single-flight gate serializes
   all of the above so the app never fires two Overpass/Open-Meteo builds at
   once.

**Code, line by line.**

The single-flight gate — `mobile/src/useTileGraph.ts:89-129`:

```
  pump() — useTileGraph.ts:89-129

  if (busyRef.current) return;                      ← the mutex: bail if building
  let kind; let bbox;
  if (pendingCorridorRef.current) {                 ← corridor checked FIRST…
    kind = "corridor"; bbox = pendingCorridorRef.current;
    pendingCorridorRef.current = null;              ← …and consumed (latest-wins)
  } else if (pendingViewRef.current) {              ← …only then the viewport
    kind = "view"; bbox = pendingViewRef.current;
    pendingViewRef.current = null;
  } else { return; }                                ← nothing queued
  busyRef.current = true;                            ← claim the lock
  setLoadingStep("Fetching streets");
  (async () => {
    try {
      const osm = await fetchOverpass(bbox);         ← network: OSM streets
      const elev = bestEffortElevation(              ← degrade to flat on failure
        openMeteoProvider(fetch, { delayMs: 400, retries: 1 }));
      const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, ...);
      const region = { bbox, graph: prefixGraph(g, kind) }; ← prefix ids to avoid collision
      if (kind === "corridor") { corridorRef.current = region; setCorridor(region); }
      else { viewRef.current = region; setView(region); }   ← ref + state TOGETHER
    } catch { /* keep last region; a later pan retries */ }  ← swallow, don't crash
    finally {
      busyRef.current = false;                        ← release the lock
      setLoadingStep(null);
      pump();                                          ← drain next (corridor first)
    }
  })();
       │
       └─ the recursive pump() in finally IS the drain; without it the second
          queued region never builds (load-bearing).
```

Note the `corridorRef.current = region; setCorridor(region)` double-write
(`:115-116`, `:118-119`): the ref so a coverage check in the *same tick* sees
the new region, the state so the merged-graph `useMemo` re-runs. That's the
state↔ref seam from the structure pass, made concrete.

The merged graph — `mobile/src/useTileGraph.ts:72-85`:

```
  graph = useMemo(...)  — useTileGraph.ts:72-85

  baseGraph
    ? stitchGraph(                  ← connect coincident boundary nodes
        mergeGraphs([               ← union all regions
          baseGraph,
          ...(corridor ? [corridor.graph] : []),   ← include corridor if loaded
          ...(view ? [view.graph] : []),           ← include view if loaded
        ]))
    : null
  deps: [baseGraph, corridor, view]  ← recomputes only when a region changes
```

The debounce + coverage trigger — `mobile/src/useTileGraph.ts:131-151`:

```
  onRegionDidChange — useTileGraph.ts:131-151

  if (!bounds) return;
  if (span > MAX_LOAD_SPAN_DEG) return;          ← zoomed out too far → skip
  clearTimeout(timerRef.current);                ← debounce: reset the timer
  timerRef.current = setTimeout(() => {
    if (baseGraph covers bounds) return;         ← cache hit: bundled area
    if (covers(viewRef.current, bounds)) return; ← cache hit: current viewport
    pendingViewRef.current = paddedBounds;       ← queue (padded by VIEW_PAD)
    pump();
  }, DEBOUNCE_MS);                                ← 600ms settle
```

The corridor trigger with refusal — `mobile/src/useTileGraph.ts:156-166`:

```
  ensureBbox — useTileGraph.ts:156-166

  if (span > MAX_CORRIDOR_SPAN_DEG) return false; ← too far to route
  if (covers(corridorRef.current, bbox)) return true; ← cache hit
  pendingCorridorRef.current = bbox;              ← queue at priority
  pump();
  return true;
```

The degrade-to-flat elevation wrapper — `mobile/src/useTileGraph.ts:18-28`:

```
  bestEffortElevation — useTileGraph.ts:18-28

  async sample(points) {
    try { return await p.sample(points); }        ← real elevation
    catch { return points.map(() => 0); }          ← flat fallback on 429/offline
  }
       │
       └─ connectivity over fidelity: streets still render and routing still
          connects with flat grades; the real grades fill in on a later load.
```

---

## Elaborate

Single-flight (a.k.a. request coalescing / in-flight deduplication) is an old
server-side idea — Go's `singleflight`, Varnish's request collapsing — pulled
into the client. The motivation is the same: an expensive, shareable operation
behind concurrent callers; you want exactly one execution.

The twist here is **priority single-flight**: two queues, one preempting the
other on selection. That's closer to a tiny scheduler than a plain mutex. The
corridor-over-view rule encodes a product judgment — a user who just tapped
Route is waiting on the route; a user who's panning can wait a beat longer.

Where it connects: this is the *client* half of the rate-limit story. The
*wire* half — how Overpass and Open-Meteo signal 429, what backoff the
provider does — lives in `.aipe/study-networking/`. The *graph* the regions
are made of (nodes/edges/adjacency, why ids are prefixed, what stitching
preserves) lives in `.aipe/study-dsa-foundations/`. The *system-level* question
of why the base area is bundled vs fetched belongs to
`.aipe/study-system-design/` *(not yet generated)*.

What to read next: a library like TanStack Query packages this exact pattern
(dedup, stale checks, in-flight tracking) — reading its `QueryClient` against
this hand-rolled version shows you what you'd get and what you'd give up.

---

## Interview defense

**Q: Why hold `view`/`corridor` in *both* a ref and state? Isn't that
redundant?**

No — they serve two different consumers. State drives the merged-graph
`useMemo` re-render; the ref is read *synchronously* inside `pump()` and the
coverage checks, which run before any re-render commits. If you only had state,
`pump()` calling right after `setCorridor` would still see the *old* corridor
(state updates are async), and you'd queue a duplicate build.

```
  why ref AND state

  setCorridor(region)  ──► state: applied NEXT render  (drives <graph>)
  corridorRef.current = region ──► ref: applied NOW     (pump reads it this tick)
       │
       └─ pump() and covers() run synchronously — they need the ref
```

Anchor: *the ref is the synchronous truth; the state is the render truth.*

**Q: What's the single most load-bearing line, and what breaks without it?**

The recursive `pump()` in the `finally` block (`useTileGraph.ts:126`). Without
it the gate releases but never re-checks the queue — so the *second* queued
request (a corridor that arrived while a viewport was building) never fires,
and the route silently fails to appear. It's the drain.

```
  the drain

  build done ─► busyRef=false ─► pump() ─► finds pendingCorridor ─► builds it
                    │ (without this line)
                    └─► gate free but idle; corridor stuck forever
```

Anchor: *single-flight needs a drain, or it stalls after the first request.*

**Q: How does this avoid hammering the rate-limited API?**

Three stacked filters: debounce (600 ms) collapses a pan gesture to one event;
coverage checks (`covers`/`bboxContains`) skip anything already loaded; the
`busyRef` gate serializes the rest to one build at a time. The user can pan
and type freely; at most one Overpass/Open-Meteo build is ever in flight.

```
  three filters before a fetch fires

  flood of pans ─►[debounce]─► 1 event ─►[coverage]─► maybe skip
                                              │ miss
                                              ▼
                                          [busyRef gate] ─► exactly 1 build
```

Anchor: *debounce thins the stream, coverage skips the cached, the gate
serializes the rest.*

---

## Validate

**Reconstruct.** From memory, draw the pump: two pending slots, the `busyRef`
gate, corridor-first selection, the recursive drain in `finally`. Name the
file: `mobile/src/useTileGraph.ts:89-129`.

**Explain.** Why are endpoints stored as coordinates in `MapScreen.tsx:55-56`
and re-snapped via `nearestNode` (`:125-126`) instead of as node ids? (Because
the corridor load may surface a closer real node; ids would freeze to a stale
graph.)

**Apply to a scenario.** The user taps Route, then immediately starts panning.
Walk what happens: `ensureBbox` queues a corridor; pans queue views; the gate
picks the corridor first (`:93-96`); each `finally` drains the next; the route
appears before any panned-view build. What changes if you removed the
corridor-first branch? (The route fetch gets starved behind viewport builds.)

**Defend the decision.** Someone proposes replacing the hand-rolled hook with
TanStack Query. Argue the seam: what you'd gain (dedup, retry, devtools) vs
what you'd have to rebuild anyway (the *coverage* cache key, the *priority*
between two query kinds, the merge+stitch). Is it worth it at one screen?

---

## See also

- `02-derived-render-time-astar.md` — what the UI does with the `graph` this
  hook produces (the route search).
- `03-native-maplibre-declarative-layers.md` — how the merged graph reaches
  the screen as GeoJSON.
- `04-controlled-search-with-debounce.md` — the *other* debounced network seam
  (geocode autocomplete).
- `audit.md` lens 4 (data-fetching-and-cache) and lens 8 red flag #4.
- `.aipe/study-networking/` — Overpass/Open-Meteo/Nominatim wire behavior and
  rate limits.
- `.aipe/study-dsa-foundations/` — the `Graph` model, prefixing, stitching.
- `.aipe/study-runtime-systems/` — the single JS thread these async builds
  share with render.
