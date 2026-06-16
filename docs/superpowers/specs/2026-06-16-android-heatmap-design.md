# flatr Android — Sub-plan 3a: Expo scaffold + grade heatmap (design)

> Design spec for the first Android deliverable. Supersedes the web assumption in
> `docs/flattr-spec.md` §8: the runtime is a **React Native (Expo) Android app**,
> not a Next.js web app. The hand-rolled TS routing engine (Plan 1) and pipeline
> (Plan 2) are reused unchanged. Date: 2026-06-16.

## Context

Plans 1 (routing graph core) and 2 (data pipeline) are merged to `main`: 71 tests,
clean typecheck. Both are pure TypeScript with no UI/framework dependency, so the
platform pivot to Android costs nothing in the core — we reuse `features/routing/*`,
`lib/geo.ts`, and the pipeline's `graph.json` output as-is.

## Platform decision (resolves spec §8 / ROADMAP "Android revisit")

- **React Native via Expo.** Reuses the pure-TS engine by direct import; gives a
  true native MapLibre map view and an easy build/ship-to-phone path.
- Rejected: native Kotlin (would require porting the engine), Capacitor (webview;
  no existing web UI to preserve, so its main advantage is moot).
- **Android-first.** Expo yields iOS for ~free; iOS is incidental, not a goal.

## Decomposition (the Android app = 3 sub-plans, each demoable)

| Sub-plan | Scope | Spec phase |
|---|---|---|
| **3a** (this spec) | Expo scaffold + grade heatmap (colored edges over a basemap) | §10 Phase 1 |
| 3b | Routing UI: pick A→B, run engine on-device, draw route, `userMax` slider | §10 Phase 2 |
| 3c | Honesty messaging + zone choropleth | §10 Phase 3 |

Each later sub-plan gets its own spec → plan → implementation cycle.

---

## 3a Architecture

- Add an **Expo (React Native) app in `mobile/`** at the repo root.
- The existing engine stays put (`features/`, `lib/`) and keeps being vitest-tested
  at the repo root. `mobile/metro.config.js` adds the repo root to `watchFolders`
  (and maps `node_modules` resolution) so the app imports `../features/...` and
  `../lib/...` directly — no copy, no port, no workspace package.
- Map rendering via **`@maplibre/maplibre-react-native`** (native MapLibre), basemap
  style **OpenFreeMap** (`https://tiles.openfreemap.org/styles/liberty`, no token).

### Repo layout after 3a

```
flatr/
  features/ lib/ pipeline/ bench/   # unchanged, vitest-tested at root
  features/grade/classify.ts        # NEW (pure, tested)
  features/map/geojson.ts           # NEW (pure, tested)
  mobile/                           # NEW Expo app
    app.json / app.config.ts
    metro.config.js                 # watchFolders -> repo root
    index.ts / App.tsx
    src/MapScreen.tsx               # RN map view (thin, run-verified)
    src/loadGraph.ts                # load bundled graph.json asset
    assets/graph.sample.json        # bundled sample graph (committed)
```

## Components (logic in pure TS, RN shell thin)

The hard logic is pure and unit-tested; the RN component is thin and verified by
running the app.

1. **`features/grade/classify.ts`** *(pure, vitest)*
   - `type Band = "green" | "yellow" | "red"`.
   - `classifyAbs(absGradePct: number, bands?: Bands): Band` — fixed thresholds
     (default green ≤ 4, yellow ≤ 8, red > 8). `bands` injectable so 3b can drive
     it from `userMax`.
   - `bandColor(band: Band): string` — hex per band (e.g. green `#2e9e3f`, yellow
     `#e8b500`, red `#d23b2e`).
2. **`features/map/geojson.ts`** *(pure, vitest)*
   - `graphToGeoJSON(graph: Graph, bands?: Bands): FeatureCollection` — one
     `LineString` Feature per edge. **Coordinates flipped `[lat,lng] → [lng,lat]`.**
     Each feature's `properties` carry `id`, `absGradePct`, and precomputed `color`
     (via `classifyAbs` + `bandColor`), so the map layer paints with `['get','color']`
     and the band logic stays in tested TS.
3. **`mobile/src/loadGraph.ts`** *(thin)* — loads `assets/graph.sample.json` (bundled
   via `require`) and returns a typed `Graph`.
4. **`mobile/src/MapScreen.tsx`** *(RN, run-verified)* — `MapView` with the OpenFreeMap
   style; a `ShapeSource` fed `graphToGeoJSON(graph)`; a `LineLayer` with
   `lineColor: ['get','color']` and a sensible width. Initial camera fit to
   `graph.bbox`.
5. **`mobile/App.tsx`** *(thin)* — renders `MapScreen`; handles load error/empty state.

## Data flow

```
mobile/assets/graph.sample.json  (bundled)
   → loadGraph() → Graph
   → graphToGeoJSON(graph)  (flip coords, attach per-edge color)
   → MapLibre ShapeSource + LineLayer (lineColor = feature.color)
   → rendered over OpenFreeMap, camera fit to graph.bbox
```

## Sample graph asset

`mobile/assets/graph.sample.json` is committed (note: repo `.gitignore` excludes
`data/`, so the bundled asset lives under `mobile/assets/`, not `data/`). It is
produced by the Plan 2 pipeline (`npm run build:graph`, then copied) or, acceptable
for the first render, a small hand-built graph. Real/full graphs swap this file.

## Color bands (fixed for 3a, §10 Phase 1)

`absGradePct`: green ≤ 4%, yellow 4–8%, red > 8% — placeholder pedestrian-ish
thresholds, tunable. 3a deliberately uses **fixed** thresholds; 3b makes them
`userMax`-driven (same `Bands` seam). The heatmap colors by `absGradePct`
(steepness, no direction) per spec §7.

## Error handling

- Graph load failure → on-screen error message (not a crash).
- Empty graph (no edges) → basemap renders, no line layer data.
- Map style fetch failure → MapLibre's blank fallback; acceptable for MVP.

## Testing

- **Unit (vitest, at repo root):**
  - `classify`: each band boundary (≤4 green, 4–8 yellow, >8 red), color mapping,
    custom `bands` override.
  - `graphToGeoJSON`: one feature per edge; **coordinate flip** `[lat,lng]→[lng,lat]`;
    `color` matches `classifyAbs(absGradePct)`; empty graph → empty FeatureCollection.
- **Run-verified (manual, Expo):** `MapScreen` renders green/yellow/red edges over
  OpenFreeMap on an Android emulator/device, camera framed to the bbox.
- RN component logic kept minimal precisely because it's outside the unit-test gate.

## Done when

The Expo app shows green/yellow/red Seattle edges over the OpenFreeMap basemap on an
Android emulator/device, framed to the graph bbox; `classify` and `graphToGeoJSON`
pass vitest; the existing 71 tests still pass.

## Out of scope for 3a (later sub-plans / parked)

Routing, A→B selection, `userMax` slider, route drawing (3b); honesty messaging,
zone choropleth (3c); downloading graphs at runtime / Netlify Blobs (MVP bundles the
asset); iOS polish; offline basemap tiles.

## Expo native-module note (affects how 3a is run)

`@maplibre/maplibre-react-native` contains native code, so it does **not** run in
the prebuilt Expo Go app. 3a must use a **development build**: add the library's
Expo **config plugin** to `app.json`, run `npx expo prebuild` (generates the
`android/` project), and run on an emulator/device via `npx expo run:android` (or an
EAS dev build). The implementation plan's "run" steps assume a dev build, not Expo
Go. Unit tests (`classify`, `graphToGeoJSON`) are pure TS and need none of this.

## Known gotcha (called out so the plan tests it)

`Edge.geometry` is `[lat, lng]`; GeoJSON requires `[lng, lat]`. `graphToGeoJSON`
performs and unit-tests the flip — getting this wrong renders edges in the ocean.
