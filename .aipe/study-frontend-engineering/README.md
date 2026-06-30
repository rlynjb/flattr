# Study — Frontend Engineering (flattr / `mobile/`)

The frontend-and-platform layer of the flattr Expo app: how MapLibre renders,
where state lives, how server-state (OSM + elevation) crosses into client-state,
and the one design decision that ties UI responsiveness to a graph algorithm.

This is your home turf (7+ years frontend). No on-ramp for what a hook or a
component is — the guide leads with what *this* repo does and spends its length
on the seams that are specific to a native-map, single-screen, no-router app.

## Reading order

1. **`00-overview.md`** — one page. Rendering mode in a sentence, the state graph
   in one diagram, the network seam in one diagram, the three highest-leverage
   patterns named with file paths. Skim only this and you know what the app is.
2. **`audit.md`** — the 8-lens frontend audit. Each lens grounded in `file:line`
   or marked `not yet exercised` honestly. Routing, theming, dark mode, and the
   design-token layer are all `not yet exercised` — named, not invented.
3. **Pattern files** (`01`–`06`) — the frontend patterns this repo actually
   exercises, each a full walkthrough:
   - `01-render-thread-astar.md` — A\* runs in a `useMemo` on the JS thread
   - `02-single-flight-pump.md` — one network build at a time, corridor-priority
   - `03-declarative-data-driven-map-layers.md` — GeoJSON sources + remount-by-key
   - `04-coords-as-endpoint-state.md` — endpoints as coordinates, ids derived
   - `05-debounce-as-throttle-with-self-heal.md` — debounce + degraded-region retry
   - `06-persistent-write-behind-cache.md` — AsyncStorage elevation cache

## Cross-links to neighboring guides

- **`study-system-design`** — where state and data *live* at the system level
  (bundled `graph.json` + on-demand tile builds + merged graph). This guide owns
  the *client* state shape; system-design owns the storage story.
- **`study-software-design`** — module/interface depth of `useTileGraph`,
  `geojson.ts`, `tiles.ts` (deep modules, info hiding).
- **`study-performance-engineering`** — the *measurement* of the render-thread
  A\* cost (frame budget, INP, jank as numbers). This guide names the coupling;
  performance-eng quantifies it.
- **`study-runtime-systems`** — the JS event loop, the single-flight pump as a
  bounded-work scheduler, the `busyRef` mutex.
- **`study-networking`** — Overpass / Nominatim / Open-Meteo wire semantics,
  rate limits, retry/backoff. This guide names the seam; networking owns the wire.
- **`study-dsa-foundations`** — A\* itself, admissible heuristic, the binary-heap
  priority queue under `directedAstar`.
