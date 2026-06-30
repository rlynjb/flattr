# Frontend Engineering Audit — flattr `mobile/`

Pass 1 of the two-pass shape. Eight lenses, each grounded in `file:line` or marked
`not yet exercised`. Significant findings cross-link to a Pass-2 pattern file.

Stack as built: Expo `~56.0.12`, React Native `0.85.3`, React `19.2.3`,
`@maplibre/maplibre-react-native@^11.3.4`, `expo-location@~56.0.18`,
`@react-native-async-storage/async-storage@2.2.0`. TypeScript `~6.0.3`.
Entry: `index.ts` → `App.tsx` → `src/MapScreen.tsx`.

---

## 1. rendering-and-reactivity

**Mode: native-rendered, declarative, recompute-on-demand. Not SPA/SSR/SSG —
those categories are web-only.** There is no DOM. React reconciles a tree of
React Native + MapLibre host components; the actual map raster and vector
features are drawn by the native MapLibre renderer (`@maplibre/maplibre-react-native`).

The reconciliation seam: React diffs the *props* you pass `<GeoJSONSource
data={…}>` (`MapScreen.tsx:287, 292, 297`); when `data` changes identity, the
bridge ships the new FeatureCollection to native and MapLibre redraws. React's
virtual-DOM diff decides *what data crosses the bridge*, never *how pixels land*.

**When work happens:** all derived render data is computed in `useMemo` during
render, on the JS thread:
- `routed` (the route) — `MapScreen.tsx:151–162` → `directedAstar` runs here.
  This is A\* on the render path. **→ see `01-render-thread-astar.md`.**
- `heatmap` / `zoneCells` / `zonesFC` — `MapScreen.tsx:121–129`, gated on
  `view === "edges"` / `"zones"` so they're only built when shown (on-demand).
- `startId` / `endId` — `MapScreen.tsx:133–134`, `nearestNode` per render.

**Scheduling:** plain synchronous React 19. No `useTransition`, no
`useDeferredValue`, no Suspense, no concurrent-feature opt-in. Every state change
re-renders `MapScreen` synchronously and re-runs whichever memos have stale deps.
The JS-thread event loop and frame budget belong to `study-runtime-systems` and
`study-performance-engineering` respectively — this lens names the *coupling*;
those guides own the *numbers*.

---

## 2. state-architecture

**Shape: lifted local state in one component + imperative refs in one hook. No
global store, no context, no reducer.**

Source-of-truth `useState` in `MapScreen` (`:37, :56–68`): `view`, `userMax`,
`startPt`, `endPt`, `userLoc`, `routeBusy`, `routeError`, `fromText`, `toText`,
`activeField`, `suggestions`, `suggestField`. Eleven pieces, all flat.

**The one deliberate state-design call:** endpoints are stored as **coordinates**
(`startPt`/`endPt`, `:59–60`), and the node id is **derived** (`startId`/`endId`,
`:133–134`) via `useMemo(nearestNode(graph, pt))`. Source-of-truth is the
geographic point; the graph node is a projection that re-snaps as tiles load.
**→ see `04-coords-as-endpoint-state.md`.**

**Derived state, never stored:** `routed` (`:151`), `heatmap`/`zones` (`:121`),
`showCard`/`searching` (`:274, :277`). The pattern is consistent — compute from
source-of-truth in a memo rather than mirror it into more state.

**Imperative state lives in refs**, in `useTileGraph`: `viewRef`, `corridorRef`,
`busyRef`, `pendingViewRef`, `pendingCorridorRef`, `timerRef`, `retryRef`,
`retryCountRef`, `gradesOnRef`, `lastBoundsRef` (`useTileGraph.ts:111–122`). These
back a single-flight job machine that must *not* trigger re-renders on every
mutation — refs are the right tool. The committed results (`view`, `corridor`)
are mirrored into `useState` (`:107–108`) so the derived `graph`/`displayGraph`
memos recompute. **→ see `02-single-flight-pump.md`.**

**Form state:** controlled inputs (`AddressBar.tsx:70–79, 88–98`) lifted to
`MapScreen` (`fromText`/`toText`). No form library; `canRoute` is derived inline
(`AddressBar.tsx:60`). **URL state: not yet exercised** (no router).

---

## 3. component-architecture

**Shape: one fat orchestrator + five thin presentational children.**

`MapScreen` (443 lines) owns all state, all handlers, all data wiring. The
children are presentational, controlled entirely by props:
- `AddressBar` (`AddressBar.tsx`) — 13 props, fully controlled inputs +
  suggestions dropdown. Contains one private sub-component `Suggestions` (`:9–27`).
- `GradeSlider` (`GradeSlider.tsx`) — `userMax` + `onChange`. Preset chips.
- `Legend` (`Legend.tsx`) — `userMax` only; derives bands from it.
- `RouteSummaryCard` (`RouteSummaryCard.tsx`) — `found`/`summary`/`userMax`/`note`.
- `marker` (`MapScreen.tsx:265–272`) — a render helper, not a component.

Composition is **plain props (container/presentational)** — no children/slots,
no render props, no headless pattern, no compound components. That's the right
call at this size: five children, one screen, no reuse pressure yet. The
discipline is clean: every child is a pure function of props with local
`StyleSheet`. Module/interface depth belongs to `study-software-design`.

The smell to name: `MapScreen` is doing a lot — view toggle, geocoding,
autocomplete debounce, location, tap-to-route, swap, the route memo, and all map
layers. It's not *wrong* at one screen, but it's the file that would split first
if a second screen appeared (extract `useRouting`, `useGeocodeSuggest`).

---

## 4. data-fetching-and-cache

**Shape: hand-rolled. No react-query/SWR/route-loaders.** Server-state crosses
into client-state through `useTileGraph`, which is a bespoke fetch+cache machine.

- **Fetch wrapper:** none generic; `pipeline/*` functions (`fetchOverpass`,
  `openMeteoProvider`, `geocode`/`reverseGeocode`/`geocodeSuggest`) are called
  directly.
- **Single-flight:** one build at a time via `busyRef` + a `pump()` drain loop
  (`useTileGraph.ts:166–227`), corridor prioritized over viewport.
  **→ `02-single-flight-pump.md`.**
- **Cache invalidation:** coverage-based, not time-based. `covers()`
  (`:82–86`) treats a region as a cache hit only if it fully contains the bbox
  *and* isn't degraded; degraded regions always miss so they refetch real grades.
- **Two-tier elevation cache:** in-memory `Map` + AsyncStorage write-behind,
  keyed by ~90m DEM cell (`elevCache.ts`, `useTileGraph.ts:36–62`). DEM values
  never change, so cache entries are valid forever. **→ `06-persistent-write-behind-cache.md`.**
- **Error / degraded handling:** `bestEffortElevation` (`:20–31`) swallows a
  throttled elevation API and builds with flat (0 m) elevation so streets still
  render and routing still connects — then flags the region `degraded` for a
  silent self-heal retry. **→ `05-debounce-as-throttle-with-self-heal.md`.**
- **Optimistic updates: not yet exercised** (no mutations to a server).
- **Geocode autocomplete:** debounced 400 ms (`MapScreen.tsx:73–89`), bounded to
  a ~30 km viewbox so "starbucks" returns local hits (`:51–54`).

Wire semantics (rate limits, retry/backoff on the socket) belong to
`study-networking`; this lens owns the *client cache contract*.

---

## 5. routing-and-navigation

**not yet exercised.** Single screen. `App.tsx` renders `MapScreen` directly; no
React Navigation, no Expo Router, no route config, no deep links, no code-split
boundary, no navigation lifecycle. The only "navigation" is *map camera*
movement (`cameraRef.current?.easeTo`, e.g. `MapScreen.tsx:100, 197, 262`), which
is map state, not app routing.

If a second screen ever lands (saved routes, settings), this is where Expo Router
or React Navigation enters and `MapScreen` sheds its god-component weight.

---

## 6. styling-and-design-system

**Shape: per-component `StyleSheet.create` with inline hex literals. No design
system.**

Every component ends in a local `StyleSheet.create` block
(`MapScreen.tsx:387`, `AddressBar.tsx:122`, etc.). Layout is absolute-position
overlays stacked over a full-bleed `<Map>`, hand-tuned with magic-number top
offsets (`toggle top:160`, `Legend top:160`, `GradeSlider top:268`,
`RouteSummaryCard bottom:150`) — a fragile vertical stack tuned by eye, not a
layout system.

- **Design tokens: not yet exercised.** The brand blue `#1565c0` is a literal
  repeated across `MapScreen`, `AddressBar`, `GradeSlider`, `Legend`, and
  `RouteSummaryCard` — five files, no shared token. Change the brand color =
  five-file grep-and-replace. The *band* colors are centralized (`bandColor` in
  `features/grade/classify.ts`, consumed by `Legend.tsx:23` and the map layers),
  so the data-driven palette composes — but the chrome palette does not.
- **Theming / dark mode: not yet exercised.** `App.tsx:8` hard-codes
  `barStyle="dark-content"`; no `useColorScheme`, no theme context.
- **Responsive strategy: not yet exercised** as a system. `flex:1` + absolute
  overlays adapt to screen size loosely; no breakpoints/container queries.
- **Animation:** only MapLibre camera eases (`easeTo` duration props). No
  Reanimated, no `Animated`, no layout animation.

---

## 7. browser-platform-and-build

**Platform APIs actually touched:**
- **`expo-location`** — `requestForegroundPermissionsAsync` +
  `getCurrentPositionAsync` (`MapScreen.tsx:95–97`). Locate-on-launch (`:108–110`)
  and a locate button (`:114–117`). Permission-denied falls back to the bundled
  bbox center — graceful, no crash.
- **MapLibre native** — `<Map>/<Camera>/<GeoJSONSource>/<Layer>/<Marker>`
  (`MapScreen.tsx:281–312`). **→ `03-declarative-data-driven-map-layers.md`.**
- **AsyncStorage** — persistent elevation cache (`elevCache.ts`). The only
  storage API. **→ `06-persistent-write-behind-cache.md`.**
- **`Keyboard`** — `Keyboard.dismiss()` on map-tap / suggestion-select
  (`MapScreen.tsx:246, 261`).
- **`StatusBar.currentHeight`** — overlay top inset (`MapScreen.tsx:24`).
- **`fetch`** — passed into `openMeteoProvider(fetch, …)` (`useTileGraph.ts:191`).

**Build:** Expo managed (`expo start` / `expo run:android` / `expo run:ios`,
`package.json`). Metro bundler (Expo default — not Vite/Webpack/Turbopack). Deploy
artifact is a native app binary, not a JS bundle on a CDN. `graph.json` is
bundled as an asset and imported directly (`loadGraph.ts:7`). No code splitting
(single screen), no tree-shaking concern surfaced, no service worker (native).
Bundle-size *measurement* belongs to `study-performance-engineering`.

**Dead dependency:** `@react-native-community/slider@5.2.0` is declared in
`package.json` but imported nowhere — `GradeSlider.tsx` uses preset `Pressable`
chips, not a `<Slider>`. Remove it.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence.

1. **A\* on the JS render thread (`MapScreen.tsx:151–162`).** `directedAstar`
   runs synchronously inside a `useMemo` during render. Today the graph is small
   (Capitol Hill + on-demand tiles) and the deps are tight, so it's fast. But
   every recompute blocks the JS thread, and the route memo re-runs whenever
   `graph`, `startId`, `endId`, or `userMax` changes — including *every corridor
   tile load* and *every preset tap*. As coverage grows, a slow search janks the
   whole UI (the map gestures live on the native thread and stay smooth, but JS-
   driven overlays freeze). **Move:** if it ever janks, push A\* off-thread (a
   worklet / `InteractionManager` / a worker) and feed the result back as state.
   **→ `01-render-thread-astar.md`.** Quantify with `study-performance-engineering`.

2. **`#1565c0` brand color duplicated across five files (lens 6).** No token. A
   rebrand is a grep-and-replace with no compiler help. Low user-facing risk,
   high maintenance tax. **Move:** one `colors.ts` token module.

3. **Magic-number absolute overlay offsets (lens 6).** `top:160`, `top:268`,
   `bottom:150` hand-tuned. A taller status bar, a font-scale accessibility
   setting, or a third panel shifts the stack and panels overlap. **Move:** a
   flex/inset layout or computed offsets instead of literals.

4. **`MapScreen` is a 443-line god component (lens 3).** Owns all state, all
   network wiring, all handlers. Not a bug, but the first thing that blocks a
   second screen or a test seam. **Move:** extract `useRouting` and
   `useGeocodeSuggest` hooks.

5. **No error boundary.** `if (!graph)` renders a static "Failed to load graph"
   (`MapScreen.tsx:164–170`), but a throw inside `directedAstar` or a layer
   render has no boundary to catch it — it unmounts to a red screen / native
   crash. **Move:** wrap `MapScreen` in an error boundary.

6. **Dead `@react-native-community/slider` dependency (lens 7).** Ships unused
   native code in the binary. **Move:** delete from `package.json`.
