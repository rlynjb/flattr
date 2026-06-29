# Overview — the flattr frontend in one page

One screen. No router, no Redux/Zustand, no design system, no SSR. The whole UI is `MapScreen.tsx`
orchestrating a declarative MapLibre map plus a handful of absolutely-positioned overlays. The
interesting engineering isn't in the component tree — it's in *where state lives* and *when work
runs*.

## Rendering mode, in one sentence

A single-screen native app (Expo SDK ~56, React Native 0.85, React 19) where the map is rendered by
`@maplibre/maplibre-react-native` v11 native views and everything else is React Native components
laid over it — React's virtual-DOM reconciliation drives the JS-side overlays, the native MapLibre
view owns the actual map raster (`mobile/src/MapScreen.tsx:281`).

## The state graph

Every piece of UI state lives in `MapScreen` as `useState`, then flows down as props. The
load-bearing decision: **endpoints are stored as coordinates, not node ids** — the ids are *derived*
each render so they re-snap as graph tiles load.

```
  flattr state graph — all owned by MapScreen, derived downward

  ┌─ source-of-truth state (useState in MapScreen) ──────────────┐
  │  startPt {lat,lng}    endPt {lat,lng}    userMax (8)          │
  │  view "off|edges|zones"    fromText/toText    userLoc         │
  └───────────────────┬──────────────────────────────────────────┘
                      │  useMemo (re-derived every render)
  ┌─ derived state ───▼──────────────────────────────────────────┐
  │  startId = nearestNode(graph, startPt)   ← re-snaps as tiles  │
  │  endId   = nearestNode(graph, endPt)        load (:133-134)   │
  │  routed  = directedAstar(graph, startId, endId, userMax)      │
  │            → fc + summary + found          (:151-162)         │
  │  heatmap / zonesFC = graphToGeoJSON(...)   (:121-129)         │
  └───────────────────┬──────────────────────────────────────────┘
                      │  props down
  ┌─ leaf components ─▼──────────────────────────────────────────┐
  │  AddressBar   GradeSlider   Legend   RouteSummaryCard         │
  │  + MapLibre GeoJSONSource/Layer (route, edges, zones)         │
  └───────────────────────────────────────────────────────────────┘
```

No state is lifted *into* a child and lifted back — children are pure presentational, every handler
is a callback passed down from `MapScreen`. The one stateful exception is `useTileGraph`, a custom
hook that owns the tile-fetch machine and hands back `graph` / `displayGraph` / `loadingStep`.

## The network seam

flattr talks to three external services, all through the shared `pipeline/` engine, all from the
JS thread. There is no react-query, no SWR — fetch orchestration is hand-rolled in `useTileGraph`.

```
  network seam — frontend → pipeline → external HTTP

  ┌─ UI (mobile/src) ─────────────────────────────────────────────┐
  │  AddressBar typing → scheduleSuggest (400ms debounce)          │
  │  Route button → handleRoute                                    │
  │  map pan → onRegionDidChange (600ms debounce)                  │
  └───────┬─────────────────┬──────────────────┬───────────────────┘
          │ geocodeSuggest  │ geocode          │ queueViewport/ensureBbox
          ▼                 ▼                  ▼
  ┌─ pipeline/ (shared engine, synced into .engine) ──────────────┐
  │  geocode.ts → Nominatim   overpass.ts → Overpass              │
  │  elevation.ts → Open-Meteo (cached + best-effort fallback)    │
  └────────────────────────────────────────────────────────────────┘
          │ persistent cache
          ▼
  ┌─ AsyncStorage ────────────────────────────────────────────────┐
  │  elevCache.ts — ~90m DEM cells, survives restarts (:7)        │
  └────────────────────────────────────────────────────────────────┘
```

## The three highest-leverage frontend patterns

1. **Render-time A\*** (`01-render-time-astar.md`) — `MapScreen.tsx:151-162`. The router runs inside
   a `useMemo`, on the JS thread, every time `graph`/`startId`/`endId`/`userMax` changes. Cheap to
   write, but it couples route compute to React's render cycle and to the single JS thread.

2. **Coordinates-not-ids endpoints** (`02-coords-not-ids-endpoints.md`) — `MapScreen.tsx:59-60,
   133-134`. Storing `{lat,lng}` and re-deriving the node id means endpoints automatically re-snap to
   a better node as corridor tiles stream in. Without it, a route set before tiles load would pin to
   a stale node.

3. **Single-flight tile pump** (`03-single-flight-tile-pump.md`) — `useTileGraph.ts:166-227`. One
   network build at a time, corridor prioritized over viewport, debounced, with a capped self-heal
   retry for elevation-degraded regions. This is the closest thing flattr has to a data layer.

Two more pattern files cover the **data-driven map layers** (`04`) and the **debounced controlled
inputs** (`05`).

## What's deliberately absent

No routing library (one screen). No global store (props suffice). No design tokens — colors are
inline hex, the one shared palette is `bandColor` in the engine (`features/grade/classify.ts:18`).
No theming (`userInterfaceStyle: "light"` is hard-set in `app.json`). No tests in `mobile/src/`. See
`audit.md` for the full `not yet exercised` list.
