# 00 — Overview

One page. The whole frontend in four diagrams and a verdict.

## What this app is, in one sentence

A **single-screen native-map app** (`App.tsx` → `MapScreen.tsx`, no router) where
every visible thing — the heatmap, the zones overlay, the route line, the markers
— is a **GeoJSON feature collection recomputed in a `useMemo` and handed to a
declarative MapLibre `<GeoJSONSource>`**, and the route itself is computed by
**running A\* on the JS thread at render time**.

## The rendering mode

```
  flattr's rendering model — native, declarative, recompute-on-demand

  ┌─ App layer (React / RN) ──────────────────────────────────────┐
  │  App.tsx → SafeAreaView → MapScreen (the only screen)          │
  │  React state changes → re-render → useMemo recomputes GeoJSON  │
  └───────────────────────────────┬───────────────────────────────┘
                                   │  props: data={featureCollection}
  ┌─ Native map layer (MapLibre) ─▼───────────────────────────────┐
  │  <Map> <GeoJSONSource> <Layer>   ← C++/native renders the      │
  │  the bridge diffs props, native draws the tiles + features     │
  └───────────────────────────────────────────────────────────────┘
```

No virtual-DOM diffing decides what's on the map — React diffs the *props* you
pass `<GeoJSONSource>`, the native MapLibre renderer draws. That seam (JS owns
*what data*, native owns *how it's drawn*) is the spine of the whole app.
`MapScreen.tsx:281–312` is where it lives.

## The state graph

Eleven `useState` calls in one component, plus seven `useRef`s in the data hook.
No global store, no context, no reducer — lifted state in `MapScreen`, refs for
the imperative network machine in `useTileGraph`.

```
  State ownership — who owns what, MapScreen.tsx

  ┌─ source-of-truth state (useState in MapScreen) ──────────────┐
  │  startPt / endPt   ← endpoints as COORDS (not node ids)       │
  │  userMax           ← the one knob; preset buttons set it      │
  │  view              ← "off" | "edges" | "zones"                │
  │  fromText/toText   ← controlled inputs                        │
  │  userLoc, suggestions, routeBusy, routeError, activeField     │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  derived (useMemo)
  ┌─ derived state — recomputed, never stored ───────────────────┐
  │  startId/endId  = nearestNode(graph, startPt)   :133–134      │
  │  routed         = directedAstar(graph, …)        :151–162  ★  │
  │  heatmap/zones  = graphToGeoJSON(displayGraph)   :121–129     │
  └──────────────────────────────────────────────────────────────┘
  ★ the route is DERIVED STATE — A* in a useMemo, see 01.
```

The deliberate choice worth naming: **endpoints are stored as coordinates, not
node ids** (`MapScreen.tsx:58–60`). The id is *derived* from the current graph
every render, so when a corridor tile loads a closer node, the endpoint re-snaps
for free. That's pattern `04`.

## The network seam

Server-state (streets from Overpass, elevation from Open-Meteo, geocoding from
Nominatim) crosses into client-state through one hook, `useTileGraph`, behind a
**single-flight pump**: one graph build runs at a time, corridor before viewport.

```
  Network seam — server-state → client graph, useTileGraph.ts

  ┌─ UI (MapScreen) ─┐  pan / route / toggle      ┌─ Hook (useTileGraph) ─┐
  │  onRegionDidChange │ ───────────────────────► │ debounce → queue       │
  │  ensureBbox        │                           │ → pump (1 at a time)   │
  └────────────────────┘  ◄─── graph, loadingStep  └──────────┬─────────────┘
                                                    fetch │ (Overpass+Meteo)
                                                          ▼
                                              ┌─ Network (pipeline/*) ────┐
                                              │ fetchOverpass, openMeteo  │
                                              │ buildGraph → merge+stitch │
                                              └───────────────────────────┘
```

That's patterns `02` (the pump) and `05` (debounce-as-throttle + self-heal).

## The three highest-leverage frontend patterns

1. **Render-thread A\*** (`MapScreen.tsx:151–162`, `01`). The route is a
   `useMemo` calling `directedAstar`. This is the most *surprising* choice in the
   codebase: a graph search on the render path. It works because the graph is
   small and the memo deps are tight — but it couples UI responsiveness to
   algorithm cost. Name this in an interview before they find it.

2. **Single-flight pump** (`useTileGraph.ts:166–227`, `02`). A hand-rolled
   one-at-a-time job queue with corridor priority, built from refs + a `busyRef`
   mutex, because the free Overpass/Open-Meteo tiers throttle under parallel load.

3. **Declarative data-driven map layers with remount-by-key**
   (`MapScreen.tsx:286–304`, `03`). MapLibre freezes a source/layer `id` at
   mount, so switching `edges`→`zones` uses a distinct React `key` to force a
   remount instead of mutating in place.

## What this app does NOT do (named honestly)

- **No routing/navigation** — single screen, no React Navigation, no deep links.
- **No theming / dark mode / design tokens** — colors are inline hex literals
  scattered across `StyleSheet.create` blocks (`#1565c0` appears in five files).
- **No data-fetch library** — no react-query/SWR; the cache is hand-rolled.
- **No web target in practice** — `expo start --web` exists in scripts but
  MapLibre-native + `expo-location` are native-first.
- **A dead dependency** — `@react-native-community/slider@5.2.0` is declared in
  `package.json` but imported nowhere; `GradeSlider.tsx` uses preset `Pressable`
  buttons, not a slider. Drop it.
