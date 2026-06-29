# Study — Frontend Engineering (flattr `mobile/`)

The frontend surface of flattr is one Expo / React Native screen — `MapScreen.tsx` — that
wraps a declarative MapLibre map, a controlled address bar, two grade-display overlays, and a
route summary card. There's no router, no global store, no design-token system, no service
worker. What *is* here is dense: an A\* router run inside a render-time `useMemo`, a single-flight
tile-fetch state machine in a custom hook, data-driven map layers styled by GeoJSON properties,
and a persistent elevation cache behind AsyncStorage.

This guide is audit-style (two passes, per `me.md`):

- **`audit.md`** — Pass 1. Walks the 8 frontend lenses against `mobile/src/`. Names what's there
  with `file:line` grounding, or marks `not yet exercised`.
- **`01`–`05`** — Pass 2. One file per load-bearing frontend pattern this repo actually exercises.

## Reading order

1. **`00-overview.md`** — the whole frontend in one page: rendering mode, state graph, network seam,
   the three highest-leverage patterns. Skim only this and you know what the app is.
2. **`audit.md`** — the 8-lens sweep. Read it to see what's exercised and what isn't.
3. The pattern files, in order:
   - **`01-render-time-astar.md`** — the router runs in a `useMemo` on the JS thread. The most
     surprising and most load-bearing choice in the codebase.
   - **`02-coords-not-ids-endpoints.md`** — endpoints stored as coordinates, node ids re-derived
     each render so they re-snap as tiles load. The source-of-truth decision that makes everything
     else work.
   - **`03-single-flight-tile-pump.md`** — the `useTileGraph` fetch state machine: one build at a
     time, corridor priority, debounce, degraded-region self-heal.
   - **`04-data-driven-map-layers.md`** — declarative GeoJSON sources/layers styled by feature
     properties, with the frozen-id remount-by-key trick.
   - **`05-debounced-controlled-inputs.md`** — the controlled AddressBar + debounced geocode
     autocomplete, the throttle that keeps Nominatim under its rate limit.

## Cross-links to neighboring guides

- **`study-runtime-systems`** — the JS event loop, why A\* in a `useMemo` blocks the UI thread, the
  `setTimeout` debounce mechanics. This guide names *that* the router runs render-time; the runtime
  guide owns *how the single thread schedules it*.
- **`study-networking`** — Overpass / Open-Meteo / Nominatim HTTP semantics, rate limits, retry
  backoff on the wire. This guide names the fetch seam; networking owns the protocol.
- **`study-system-design`** — base graph + viewport + corridor merge architecture, local-first
  storage strategy, the build-time `graph.json` artifact. This guide names where client state lives;
  system-design owns the system-level data ownership.
- **`study-performance-engineering`** — the actual cost of render-time A\* in milliseconds, frame
  budget, bundle size as numbers. This guide names the perf *coupling*; performance owns the
  *measurement*.
- **`study-dsa-foundations`** — A\*, the binary-heap priority queue, the graph itself. This guide
  treats the router as a black box called from render; DSA owns the algorithm internals.
- **`study-software-design`** — module boundaries between `mobile/src/` and the shared `features/`
  engine, the `useTileGraph` hook as a deep module. This guide names the seam; software-design owns
  the interface depth analysis.
