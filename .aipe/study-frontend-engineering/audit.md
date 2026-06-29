# Frontend audit — flattr `mobile/`

Pass 1 of the two-pass shape. Eight frontend lenses walked against `mobile/src/`. Each section names
what the codebase actually does with `file:line` grounding, or marks `not yet exercised`. Significant
findings cross-link to a Pass 2 pattern file.

The surface is small: one screen, six presentational components, one stateful hook, three tiny
data/cache modules. The depth is concentrated in the hook and the render-time derivations.

---

## 1. rendering-and-reactivity

**Mode: single-screen native app, no SSR/SSG/RSC.** Expo SDK ~56, React Native 0.85, React 19
(`mobile/package.json:5-12`). Entry is `index.ts` → `App.tsx` → `<MapScreen />` under a
`SafeAreaView` (`mobile/App.tsx:7-14`). There is no web rendering path in use — `expo start --web`
exists as a script (`package.json`) but the app targets native (`android/` is prebuilt, MapLibre is a
native module).

**Reconciliation: React's standard virtual-DOM diffing on the JS side; the map is a native view.**
The MapLibre `<Map>` is a native component; React reconciles the *declarative children*
(`GeoJSONSource`/`Layer`/`Marker`) and the overlay tree, but the map raster and gestures are owned by
the native layer (`MapScreen.tsx:281-312`).

**When work happens: render-time, and a lot of it.** The heavy derivations run during render inside
`useMemo`:
- the route (A\*) at `MapScreen.tsx:151-162`,
- the heatmap GeoJSON at `:121-124`,
- the zone cells at `:125-128`,
- the derived node ids at `:133-134`.

This is the defining reactivity fact of the app: a `userMax` change re-runs A\* and re-builds the
heatmap synchronously in the render pass. React 19 is present but no concurrent features (`useTransition`,
`useDeferredValue`, Suspense) are used — the work is plain synchronous `useMemo`. → see
**`01-render-time-astar.md`**.

Cross-link: the JS single-thread scheduling that makes render-time A\* a UI-blocking concern belongs to
`study-runtime-systems`.

## 2. state-architecture

**One owner: `MapScreen`.** All app state is `useState` in `MapScreen` (`MapScreen.tsx:37,56-68`):
view mode, `userMax`, `startPt`/`endPt`, `userLoc`, route busy/error, the two text fields, the active
field, suggestions. Children are pure — they receive value + callback props and own no app state.

**Source-of-truth: coordinates, ids derived.** `startPt`/`endPt` are `{lat,lng}` (`:59-60`); `startId`/
`endId` are `useMemo`-derived via `nearestNode` against the *current* graph (`:133-134`). This is the
single most consequential state decision in the app. → see **`02-coords-not-ids-endpoints.md`**.

**Server state vs client state:** the tile-fetched graph is server-derived state, owned by
`useTileGraph` as two regions (`view`, `corridor`) plus refs (`useTileGraph.ts:107-122`). It's merged
with the bundled base graph at render via `useMemo` (`:132-162`). There is no query library — this hook
*is* the server-state cache.

**No URL state, no form library, no global store.** `not yet exercised` for URL/router state (single
screen). Form state is two controlled strings in `MapScreen`, no Formik/RHF.

Cross-link: system-level state ownership (base/viewport/corridor merge as an architecture) belongs to
`study-system-design`.

## 3. component-architecture

**Container/presentational split, cleanly.** `MapScreen` is the container (all state + handlers);
`AddressBar`, `GradeSlider`, `Legend`, `RouteSummaryCard` are presentational, each a single exported
function component taking a typed props object (`AddressBar.tsx:29-59`, `GradeSlider.tsx:13-19`,
`Legend.tsx:11`, `RouteSummaryCard.tsx:6-16`).

**Composition: plain props, one local sub-component.** No render props, no compound components, no
headless pattern, no context. The one nested component is `Suggestions` inside `AddressBar`
(`AddressBar.tsx:9-27`) — a private presentational helper, not exported. Abstraction is minimal and
earns its place: each component maps to one visible panel.

**Boundaries are drawn by screen region**, not by domain — `Legend`, `GradeSlider`,
`RouteSummaryCard` are each an absolutely-positioned overlay (`Legend.tsx:33`, `GradeSlider.tsx:42`,
`RouteSummaryCard.tsx:49`). The stateful logic is pulled out into the `useTileGraph` hook, which is the
one deep module on the frontend side. `not yet exercised`: compound-component APIs, slots, render props.

Cross-link: module/interface depth analysis of `useTileGraph` belongs to `study-software-design`.

## 4. data-fetching-and-cache

**Hand-rolled, no query library.** All fetching goes through the shared `pipeline/` engine called from
two places: `useTileGraph` (Overpass + Open-Meteo for the graph) and `MapScreen` handlers (Nominatim
for geocode/suggest/reverse).

**The fetch state machine is `useTileGraph`'s `pump`** (`useTileGraph.ts:166-227`): single-flight
(`busyRef`), corridor-prioritized over viewport, debounced (`DEBOUNCE_MS = 600`, `:64`), with a capped
self-heal retry for elevation-degraded regions (`MAX_RETRIES = 6`, `:65`; `RETRY_MS = 12000`, `:71`). →
see **`03-single-flight-tile-pump.md`**.

**Cache: two layers.** (1) An in-memory + AsyncStorage elevation cache keyed by ~90m DEM cell, debounced
writes, 50k-entry cap, survives restarts (`elevCache.ts:7-57`). (2) The region-coverage check `covers()`
(`useTileGraph.ts:82-86`) is a coarse "do we already have this bbox?" cache that short-circuits refetch.

**Invalidation:** DEM samples never change, so the elevation cache is valid forever (`elevCache.ts:2-4`).
The region cache invalidates by *degraded* flag — a flat-fallback region is treated as a miss so it
refetches (`covers()` returns false when `r.degraded`, `:83`).

**Error/retry:** elevation failure degrades to flat 0m rather than failing the build
(`bestEffortElevation`, `useTileGraph.ts:20-31`); Overpass failure keeps the last region and waits for
the next pan (`:219-220`). No optimistic mutations — this is read-only data.

Cross-link: HTTP/wire semantics and rate-limit behavior belong to `study-networking`; cache-as-system-
architecture belongs to `study-system-design`.

## 5. routing-and-navigation

**`not yet exercised` — single screen, no navigation library.** There is no React Navigation, no
expo-router, no stack/tab. The entire app is `MapScreen`. "Routing" in flattr means *street routing*
(A\*), not screen routing. No code-splitting at a route boundary (nothing to split), no deep-linking,
no scroll restoration, no guards/redirects.

The closest navigation-adjacent behavior is *camera* movement — `cameraRef.current?.easeTo(...)` for
recenter/route/locate (`MapScreen.tsx:100,115,197,231,262`) — but that's map camera, not app routing.

## 6. styling-and-design-system

**`StyleSheet.create` inline per component; no design-token system.** Each component defines its own
`StyleSheet` (`MapScreen.tsx:387`, `AddressBar.tsx:122`, etc.). Colors are inline hex literals
repeated across files (`#1565c0` the brand blue appears in nearly every component).

**The one shared "token" set is the grade palette** in the engine: `COLORS` /`bandColor` in
`features/grade/classify.ts:18-27` (green/yellow/red/grey). This is consumed by both the React `Legend`
(`Legend.tsx:23`) and the map-layer GeoJSON (`features/map/geojson.ts:31`), so the legend never drifts
from what's painted — that's the closest thing to a design token in the repo.

**Theming: `not yet exercised`.** `userInterfaceStyle: "light"` is hard-set (`app.json`), no dark mode,
no theme context. **Responsive: `not yet exercised`** — `orientation: "portrait"` locked, overlays use
fixed pixel offsets (`top: 160`, `top: 268` — `Legend.tsx:35`, `GradeSlider.tsx:44`) that are manually
stacked, a known fragility (see lens 8). **Animation:** only MapLibre camera eases; no React-side
animation system (no Reanimated, no `Animated`).

## 7. browser-platform-and-build

**Platform APIs actually touched:**
- **expo-location** — foreground permission + `getCurrentPositionAsync` (`MapScreen.tsx:95-97`),
  declared in `app.json` plugins with a usage string.
- **MapLibre native** (`@maplibre/maplibre-react-native` ^11.3.4) — native map view, declarative
  sources/layers, `CameraRef` imperative handle (`MapScreen.tsx:4,70,100`).
- **AsyncStorage** (`@react-native-async-storage/async-storage` 2.2.0) — the persistent elevation cache
  (`elevCache.ts:5,21,53`).
- **`StatusBar.currentHeight`** — Android status-bar inset for overlay offset (`MapScreen.tsx:24`).
- **`Keyboard.dismiss()`** — after map-tap / suggestion select (`MapScreen.tsx:246,261`).

`@react-native-community/slider` is a dependency (`package.json:7`) but **not imported** anywhere in
`src/` — `GradeSlider` uses preset `Pressable` chips, not a slider. Dead dependency.

**Build: Expo / Metro.** Standard Expo bundling. The notable customization is `metro.config.js`: a
custom `resolveRequest` that aliases `features`/`lib`/`pipeline` to `mobile/.engine/*` (the shared
engine synced in by `scripts/sync-engine.mjs`) because Metro won't resolve imports escaping the project
root. `tsconfig.json` points the same aliases at the real `../features/*` source for typechecking. The
graph is bundled as a static `assets/graph.json` import (`loadGraph.ts:7`). No code-splitting, no
tree-shaking config, no service worker.

Cross-link: bundle-size *measurement* belongs to `study-performance-engineering`.

## 8. frontend-red-flags-audit

Ranked by user-visible consequence.

**1. Render-time A\* blocks the JS thread (highest leverage).** `directedAstar` runs in a `useMemo`
during render (`MapScreen.tsx:151-162`). On a large merged corridor graph, every `userMax` change (and
every tile that lands, changing `graph`) re-runs the full search synchronously on the single JS thread.
Inferred consequence: dragging across grade presets *would* drop frames on a big graph, because there's
no `useTransition`/worker offload. Not yet observed at a number — that's `study-performance-engineering`'s
job — but the coupling is structural. → `01-render-time-astar.md`.

**2. Heatmap rebuild on every `userMax` change touches every edge.** `graphToGeoJSON(displayGraph,
bandsForUserMax(userMax))` re-maps all edges into GeoJSON whenever `userMax` changes
(`MapScreen.tsx:121-124`, `geojson.ts:20-34`). On a dense viewport this is O(edges) per slider tap, also
render-time. Same single-thread cost as #1.

**3. Manually stacked fixed-offset overlays.** Panel positions are hardcoded pixel tops that must be
kept consistent by hand: address bar at `top:8`, toggle at `top:160`, legend at `top:160`, slider at
`top:268`, summary at `bottom:150`, locate at `bottom:90` (`AddressBar.tsx:124`, `MapScreen.tsx:430`,
`Legend.tsx:35`, `GradeSlider.tsx:44`, `RouteSummaryCard.tsx:49`, `MapScreen.tsx:418`). Add a panel or
change one height and the others overlap. The `searching` flag hiding panels (`MapScreen.tsx:277,
316-381`) is a workaround for the dropdown colliding with this stack.

**4. Status-bar inset is Android-only.** `STATUS_BAR_INSET = StatusBar.currentHeight ?? 24`
(`MapScreen.tsx:24`) — `currentHeight` is `undefined` on iOS, so it falls back to a magic `24`. On a
notched iPhone the overlay offset is a guess, not a safe-area inset. (`App.tsx` does wrap in
`SafeAreaView`, which mitigates this for the root.)

**5. `userMax` is not used in the `zoneCells` memo deps but `zonesFC` recomputes anyway.** `zoneCells`
deps are `[displayGraph, view]` (`MapScreen.tsx:125-128`) — correct, cells don't depend on `userMax`.
`zonesFC` re-colors on `userMax` (`:129`). This is actually correct, listed only to confirm it's *not* a
stale-closure bug.

**6. Dead `slider` dependency** ships in the bundle unused (`package.json:7`). Minor; size only.

**No critical correctness red flags** — state is single-owner and derived, so there's little room for
the classic "state stored where it can't be invalidated" bug. The risks here are all performance-
coupling and layout-fragility, both inferred from structure rather than observed at runtime.
