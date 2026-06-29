# Render-Thread Search + Debounce — the throttle that keeps it usable

**Industry name(s):** main-thread computation in `useMemo` + input/region
debouncing. The risk: JS-thread blocking; the mitigation: debounce + on-demand
gating. **Type:** Industry standard (client-side performance), Language-agnostic
(debounce).

## Zoom out, then zoom in

flattr's A* search, heatmap GeoJSON, and zones all run **synchronously on the
React Native JS thread**, inside `useMemo`s in `MapScreen.tsx`. There's one JS
thread; while these run, gestures and frames wait. What keeps that from janking the
app is *not* moving work off-thread (it isn't) — it's **doing the work less often**
via debounce and on-demand gating. This file is both the mitigation and the
honest, unmeasured risk underneath it.

```
  Zoom out — what runs on the one JS thread

  ┌─ JS thread (the only one) ────────────────────────────────┐
  │  MapScreen.tsx useMemos:                                   │
  │    routed   = directedAstar(...)         ← search HERE     │ ← we are here
  │    heatmap  = graphToGeoJSON(...)        (gated on view)   │
  │    zoneCells= computeZones(...)          (gated on view)   │
  │  + gestures, frame callbacks, React reconciliation        │
  └───────────────────────────┬───────────────────────────────┘
                              │ throttled by
  ┌─ debounce/gate layer ─────▼───────────────────────────────┐
  │  600ms region debounce · 400ms suggest debounce · view gate│
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how does a single-threaded UI stay responsive while it
does real CPU work per interaction?"* flattr's answer is throttling, not
threading — and the gap is that nobody has measured whether the per-call work
actually fits the frame budget on a device.

## Structure pass

**Layers.** Two nested questions stacked:

```
  WHAT runs on the JS thread     →     HOW OFTEN it runs
  A* / GeoJSON / zones (useMemo)       debounce + view-gate + memo deps
```

**Axis: latency — "what blocks the JS thread, and for how long?"**

```
  One question across the two layers
  "JS-thread block per interaction?"

  per route change:  directedAstar runs sync   → ?ms  [UNMEASURED on device]
  per view toggle:   GeoJSON/zones recompute   → ?ms  [UNMEASURED]
  while panning:     debounce → work deferred   → ~0   (throttled away)
```

The honest part: the second column is `?ms`. The bench measures the *Node* cost
(sub-ms to ~1 ms for the tested expansion counts), but the device JS-thread cost
over a large merged graph is never captured. → `audit.md` lens 2, red flag #1.

**Seam.** Two load-bearing boundaries: the `useMemo` dependency arrays (decide
*when* the heavy work re-runs) and the debounce timers (decide *whether* a burst of
events collapses to one). Cross either incorrectly and you either compute too often
(jank) or too late (stale UI).

## How it works

### Move 1 — the mental model

You know `useMemo(() => expensive(x), [x])` recomputes only when `x` changes —
that's the *frequency* control. And you know a search-as-you-type box that fires on
every keystroke is wasteful, so you wait until typing pauses — that's debounce.
flattr stacks both: the heavy work is memoized so it only re-runs on real input
changes, and the *inputs* are debounced so rapid gestures don't produce rapid
inputs.

```
  Debounce — collapse a burst into one trailing call

  events:  | | | | | |           (pan, pan, pan...)
                         ⌛600ms quiet
  fire:                       ●   ← one call, after the burst settles

  each new event resets the timer; only the trailing one survives
```

### Move 2 — the walkthrough

**The search runs on the JS thread, synchronously.** This is the risk, stated
plainly:

```ts
// mobile/src/MapScreen.tsx:151-162  — A* inside a render-path useMemo
const routed = useMemo(() => {
  if (!graph || !startId || !endId) return { fc: null, summary: null, found: true };
  const r = directedAstar(graph, startId, endId, userMax);   // ← SYNC search, JS thread
  if (!r.path) return { fc: null, summary: null, found: false };
  return {
    fc: routeToGeoJSON(graph, r.path, userMax),              // ← also sync, also here
    summary: routeSummary(graph, r.path, userMax),
    found: true,
  };
}, [graph, startId, endId, userMax]);                         // re-runs on any of these
```

While `directedAstar` runs, the JS thread is busy — no gesture handling, no frame
callback. At base graph size this is invisible. On a large merged corridor graph
on a mid-range phone it *could* exceed the 16 ms frame budget. **There is no
`InteractionManager`, no worklet, no chunking, and no timing** — so this is
reasoned risk, not observed. The only thing bounding it is `MAX_CORRIDOR_SPAN_DEG`
(`useTileGraph.ts:66`) limiting graph size *indirectly*.

**On-demand gating keeps idle work at zero.** The heatmap and zones only compute
when their view is active:

```ts
// mobile/src/MapScreen.tsx:121-129  — gate heavy compute on the active view
const heatmap = useMemo(
  () => (displayGraph && view === "edges" ? graphToGeoJSON(displayGraph, bandsForUserMax(userMax)) : null),
  [displayGraph, userMax, view]                              // null when view !== "edges"
);
const zoneCells = useMemo(
  () => (displayGraph && view === "zones" ? computeZones(displayGraph, GRID_N) : []),
  [displayGraph, view]                                       // [] when view !== "zones"
);
```

Default view is `"off"` (`MapScreen.tsx:37`), so on launch neither runs — the map
is clean and the JS thread does no grade work at all. The work only happens when
the user opts into seeing it.

**Region pans are debounced 600 ms.** Panning fires a stream of region events;
flattr collapses them:

```ts
// mobile/src/useTileGraph.ts:245-256  — trailing-edge debounce on pan
const onRegionDidChange = useCallback((e: RegionEvent) => {
  const { bounds } = e.nativeEvent;
  if (!bounds) return;
  if (bounds[2] - bounds[0] > MAX_LOAD_SPAN_DEG || ...) return;  // too zoomed out: skip
  lastBoundsRef.current = bounds;
  if (!gradesOnRef.current) return;                              // grades off: load nothing
  if (timerRef.current) clearTimeout(timerRef.current);          // ← reset on each event
  timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS);  // 600ms trailing
}, [queueViewport]);
```

Each event clears the prior timer; only the trailing one (after 600 ms of quiet)
fires `queueViewport`. A two-second pan that emits 100 events triggers exactly one
build, not 100.

**Autocomplete is debounced 400 ms.** Same shape, applied to typing, with a
min-length guard so short queries never fire:

```ts
// mobile/src/MapScreen.tsx:73-89  — trailing debounce on suggest, with min length
const scheduleSuggest = useCallback((field, text) => {
  if (suggestTimer.current) clearTimeout(suggestTimer.current);   // reset per keystroke
  if (text.trim().length < 3) { setSuggestions([]); ...; return; }// too short: no request
  suggestTimer.current = setTimeout(async () => {
    const results = await geocodeSuggest(text, { viewbox: searchViewbox, bounded: true, limit: 5 });
    setSuggestions(results); ...
  }, 400);                                                        // ← 400ms trailing
}, [searchViewbox]);
```

This is also the rate-limit defense for Nominatim (~1 req/sec policy): you can't
type fast enough to break the limit through a 400 ms debounce.

```
  Execution trace — fast pan with grades on

  t=0ms    region event → set timer(600)
  t=120ms  region event → clear+reset timer(600)
  t=240ms  region event → clear+reset timer(600)
  ...      (panning)
  t=840ms  pan stops
  t=1440ms timer fires → queueViewport(latest bounds) → ONE build
           ▲ 7 events → 1 build; nothing ran on the JS thread mid-pan
```

### Move 2.5 — current state vs future state

```
  Phase A (now): throttle the work       Phase B (if device profile shows jank)
  ──────────────────────────────────     ──────────────────────────────────────
  A* sync in useMemo, JS thread          chunk search across frames, OR
  debounce 600/400ms + view gate         run in a worklet / off-thread
  bounded by span caps (indirect)        InteractionManager.runAfterInteractions
  NO on-device timing  ← the gap         add timing first, THEN decide
  what doesn't change: the search itself; only WHERE/WHEN it runs
```

The migration is gated on a measurement that doesn't exist yet. The right next
move isn't to pre-emptively move A* off-thread — it's to **add the timing** (wrap
the `routed` useMemo in `performance.now()`, log p50/p95 per session) and only
then decide if chunking/worklets are warranted. Throttling is the cheap mitigation
that's already in place; threading is the expensive one you reach for with data.

### Move 3 — the principle

On a single-threaded UI, the first lever for responsiveness is *frequency*, not
*parallelism* — debounce and on-demand gating remove most of the work before you
ever consider moving the rest off-thread. But the lever only works if you've
measured the per-call cost; flattr has the throttle and not the measurement, so the
honest verdict is "responsive by construction, unverified by instrument." That gap
— mitigation without measurement — is the most important thing to name about
flattr's client performance.

## Primary diagram

```
  Render-thread work + the throttle around it

  ┌─ user input ──────────────────────────────────────────────┐
  │  pan (region events)        type (keystrokes)             │
  └──────────┬──────────────────────────┬─────────────────────┘
       600ms debounce              400ms debounce + len≥3
             │                          │
  ┌─ MapScreen useMemos (JS THREAD) ────▼─────────────────────┐
  │  routed   = directedAstar(...)   ← SYNC, blocks thread     │
  │  heatmap  = graphToGeoJSON(...)  ← gated on view=="edges"  │
  │  zoneCells= computeZones(...)    ← gated on view=="zones"  │
  │  default view="off" → none run at launch                  │
  └───────────────────────────────────────────────────────────┘
       mitigation: do it LESS OFTEN (debounce + gate)
       gap: per-call JS-thread cost on device = UNMEASURED [red flag #1]
```

## Elaborate

Debounce is the universal client throttle (Lodash `debounce`, RxJS
`debounceTime`); the trailing-edge variant flattr uses fires once after quiet,
which is right for "load the area I settled on" and "search what I finished
typing." React Native's specific constraint is the single JS thread — the reason
heavy sync work in a `useMemo` is riskier here than on web, where you'd still jank
but have more headroom. The proper escape hatches in RN are
`InteractionManager.runAfterInteractions` (defer until gestures settle) and
react-native-worklets (true off-thread) — flattr uses neither yet, which is the
correct *next* step gated on the missing measurement, not a flaw to fix blind. →
`audit.md` lens 7 for the full rendering picture.

## Interview defense

**Q: A* runs on the JS thread in a `useMemo` — isn't that a jank risk?**

> Yes, and I'd flag it honestly: there's one JS thread, and `directedAstar` runs
> synchronously in the `routed` useMemo (`MapScreen.tsx:151`), so a large enough
> graph could blow the 16 ms frame budget. My mitigation today is *frequency*, not
> threading: 600 ms pan debounce, 400 ms suggest debounce, and the heatmap/zones
> are gated on the active view so nothing heavy runs by default. The gap I'd name
> is that I never measured the per-call cost on a device — the bench is Node-only.
> So the right next move is to add `performance.now()` timing and p50/p95 logging
> *before* deciding whether to chunk the search or move it to a worklet.

```
  lever 1: do it less (debounce + gate)   lever 2: move it off-thread (only with data)
```

Anchor: *frequency before parallelism — but the lever needs a measurement flattr
doesn't have yet.*

**Q: Why trailing-edge debounce, and why 600 vs 400 ms?**

> Trailing because I want the *settled* state — the area you stopped panning on,
> the query you finished typing. 600 ms for pans because a tile build is expensive
> and rate-limited, so I bias toward fewer builds; 400 ms for suggest because it's
> a lighter request and typing feels laggy if it waits too long. The suggest one
> also keeps me under Nominatim's ~1 req/sec just by construction.

```
  pan: heavy+rate-limited → 600ms     type: light+latency-sensitive → 400ms
```

Anchor: *debounce window is tuned to the cost and rate-limit of the work behind
it.*

## See also

- `02-heuristic-pruning.md` — the search that runs on this thread.
- `05-single-flight-pump.md` — the debounce feeds the pump.
- `07-elevation-batching-and-cache.md` — the other half of the Nominatim/Open-Meteo defense.
- `audit.md` lens 2 (the measurement gap), lens 7 (rendering), lens 8 (red flags #1, #2).
- Cross-guide: `study-runtime-systems` (the single JS thread, the event loop), `study-frontend-engineering` (useMemo/debounce).
