# Frontend Engineering Audit — flattr `mobile/`
## Pass 1 — the 8-lens sweep

One `##` section per lens. Each names what the code actually does with
`file:line` grounding, or emits `not yet exercised`. Significant findings
cross-link to a Pass 2 pattern file. All paths are under
`/Users/rein/Public/flattr/mobile/` unless noted; engine paths are repo-root
relative (`features/`, `pipeline/`, `lib/`).

---

## 1. rendering-and-reactivity

**Mode: single-screen native app. No SPA router, no SSR, no SSG, no RSC, no
hydration.** `index.ts:8` calls `registerRootComponent(App)`, which wires
`AppRegistry.registerComponent('main', () => App)` for both Expo Go and native
builds. `App.tsx:5-12` renders a `SafeAreaView` wrapping a single
`<MapScreen />`. There is exactly one screen.

**Reconciliation: React 19 (`package.json:9`) virtual-tree diffing, committed
through React Native's renderer to native views** — not the DOM. The
`@maplibre/maplibre-react-native` components (`<Map>`, `<Camera>`,
`<GeoJSONSource>`, `<Layer>`, `<Marker>`) are thin JS proxies; the actual map
is a native `MapView` (`UIView` on iOS, `android.view` on Android) that
renders on the native/UI thread. The boundary matters: React describes the
tree in JS; the pixels are drawn natively. → `03-native-maplibre-declarative-layers.md`.

**Scheduling: synchronous.** React 19 supports concurrent features, but this
app uses none — no `useTransition`, no `useDeferredValue`, no `Suspense`. Every
state change re-renders `MapScreen` synchronously on the JS thread. The
consequence is load-bearing: the A* search runs inside a render-time `useMemo`
(`MapScreen.tsx:143-154`), so a route recompute blocks the JS thread. → cross-link
`.aipe/study-runtime-systems/` for what that costs; pattern walk in
`02-derived-render-time-astar.md`.

**When work happens:** mount (GPS `locate(false)` in a `useEffect`,
`MapScreen.tsx:105-107`), and on every `setState` (re-render → `useMemo`
recompute → new props serialized to native). No layout-effect usage, no
`useImperativeHandle` beyond the MapLibre `cameraRef` imperative escape hatch
(`MapScreen.tsx:67`, `97`, `112`).

→ runtime event-loop mechanics: `.aipe/study-runtime-systems/`.

---

## 2. state-architecture

**One component owns all UI state. No global store, no Context, no reducer,
no URL state, no persisted state.** All source state is `useState` in
`MapScreen` (`MapScreen.tsx:52-65`): `userMax`, `startPt`, `endPt`, `view`,
`userLoc`, `routeBusy`, `routeError`, `fromText`, `toText`, `activeField`,
`suggestions`, `suggestField`. Refs hold non-render values: `suggestTimer`
(debounce handle, `:66`) and `cameraRef` (imperative map handle, `:67`).

**The defining choice: heavy outputs are derived, not stored.** `heatmap`
(`:116`), `zoneCells`/`zonesFC` (`:120-121`), `startId`/`endId` (`:125-126`),
and `routed` (`:143-154`) are all `useMemo` — recomputed from source state on
dependency change, never written to state. This is *derived state as the
source of truth* done well: there's no `routeState` to keep in sync, so it
can't drift. The cost is that the derivation includes a full A* search.
→ `02-derived-render-time-astar.md`.

**Endpoints stored as coordinates, not node ids** (`:55-56`, comment `:53-54`):
`startPt`/`endPt` are `{lat,lng}`, and `startId`/`endId` re-derive via
`nearestNode` against the *current* graph (`:125-126`). This is deliberate —
as corridor tiles load, a closer real node may appear, and the endpoint
re-snaps automatically. Storing the id would freeze it to a stale graph.

**`useRef`-vs-`useState` discipline is the most interesting state decision in
the hook.** `useTileGraph` keeps *both* a ref and a state for view/corridor
(`useTileGraph.ts:61-69`): state drives re-render of the merged `graph`
(`:72-85`); refs (`viewRef`, `corridorRef`, `busyRef`, `pendingViewRef`,
`pendingCorridorRef`) hold the single-flight control state that must be read
synchronously inside `pump()` without waiting for a re-render. → `01-on-demand-tile-graph.md`.

System-level state ownership of the graph artifact: cross-link
`.aipe/study-system-design/` *(not yet generated)*.

---

## 3. component-architecture

**Container-vs-presentational, cleanly drawn.** `MapScreen` is the lone
container: it owns all state, all handlers, all data flow. The five children
are presentational and fully controlled via props — they hold no business
state:

- `AddressBar` (`src/AddressBar.tsx`) — From/To inputs + suggestions +
  Route button; every value and callback is a prop (`:29-57`). It has one
  private sub-component, `Suggestions` (`:9-27`), composed in.
- `GradeSlider` (`src/GradeSlider.tsx:13-38`) — three preset chips; `userMax`
  in, `onChange` out. (Despite the name, the slider was dropped — recent
  commit `b24797c` — it's preset buttons now.)
- `Legend` (`src/Legend.tsx:11-29`) — pure function of `userMax`.
- `RouteSummaryCard` (`src/RouteSummaryCard.tsx:6-42`) — pure function of
  `{found, summary, userMax}`; returns `null` when there's nothing to show.

**Composition pattern: props-down/callbacks-up only.** No render props, no
children-as-function, no compound components, no headless pattern, no Context.
`AddressBar`'s prop list is wide (13 props, `:43-57`) — the one place where a
small Context or a grouped `search` object would tighten the interface, but at
this app size the flat prop list is honest and readable.

Module-depth / interface analysis: cross-link `.aipe/study-software-design/`.

---

## 4. data-fetching-and-cache

**Hand-rolled `async` functions. No react-query, no SWR, no route loaders,
no RSC.** Server state enters at two seams:

- **Graph + elevation** via `useTileGraph` (`src/useTileGraph.ts`): `pump()`
  (`:89-129`) runs `fetchOverpass(bbox)` → `buildGraph(...)` →
  `bestEffortElevation(openMeteoProvider(...))`. → `01-on-demand-tile-graph.md`.
- **Geocoding** via `pipeline/geocode` (Nominatim): `geocodeSuggest`
  (autocomplete, `MapScreen.tsx:79`), `geocode` (Route button, `:177`,`:181`),
  `reverseGeocode` (map tap → label, `:229`). → `04-controlled-search-with-debounce.md`.

**Caching = the merged graph itself.** There's no query cache; instead, fetched
regions are kept in state (`view`, `corridor` in `useTileGraph.ts:61-62`) and
*merged* into the displayed graph (`:72-85`). `covers()` (`:45-49`) and
`bboxContains()` (`:51-53`) are the cache-hit checks: if the base graph or
current viewport already covers the bounds, skip the fetch
(`:141-142`, `:160`). Coverage is the invalidation key.

**Concurrency control is the standout.** A single-flight gate (`busyRef`,
`:67`) ensures exactly one network build runs at a time, with the route
corridor draining before the viewport (`pump()` checks
`pendingCorridorRef` before `pendingViewRef`, `:93-103`). This keeps the app
under the free Overpass / Open-Meteo rate limits — a real product constraint
(user memory: Open-Meteo 429s under heavy use). → `01-on-demand-tile-graph.md`.

**Error/retry: degrade, don't fail.** `bestEffortElevation` (`:18-28`) catches
elevation errors and returns flat (0 m) elevation so streets still render and
routing still connects. Overpass failure is swallowed in `pump`'s `catch`
(`:121-122`) — the last region is kept; a later pan retries. Geocode/suggest
errors are swallowed too (`MapScreen.tsx:82-84`, `:194-196`).

Wire semantics, rate-limit behavior, backoff: cross-link
`.aipe/study-networking/`.

---

## 5. routing-and-navigation

**not yet exercised.** There is no navigation library — no React Navigation,
no Expo Router, no `expo-router` in `package.json`. The app is one screen
(`App.tsx:5-12`). There is no file-based routing, no route-level code-
splitting, no navigation lifecycle, no guards, no scroll restoration.

The only thing resembling "navigation" is **map-camera control** via the
imperative `cameraRef` (`MapScreen.tsx:67`, `easeTo` at `:97`,`:112`,`:189`,
`:213`,`:244`) — moving the viewport, not the route tree. And **deep-linking**
is also absent: no URL scheme handling, no linking config in `app.json`.

If this app grew a second screen (route detail, saved routes), this is the
lens that would light up first.

---

## 6. styling-and-design-system

**`StyleSheet.create` co-located per component. No design-token system, no
theme provider, no dark mode, no responsive breakpoint system.** Every
component ends with a local `StyleSheet.create({...})` block: `App.tsx:14`,
`MapScreen.tsx:351-406`, `AddressBar.tsx:115-158`, `GradeSlider.tsx:40-65`,
`Legend.tsx:31-44`, `RouteSummaryCard.tsx:44-53`.

**The one real design-token discipline lives in the engine, not the styles:**
colors are driven by grade *semantics*, not hardcoded per-component. `bandColor`
(`features/grade/classify.ts:18-27`) is the single source of truth for the four
band colors (green `#2e9e3f`, yellow `#e8b500`, red `#d23b2e`, grey `#9aa0a6`).
`Legend` consumes `bandColor` directly (`Legend.tsx:23`) so the legend can
never drift from the map. That's a genuine token-resolver pattern — but scoped
to grade colors only; the brand blue `#1565c0` is repeated as a literal across
five files (e.g. `MapScreen.tsx:285`, `AddressBar.tsx:138`,`:142`,
`GradeSlider.tsx:62`, `Legend` via swatch). No token for it.

**Responsive strategy:** none beyond Flexbox + `SafeAreaView` (`App.tsx:7`) and
a single `StatusBar.currentHeight` inset (`MapScreen.tsx:24`). Layout is
absolute-positioned overlays at fixed top offsets (`Legend` `top:160`,
`GradeSlider` `top:268`, etc.) — hand-tuned to stack, not a layout system.
`orientation: portrait` is locked in `app.json:6`, so the fixed offsets are safe.

**Animation:** only MapLibre camera transitions (`easeTo` with `duration`).
No `Animated`, no Reanimated, no layout animation. `@react-native-community/
slider` is a dependency (`package.json:6`) but **unused** — the slider was
removed (commit `b24797c`); it's dead weight in the manifest.

---

## 7. browser-platform-and-build

**Platform APIs touched:** exactly one device API — **GPS via `expo-location`**
(`MapScreen.tsx:5`,`90-102`): `requestForegroundPermissionsAsync` then
`getCurrentPositionAsync({accuracy: Balanced})`. Permission string and the
config plugin are declared in `app.json:24-31`. No Storage/AsyncStorage, no
filesystem, no camera, no sensors, no background tasks. The MapLibre plugin is
also registered (`app.json:24`).

**Bundler: Metro** (Expo's default), with one notable custom resolver. The repo
keeps the routing engine at the *repo root* (`features/`, `lib/`, `pipeline/`)
and the mobile app imports it via bare aliases. Because Metro won't resolve
relative imports that escape the project root, `metro.config.js:38-47` installs
a custom `resolver.resolveRequest` that maps `features/*`, `lib/*`,
`pipeline/*` to a synced copy at `mobile/.engine/*` (`:16-20`), probing real
file extensions (`:26-36`). `mobile/scripts/sync-engine.mjs` copies the engine
in before bundling; `tsconfig.json:5-9` points `tsc` at the *real* root source
for typechecking. So: **two resolution paths — Metro bundles the synced copy,
TypeScript checks the original.** This is the build seam worth knowing.

**Deploy artifact:** native iOS/Android binaries (`expo run:ios` /
`expo run:android`, `package.json` scripts), or Expo Go for dev (`expo start`).
The graph is a **bundled static asset** — `assets/graph.json` imported directly
(`src/loadGraph.ts:7`), so it ships inside the binary; no fetch at launch for
the base area.

Tree-shaking / code-splitting / sourcemaps: Metro defaults, not configured
here. Bundle-size *measurement* (the static `graph.json` is the heaviest single
asset): cross-link `.aipe/study-performance-engineering/` *(not yet generated)*.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence. Each grounded in real evidence.

**🔴 1 — A\* runs synchronously on the JS thread, in a render-time `useMemo`.**
`MapScreen.tsx:143-154`. `directedAstar(graph, startId, endId, userMax)` is a
full priority-queue graph search; it executes during render, on the single JS
thread. Consequence: on a large merged graph (base ∪ corridor ∪ view after
several pans), the route recompute can block the thread and drop frames — the
map gesture and the loading spinner both stutter while A* runs. It re-runs on
*any* dep change including `userMax` (dragging the preset), so toggling
presets re-searches. This is the top risk and the reason the runtime-systems
guide exists. → `02-derived-render-time-astar.md`, `.aipe/study-runtime-systems/`.

**🟠 2 — Full-graph GeoJSON rebuilt on every `userMax` or graph change.**
`MapScreen.tsx:116` (`graphToGeoJSON` maps *every* edge) and `:120-121`
(`computeZones` over the whole graph). Both are `useMemo`-gated, so they only
recompute when `graph` or `userMax` changes — but when they do, it's an O(edges)
rebuild plus a full new FeatureCollection serialized across the bridge to
MapLibre. As pan-loaded tiles grow the graph, this cost grows with it. Measure
before optimizing — cross-link `.aipe/study-performance-engineering/`.

**🟡 3 — `AddressBar` has a 13-prop interface.** `AddressBar.tsx:43-57`. Wide
prop lists are a re-render and maintenance smell: any state change in
`MapScreen` that touches a passed value re-renders the whole bar (no `memo`).
At this size it's fine; if the search UI grows, group props into a `search`
object or lift a small Context. Named, not urgent.

**🟡 4 — Errors are swallowed silently in several places.** `pump`'s catch
(`useTileGraph.ts:121-122`), suggest catch (`MapScreen.tsx:82-84`),
elevation fallback (`:18-28`). Good for resilience (the UI degrades instead of
crashing), but a user whose Overpass fetch keeps failing sees only "Loading
grades" disappear with no streets — no error surfaced for the *graph* fetch
(only routing/geocode get `routeError`). A silent "couldn't load this area"
toast would close the gap.

**🟢 5 — Dead dependency.** `@react-native-community/slider` (`package.json:6`)
is installed but unused after the slider was removed (commit `b24797c`).
Harmless, but it bloats the dependency surface and the binary. Remove it.

**🟢 6 — Brand color `#1565c0` is an untokenized literal** repeated across five
files (see lens 6). Cosmetic; a single exported constant would prevent drift.

**Not a red flag, worth noting:** the `useRef`/`useState` pairing in
`useTileGraph` looks redundant but is correct and load-bearing — the ref is
read synchronously inside `pump()` (which can't wait for a re-render), the
state drives the merged-graph `useMemo`. Don't "simplify" it away.
