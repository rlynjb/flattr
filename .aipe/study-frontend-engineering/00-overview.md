# Frontend Engineering — flattr `mobile/`
## one-page orientation

This is your home turf, so no on-ramp. flattr's frontend is **not** the
Next.js web app the design spec (`docs/flattr-spec.md` §8) describes — that
was never built. The real frontend is an **Expo / React Native** app under
`/Users/rein/Public/flattr/mobile/`: Expo `~56.0.12`, React Native `0.85.3`,
React `19.2.3`, rendering native MapLibre views through
`@maplibre/maplibre-react-native@^11` (`mobile/package.json:4-11`).

If you only read one file, read this one.

---

### The rendering mode, in one sentence

It's a **single-screen native app** — no router, no SSR, no hydration: one
React tree (`App.tsx` → `MapScreen`) that declaratively describes native iOS/
Android views, which React Native's renderer commits across the JS↔native
bridge; the map itself is a **native MapLibre view**, not DOM and not canvas
you draw to (`mobile/App.tsx:5-12`, `mobile/src/MapScreen.tsx:261-292`).

```
  flattr mobile — the whole frontend in one frame

  ┌─ JS thread (your React code) ──────────────────────────────┐
  │  App.tsx                                                    │
  │    └─ MapScreen.tsx  ← the entire UI lives here (1 screen)  │
  │         state: userMax, startPt, endPt, view, userLoc…      │
  │         derived (useMemo): heatmap, zones, routed (A*!)     │
  │         hook: useTileGraph → graph (base ∪ view ∪ corridor) │
  │         children: <Map> overlays (AddressBar, Legend,       │
  │                   GradeSlider, RouteSummaryCard)            │
  └───────────────────────────┬────────────────────────────────┘
                              │  bridge / Fabric  (serialized props)
  ┌─ Native thread ───────────▼────────────────────────────────┐
  │  MapLibre MapView  ·  GeoJSONSource + Layer (GPU lines)     │
  │  expo-location (GPS)  ·  UIView / android.view             │
  └─────────────────────────────────────────────────────────────┘
                              │  network (off-thread, async)
  ┌─ Remote ──────────────────▼────────────────────────────────┐
  │  Overpass (OSM)  ·  Open-Meteo (elevation)  ·  Nominatim    │
  │  openfreemap (basemap tiles)                                │
  └─────────────────────────────────────────────────────────────┘
```

---

### The state architecture, in one diagram

Everything keys off `userMax`. There is **no store, no context, no reducer** —
all state is `useState`/`useRef` inside `MapScreen`, and the expensive outputs
(heatmap, zones, the A* route) are **derived state via `useMemo`**, not stored.

```
  state graph — one component owns everything

  SOURCE STATE (useState in MapScreen.tsx:52-65)
    userMax ──┐   startPt ──┐   endPt ──┐   view   userLoc
              │             │           │
              ▼             ▼           ▼
  DERIVED STATE (useMemo — recomputed on dep change)
    heatmap  = graphToGeoJSON(graph, bandsForUserMax(userMax))   :116
    zonesFC  = zonesToGeoJSON(computeZones(graph), userMax)      :120-121
    startId  = nearestNode(graph, startPt)                       :125
    endId    = nearestNode(graph, endPt)                         :126
    routed   = directedAstar(graph, startId, endId, userMax) ◄── A* RUNS HERE :143-154
              │
              ▼
  GRAPH STATE (useTileGraph hook — its own useState/useRef)
    graph = stitch( merge( base, corridor, view ) )    useTileGraph.ts:72-85
```

The load-bearing, surprising choice: **the A\* shortest-path search runs
inside a `useMemo` at `MapScreen.tsx:143-154`** — synchronously, on the JS
thread, during render. That's the single most important thing to understand
about this frontend, and the hazard the runtime-systems guide picks up.

---

### The network seam, in one diagram

Server state crosses into client state at exactly two places: the
`useTileGraph` hook (street graph + elevation) and the geocode calls
(address ↔ coordinate). No react-query, no SWR — hand-rolled `async`
functions guarded by a debounce and a single-flight gate.

```
  network seam — where server state becomes client state

  ┌─ UI ──────────────────────────────────────────────────┐
  │ pan map ──► onRegionDidChange (debounced 600ms)        │
  │ type addr ─► scheduleSuggest (debounced 400ms)         │
  │ set both endpoints ─► ensureBbox (corridor)            │
  └───────────┬─────────────────┬──────────────────────────┘
              │ pump()          │ geocodeSuggest / geocode
              ▼ (single-flight) ▼
  ┌─ async fetch (off JS thread) ─────────────────────────┐
  │ fetchOverpass → buildGraph → bestEffortElevation       │
  │ Nominatim geocode / reverseGeocode                     │
  └───────────┬────────────────────────────────────────────┘
              ▼ setState → re-render → new derived graph
```

---

### The three highest-leverage frontend patterns (with paths)

1. **On-demand tile graph with single-flight pump** —
   `mobile/src/useTileGraph.ts:89-129`. The hook that turns a bundled static
   graph into a pan-to-load, route-corridor-aware data source while never
   running two network builds at once. → `01-on-demand-tile-graph.md`

2. **Derived render-time A\*** — `mobile/src/MapScreen.tsx:143-154`. The route
   is not stored; it's recomputed by running the full A* search inside a
   `useMemo`. Elegant data-flow, real main-thread hazard.
   → `02-derived-render-time-astar.md`

3. **Native MapLibre declarative layers** — `mobile/src/MapScreen.tsx:263-292`.
   Source/layer components with `key`-driven remount on toggle and
   data-driven styling (`["get","color"]`) pushed to the GPU.
   → `03-native-maplibre-declarative-layers.md`

Plus a fourth that earns a file: **controlled-input search with debounce +
suggestion lifecycle** (`04-controlled-search-with-debounce.md`).

---

### Reading order

See `README.md`. Start here, then `audit.md` (the 8-lens sweep), then the
four pattern files in order.
