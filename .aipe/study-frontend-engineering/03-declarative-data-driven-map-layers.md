# 03 — Declarative data-driven map layers

**Industry names:** declarative data-driven styling (Mapbox/MapLibre term);
data-binding to a GPU layer; "remount-by-key" for the frozen-id workaround.
**Type:** Industry standard (MapLibre), project-specific application.

## Zoom out, then zoom in

You already know the React idiom: render a list by mapping data to elements, give
each a stable `key`, let React diff. flattr does the same thing, one layer down —
it maps a `Graph` to a **GeoJSON FeatureCollection**, hands it to a declarative
`<GeoJSONSource>`, and a `<Layer>` paints each feature by reading a *property off
the data itself* (`["get", "color"]`). The color isn't in the style — it's in the
data. React owns *what data*; the native GPU renderer owns *how it's drawn*.

```
  Zoom out — the JS/native styling seam

  ┌─ App layer (React) ───────────────────────────────────────────┐
  │  Graph ─► graphToGeoJSON / routeToGeoJSON / zonesToGeoJSON     │
  │           (each feature carries a `color` property)            │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ data={featureCollection} (props)
  ┌─ Native map layer (MapLibre) ─▼───────────────────────────────┐
  │  <GeoJSONSource data=…>                                        │ ← we are here
  │    <Layer style={{ lineColor: ["get", "color"] }}>   GPU paint │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: two ideas. (1) **Data-driven styling** — the layer's paint reads a
data-expression, not a constant. (2) **Remount-by-key** — because MapLibre freezes
a source/layer `id` at mount, switching overlays needs a fresh React `key` to
force a remount rather than mutate the id in place.

## Structure pass

**Layers:** (1) `Graph` in client state → (2) GeoJSON shaping functions → (3)
React `<GeoJSONSource>`/`<Layer>` host components → (4) native GPU render.

**Axis — control (who decides a feature's color?):**

```
  Axis: "who decides what color a feature is?"

  ┌─ shaping fn (JS) ─────────────┐  JS computes color PER FEATURE
  │ graphToGeoJSON → props.color  │  from grade vs userMax, bakes it in
  └───────────┬───────────────────┘
  ┌─ Layer style (declarative) ───▼┐ STYLE just says "read .color"
  │ lineColor: ["get","color"]     │ no per-feature logic in the style
  └───────────┬────────────────────┘
  ┌─ GPU (native) ────────────────▼┐ GPU paints; knows nothing about grade
  │ draws each line with its color │
  └────────────────────────────────┘
```

The color decision lives entirely in JS, baked into the data. The style is dumb
on purpose — `["get", "color"]` is the whole rule.

**Seam (load-bearing):** the `id` on `<GeoJSONSource>`/`<Layer>`. MapLibre treats
`id` as immutable after mount. So the React `key` becomes the control point for
*identity* — change the `key`, get a new native source; keep it, mutate `data` in
place. Trace the control axis across it and it flips: same component type, but a
new `key` means "tear down + rebuild native object," same `key` means "diff props."

## How it works

### Move 1 — the mental model

Same shape as `items.map(i => <Row key={i.id} … />)`, except the "row" is a GPU
layer and the "key" decides whether the native object is rebuilt or reused.

```
  Pattern — data → declarative source → data-driven paint

   Graph ──► shaping fn ──► FeatureCollection
                              [ {geometry, properties:{color}}, … ]
                                          │ data=…
                              ┌───────────▼───────────┐
                              │ <GeoJSONSource id=X>   │  ← id frozen at mount
                              │   <Layer ["get",color]>│  ← reads .color per feature
                              └───────────┬───────────┘
                                          ▼  GPU paints each line/fill by its color
```

### Move 2 — the walkthrough

**Three layers, three sources, one branch** — `MapScreen.tsx:286–304`:

```tsx
{view === "edges" && heatmap && (
  <GeoJSONSource key="src-edges" id="edges" data={heatmap}>   {/* ① per-street heatmap */}
    <Layer id="edge-lines" type="line"
      style={{ lineColor: ["get", "color"], lineWidth: 2 }} /> {/* ② data-driven color */}
  </GeoJSONSource>
)}
{view === "zones" && (
  <GeoJSONSource key="src-zones" id="zones" data={zonesFC}>    {/* ③ coarse terrain */}
    <Layer id="zone-fill" type="fill"
      style={{ fillColor: ["get", "color"], fillOpacity: 0.5 }} />
  </GeoJSONSource>
)}
{routed.fc && (
  <GeoJSONSource id="route" data={routed.fc}>                 {/* ④ the route line */}
    <Layer id="route-line" type="line"
      style={{ lineColor: ["get", "color"], lineWidth: 6, lineCap: "round" }} />
  </GeoJSONSource>
)}
```

**① Conditional mount = the layer toggle.** `view === "edges"` decides whether the
heatmap source exists at all. Flip `view` to `"off"` and the whole `<GeoJSONSource>`
unmounts — the native layer is destroyed, the map goes clean. This is the entire
"Off / Grades / Zones" toggle (`:316–328`): three mutually-exclusive branches,
each mounting one source. No imperative "addLayer/removeLayer" — React mount/unmount
*is* the layer lifecycle.

**② Data-driven paint.** `lineColor: ["get", "color"]` is a MapLibre expression:
"for each feature, read its `color` property." The color was computed in JS by
`graphToGeoJSON(displayGraph, bandsForUserMax(userMax))` (`:122`) — each edge
colored green/yellow/red by its abs-grade vs the user's threshold. Change
`userMax`, the memo recomputes the FeatureCollection with new colors, `data`
changes identity, the source updates, the GPU repaints. The style never changed —
the *data* did.

**③④ Same idiom, different geometry.** Zones are `fill` polygons, the route is a
thick rounded `line`. All three read `["get", "color"]`. One styling rule, three
layers — the palette logic lives once in the shaping functions, not smeared across
style objects.

**The frozen-id workaround — why `key` matters.** Here's the part everyone trips
on (the comment at `:283–285` calls it out): **MapLibre freezes a source/layer
`id` at mount and can't mutate it in place.** If edges and zones shared a React
identity, switching between them would try to reuse the same native source under a
new `id` — which MapLibre rejects.

```
  Remount-by-key — forcing a fresh native source

  switch view "edges" → "zones"

  WITHOUT distinct keys:           WITH key="src-edges"/"src-zones":
  ┌────────────────────┐           ┌────────────────────┐
  │ React reuses the    │          │ React sees a new key│
  │ same fiber, tries to│          │ → unmount edges     │
  │ swap id in place    │          │ → mount zones fresh │
  │ → MapLibre: frozen! │          │ → MapLibre: clean    │
  └────────────────────┘           └────────────────────┘
```

The fix is the React list-rendering rule you already use: a distinct `key`
(`key="src-edges"` vs `key="src-zones"`, `:287, :292`) tells React "different
identity — unmount the old, mount the new." That guarantees MapLibre gets a clean
mount of a new native source rather than an illegal in-place id swap. The route
source (`:297`) needs no `key` — it's never swapped for a different source, only
its `data` changes, which is exactly the in-place update MapLibre *does* allow.

```
  Layers-and-hops — what crosses the bridge on userMax change

  ┌─ JS (React) ──────────────────────────────────────┐
  │ userMax change → graphToGeoJSON memo → new FC       │
  └───────────────────────┬────────────────────────────┘
                          │ data prop (new identity) crosses bridge
  ┌─ Native (MapLibre) ───▼────────────────────────────┐
  │ same source id, updated data → GPU repaints colors  │
  └─────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Declarative data-driven styling pushes *all* per-feature logic into the data and
keeps the render layer dumb — the GPU paints what the data says. The frontend
lesson that transfers: when a native/GPU object has immutable identity (a frozen
`id`, a canvas context, a `<video>` element), React `key` is your handle on its
lifecycle — same key to update, new key to rebuild. Knowing *which* updates are
legal in-place (data) vs which need a remount (id) is the whole game.

## Primary diagram

```
  Data-driven map layers — full picture (MapScreen.tsx)

  ┌─ client state ──────────────────────────────────────────────┐
  │ view ("off"/"edges"/"zones")   userMax   displayGraph   routed│
  └───────┬───────────────┬───────────────┬───────────────┬──────┘
          │ shaping memos  ▼               ▼               ▼
          │  graphToGeoJSON   computeZones→zonesToGeoJSON  routeToGeoJSON
          │  → heatmap FC     → zonesFC                     → routed.fc
          ▼ (each feature carries a baked-in `color`)
  ┌─ React host components (conditional mount) ─────────────────┐
  │ view==="edges" → <GeoJSONSource key=src-edges id=edges>     │
  │ view==="zones" → <GeoJSONSource key=src-zones id=zones>     │  key forces
  │ routed.fc      → <GeoJSONSource id=route>                   │  remount on swap
  │   each <Layer style={ ...Color: ["get","color"] }>          │
  └───────────────────────────────┬─────────────────────────────┘
                                   ▼ native GPU paints per-feature color
```

## Elaborate

Data-driven styling came from Mapbox GL's expression system — moving styling from
imperative `setPaintProperty` calls to declarative expressions that read feature
properties, so a million features repaint without a million JS calls. flattr uses
the minimal slice: a single `["get", "color"]` per layer, with all the band logic
pre-computed in `features/grade/classify.ts` and `features/map/geojson.ts`. The
remount-by-key issue is the general React-meets-imperative-library seam — the same
reason you `key` a chart component to reset it, or remount a third-party widget
that doesn't expose an update API. Read next: `study-software-design` (the shaping
functions as deep modules hiding the GeoJSON detail), `01-render-thread-astar.md`
(where `routed.fc` is produced), `study-performance-engineering` (cost of shipping
large FeatureCollections across the bridge).

## Interview defense

**Q: "How does the grade heatmap get its colors?"**
Data-driven styling. Each edge's color is computed in JS by `graphToGeoJSON`
(grade vs `userMax`) and baked into the GeoJSON feature's `color` property; the
`<Layer>` paints with `lineColor: ["get", "color"]`, reading that property
per-feature. Change `userMax` and the shaping memo rebuilds the FeatureCollection
with new colors; the style itself never changes.

```
  Graph → graphToGeoJSON (bakes color) → <Layer ["get","color"]> → GPU
```
*Anchor: the color lives in the data, not the style — the style just reads it.*

**Q: "How do you switch between the heatmap and the zones overlay?"**
Conditional mount plus a distinct React `key`. MapLibre freezes a source/layer
`id` at mount and can't swap it in place, so each overlay gets its own
`key="src-edges"`/`key="src-zones"`; React unmounts one and mounts the other,
giving MapLibre a clean new native source instead of an illegal in-place id swap.
The route source needs no key — only its `data` changes, which MapLibre updates in
place fine.

```
  view switch → new key → unmount/mount → fresh native source
  data change → same id → in-place update (legal)
```
*Anchor: the part people miss — `key` is the lifecycle handle for an
immutable-id native object; new key rebuilds, same key updates.*

## See also

- `01-render-thread-astar.md` — produces `routed.fc`, the route layer's data.
- `02-single-flight-pump.md` — produces `displayGraph`, the heatmap/zones source.
- `audit.md` §1, §7.
