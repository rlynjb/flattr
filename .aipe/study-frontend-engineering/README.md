# Study — Frontend Engineering (flattr `mobile/`)

A per-repo frontend-engineering guide for the **Expo / React Native** app at
`/Users/rein/Public/flattr/mobile/`. This is the real frontend surface — the
Next.js stack named in `docs/flattr-spec.md` §8 was never built; the Expo RN
app is the source of truth (confirmed direction).

Calibrated to a frontend engineer: no on-ramp for what a hook or a component
is. The interesting parts of this codebase are *where frontend meets a
hand-rolled graph router* — the route runs in a `useMemo`, the data source is
a pan-to-load tile graph, and the rendering target is a native map view across
the JS↔native bridge.

## Reading order

1. **`00-overview.md`** — one-page orientation. Rendering mode in one
   sentence, state graph in one diagram, network seam in one diagram, the
   three highest-leverage patterns named with paths. Skim-only readers stop
   here.
2. **`audit.md`** — Pass 1, the 8-lens frontend audit. One `##` section per
   lens, `file:line` grounded, `not yet exercised` named honestly. The final
   lens ranks frontend red flags by user-visible consequence.
3. **`01-on-demand-tile-graph.md`** — the `useTileGraph` hook: pan-to-load
   coverage, single-flight `pump()`, corridor-over-viewport priority.
4. **`02-derived-render-time-astar.md`** — the route as derived state: A*
   inside a `useMemo`, and the main-thread hazard that creates.
5. **`03-native-maplibre-declarative-layers.md`** — native MapLibre source/
   layer composition, `key`-driven remount, data-driven GPU styling.
6. **`04-controlled-search-with-debounce.md`** — controlled From/To inputs,
   debounced autocomplete, the suggestion lifecycle, tap-to-set endpoints.

## Cross-links to neighboring guides

- **`.aipe/study-runtime-systems/`** — the single JS thread and the
  synchronous-A*-in-render hazard. Frontend owns *that the route is derived
  state*; runtime-systems owns *what blocking the thread costs*.
- **`.aipe/study-dsa-foundations/`** — the A* search the UI invokes
  (`features/routing/astar.ts`), the binary heap, the graph model.
- **`.aipe/study-networking/`** — Overpass / Open-Meteo / Nominatim wire
  behavior, rate limits, retry/backoff. Frontend owns the *debounce and
  single-flight seam*; networking owns *what travels and how it fails*.
- **`.aipe/study-system-design/`** *(not yet generated)* — system-level state
  ownership of the graph artifact and the build pipeline.
- **`.aipe/study-performance-engineering/`** *(not yet generated)* — measuring
  the cost of render-time A* and full-graph GeoJSON rebuilds (frame budget,
  numbers). Frontend names the pattern; performance-engineering measures it.

## What this guide does NOT cover

- The routing algorithm internals (A*, bidirectional, the binary heap, cost
  function) → `study-dsa-foundations`.
- The build pipeline that produces `graph.json` (`pipeline/`) → it's
  build-time, not frontend runtime; touched only where the hook reuses it.
- Wire-level HTTP semantics, TLS, connection pooling → `study-networking`.
