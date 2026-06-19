# Native MapLibre Declarative Layers
### industry names: declarative map rendering + data-driven styling — Industry standard (MapLibre / Mapbox GL component model)

---

## Zoom out, then zoom in

The map isn't a `<canvas>` you draw to, and it isn't DOM. It's a **native
MapLibre view** — a real `UIView`/`android.view` rendering on the GPU — that
you describe *declaratively* in React: a `<Map>` with `<GeoJSONSource>` and
`<Layer>` children. You hand it data and a style spec; it draws. This is the
seam where your React tree becomes native pixels.

```
  Zoom out — the render boundary

  ┌─ JS thread (React, MapScreen.tsx) ───────────────────────────┐
  │  <Map>                                                        │
  │    <Camera ref={cameraRef} center=… />                       │
  │    <GeoJSONSource data={heatmap}> <Layer .../> </GeoJSONSource│
  │    <GeoJSONSource data={routed.fc}> <Layer .../> </…>  ★HERE★ │
  │    <Marker lngLat=… />                                        │
  └────────────────────────────┬──────────────────────────────────┘
                ═══ JS ↔ native bridge (serialized props) ═══
  ┌─ Native thread (MapLibre) ──▼──────────────────────────────────┐
  │  MapView · vector basemap · GeoJSON sources · GPU line/fill    │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: it's the **declarative source/layer model** — you don't issue draw
calls, you declare "here is a named data source, here is a layer that styles
it." You already know this shape from any React rendering: describe the tree,
let the renderer reconcile. The question it answers: *how do I get a
grade-colored street network, a route line, and live markers onto a native map
without imperative draw code — and make a layer toggle work cleanly?*

---

## Structure pass

**Layers** — the rendering stack, top to bottom:

```
  outer:  React elements        (<GeoJSONSource>, <Layer> — JS proxies)
  middle: the bridge            (props serialized JS → native)
  inner:  native MapLibre        (GPU draws GeoJSON per the style spec)
```

**Axis traced — "where does the data live as it crosses to pixels?"** (a
state-location axis):

```
  axis = "what form is the route data in, at each layer?"

  ┌────────────────────────────────────────────────┐
  │ outer: JS object                                 │ → routed.fc (a JS FC)
  │   a GeoJSON FeatureCollection in JS memory       │
  └────────────────────┬─────────────────────────────┘
      ┌────────────────▼─────────────────────────────┐
      │ middle: serialized payload                     │ → JSON over the bridge
      │   the FC is marshalled to the native side      │   (a copy, each change)
      └────────────────┬─────────────────────────────┘
          ┌────────────▼─────────────────────────────┐
          │ inner: native GPU buffers                  │ → vertex/line geometry
          │   MapLibre tessellates + uploads to GPU    │
          └──────────────────────────────────────────┘
```

The data changes form at every layer: a JS object, then a serialized copy
crossing the bridge, then GPU geometry. The seam that matters: **every time
`data` changes, the whole FeatureCollection re-crosses the bridge** — which is
why full-graph GeoJSON rebuilds are a cost (lens 8 red flag #2).

**Seams:**

- **JS ↔ native bridge** (the `<Map>` element): the contract is "I give you
  serializable props (data, style); you render." Control of *drawing* lives
  entirely on the native side; React only describes *what* to draw.
- **source ↔ layer seam**: a `<GeoJSONSource>` holds data under an `id`; a
  `<Layer>` references that source and applies a style. The contract is the
  source id — and MapLibre *freezes* that id, which is why toggling needs a
  React `key` to force remount (the load-bearing detail below).

---

## How it works

### Move 1 — the mental model

You know how React reconciles a list with `key`s — same `key`, React updates in
place; different `key`, React unmounts the old and mounts the new. MapLibre's
source/layer model rides on exactly that, plus one rule: **a source's `id` is
immutable once MapLibre registers it.** So you can't swap a source's identity
by changing a prop; you have to make React *remount* it.

```
  Source/Layer model — the kernel shape

   <GeoJSONSource id="X" data={D}>     ← named data bucket on the native side
       └─ <Layer id="L" type="line"    ← references source by being its child
              style={{ lineColor: ["get","color"] }}/>
                                  ▲ data-driven: read each feature's "color" prop
   change D  → layer redraws (same source id, updated data)
   change id → MUST remount (id is frozen) → use React `key` to force it
```

One sentence: **declare a named data source and a styled layer that reads it;
update by changing `data`, switch sources by changing the React `key`.**

### Move 2 — the step-by-step walkthrough

#### A source is a named data bucket; a layer styles it

You give `<GeoJSONSource>` an `id` and a `data` FeatureCollection. The
`<Layer>` child names a `type` (`line`, `fill`) and a `style`. The source is
*what to draw*; the layer is *how*. They're separate because one source can
back multiple layers (not done here, but that's why the model splits them).

```
  source + layer (the edges heatmap)

  <GeoJSONSource id="edges" data={heatmap}>      ← thousands of street segments
    <Layer id="edge-lines" type="line"
           style={{ lineColor: ["get","color"], lineWidth: 2 }}/>
  </GeoJSONSource>
```

Boundary condition: the `data` prop is a full FeatureCollection held in JS. When
it changes, the entire thing serializes across the bridge again — cheap for a
route (a few segments), real cost for the full edge heatmap as the graph grows.

#### Data-driven styling pushes the color decision into the data

`lineColor: ["get", "color"]` is a MapLibre style *expression*: "for each
feature, read its `color` property." The colors were computed upstream
(`graphToGeoJSON` ran `classifyAbs` → `bandColor` per edge). So you don't write
a per-segment loop in JS issuing colored draws — you attach a `color` to each
feature and let MapLibre fan it out on the GPU.

```
  data-driven styling — the color lives in the feature

  feature.properties.color = "#d23b2e"   (computed in graphToGeoJSON)
        │
        ▼
  Layer style: lineColor = ["get","color"]
        │  MapLibre reads it per-feature
        ▼
  GPU draws that segment red — no JS draw loop
```

Boundary condition: the expression engine runs natively, so 5,000 colored
segments cost one `data` upload, not 5,000 JS calls. Move the classification
into the data; let the renderer apply it.

#### The toggle needs a React `key` because source ids are frozen

This is the part that bites. The map has an `edges`/`zones` toggle. Naively
you'd render one source and swap its `id`. But MapLibre freezes a registered
source id — change the id prop and it won't cleanly re-register. The fix is a
distinct React `key` per branch (`key="src-edges"` vs `key="src-zones"`): React
sees different keys, *unmounts* the edges source and *mounts* the zones source,
so MapLibre registers a fresh source instead of mutating a frozen id.

```
  why the toggle uses `key` (React remount, not prop mutation)

  view==="edges"  → <GeoJSONSource key="src-edges" id="edges" .../>
  view==="zones"  → <GeoJSONSource key="src-zones" id="zones" .../>
        │ React diff sees different keys
        ▼
  unmount edges source ─► mount zones source   (clean native re-register)
        │ (without distinct keys)
        └─► React tries to reuse the node, MapLibre keeps the frozen id → stale/broken
```

Boundary condition: drop the distinct `key`s and the toggle either shows the
wrong layer or fails to switch — because React reconciles them as the same node
and MapLibre never re-registers the source.

#### The camera is the one imperative escape hatch

Everything else is declarative, but moving the viewport is imperative:
`<Camera ref={cameraRef}>` exposes `easeTo({center, zoom, duration})`. You call
it directly from handlers (locate button, route fit, suggestion pick). It also
takes a declarative `center` prop for the initial position. Declarative for
*state* (what data is shown), imperative for *transient actions* (animate the
camera now) — the standard split.

```
  declarative vs imperative on the map

  data (sources/layers/markers) ── declarative ──► reconciled from state
  camera moves (easeTo)         ── imperative  ──► called from handlers via ref
```

#### Markers are plain React views pinned to a coordinate

`<Marker lngLat={[lng,lat]}>` wraps an ordinary RN `<View>` (a colored dot).
MapLibre keeps it positioned at that coordinate as the map moves. Start/end
pins and the live "me" dot are just styled views with a coordinate — no
canvas, no icon sprite sheet.

### Move 3 — the principle

**Declarative rendering means you describe the desired state and let the
renderer diff to it — but the renderer's identity rules leak through.** Sources
and layers are declared, not drawn; colors live in the data, not in draw calls.
The one place the abstraction leaks is identity: because MapLibre freezes
source ids, you reach for React's own identity primitive — `key` — to force a
remount. The general lesson: when you compose React over a stateful native
view, the native view's lifecycle rules (what's mutable, what's frozen) show up
as React reconciliation concerns.

---

## Primary diagram

The full map render — sources, layers, camera, markers, and the bridge.

```
  MapLibre render — full composition (MapScreen.tsx:263-292)

  ┌─ JS thread (React) ───────────────────────────────────────────┐
  │ <Map mapStyle=openfreemap onPress=handleMapPress               │
  │      onRegionDidChange=onRegionDidChange>                      │
  │   <Camera ref=cameraRef center={userLoc??baseCenter}/> ──imperative easeTo
  │                                                                │
  │   view==="edges"                  view==="zones"               │
  │   <GeoJSONSource key=src-edges     <GeoJSONSource key=src-zones │
  │      id=edges data={heatmap}>         id=zones data={zonesFC}>  │
  │     <Layer line lineColor=          <Layer fill fillColor=      │
  │       ["get","color"]/>               ["get","color"]/>        │
  │                                                                │
  │   routed.fc && <GeoJSONSource id=route data={routed.fc}>       │
  │                  <Layer line width=6 lineColor=["get","color"]/>│
  │                                                                │
  │   <Marker start>  <Marker end>  <Marker me>  (RN <View> dots)  │
  │ </Map>                                                         │
  └────────────────────────────┬───────────────────────────────────┘
        ═══ bridge: data FCs + style serialized to native ═══
  ┌─ Native MapLibre ───────────▼───────────────────────────────────┐
  │ basemap tiles  +  GeoJSON sources tessellated  →  GPU draws      │
  │ line/fill per-feature color from ["get","color"]                 │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases in this repo:**

1. **Grade heatmap** — every street colored by steepness band
   (`edges` view), or the grid-cell overview (`zones` view).
2. **Route line** — the computed path drawn thick, colored per-segment by
   directed grade.
3. **Markers** — start (blue), end (black), and the live GPS dot.
4. **Layer toggle** — switching `edges`↔`zones` without leaking a frozen
   source id.

**Code, line by line.**

The map root and toggle — `mobile/src/MapScreen.tsx:263-275`:

```
  Map + edges/zones toggle — MapScreen.tsx:263-275

  <Map style={styles.map} mapStyle={STYLE_URL}      ← native MapLibre view; vector basemap
       onPress={handleMapPress}                      ← tap → set endpoint (when a field is focused)
       onRegionDidChange={onRegionDidChange}>        ← pan settled → maybe load tiles (hook)
    <Camera ref={cameraRef} center={userLoc ?? baseCenter} zoom={userLoc ? 15 : 14}/>
                  ▲ ref = imperative easeTo;  center/zoom = declarative initial pose
    {view === "edges" ? (
      <GeoJSONSource key="src-edges" id="edges" data={heatmap as ...}>  ← distinct key forces remount
        <Layer id="edge-lines" type="line"
               style={{ lineColor: ["get","color"], lineWidth: 2 }}/>    ← per-edge color from data
      </GeoJSONSource>
    ) : (
      <GeoJSONSource key="src-zones" id="zones" data={zonesFC as ...}>   ← the OTHER branch, other key
        <Layer id="zone-fill" type="fill"
               style={{ fillColor: ["get","color"], fillOpacity: 0.5 }}/>
      </GeoJSONSource>
    )}
       │
       └─ the distinct `key` per branch IS the fix: MapLibre freezes source ids,
          so React must unmount one and mount the other, not mutate the id (comment :266-267).
```

The route layer (conditionally mounted) — `mobile/src/MapScreen.tsx:276-284`:

```
  route line — MapScreen.tsx:276-284

  {routed.fc && (                                   ← only render when a path exists
    <GeoJSONSource id="route" data={routed.fc as ...}>
      <Layer id="route-line" type="line"
             style={{ lineColor: ["get","color"], lineWidth: 6, lineCap: "round" }}/>
                          ▲ thicker than heatmap, rounded caps, color per directed-grade band
    </GeoJSONSource>
  )}
```

Markers — `mobile/src/MapScreen.tsx:247-291`:

```
  markers — MapScreen.tsx:247-254 (start/end) + :287-291 (me)

  const marker = (id, color) => {
    const n = graph.nodes[id];                       ← look up the snapped node
    return (
      <Marker key={id} lngLat={[n.lng, n.lat]}>      ← pin a plain RN view at a coordinate
        <View style={[styles.pin, { backgroundColor: color }]} />  ← styled dot, not an icon
      </Marker>);
  };
  ...
  {userLoc && (<Marker id="me" lngLat={userLoc}><View style={styles.meDot}/></Marker>)}
       │
       └─ markers are React Native <View>s positioned by MapLibre; no sprite assets.
```

The camera escape hatch — `mobile/src/MapScreen.tsx:67`, `97`, `112`:

```
  imperative camera — MapScreen.tsx

  const cameraRef = useRef<CameraRef>(null);          (:67)
  ...
  cameraRef.current?.easeTo({ center: c, zoom: 15, duration: 600 });  (:97 locate)
  if (userLoc) cameraRef.current?.easeTo({ center: userLoc, ... });   (:112 recenter)
       │
       └─ the one imperative seam: animating the viewport is an action, not state.
```

The data the layers consume is produced by `graphToGeoJSON`
(`features/map/geojson.ts:19-33`), which flips `[lat,lng]`→`[lng,lat]` (GeoJSON
order) and writes `color: bandColor(classifyAbs(...))` per feature — so the
`["get","color"]` expression has something to read.

---

## Elaborate

The source/layer/expression model is the MapLibre GL (forked from Mapbox GL)
style spec. The design separates *data* (sources) from *appearance* (layers
with style expressions) precisely so appearance can be data-driven and
GPU-evaluated — the same data can drive many layers, and styling decisions
move from imperative JS loops into declarative expressions the renderer
evaluates per-feature, per-frame, natively.

The React Native binding (`@maplibre/maplibre-react-native@^11`,
`package.json:4`) wraps the native SDKs as React components. That wrapping is
where the bridge lives: your declarative tree is reconciled in JS, and prop
changes (especially `data`) are serialized to the native view. This is also
why the `key`-remount detail exists — it's a collision between React's
reconciliation identity and MapLibre's frozen source identity, surfaced through
the binding.

Where it connects: the *cost* of re-serializing a large `data` FC across the
bridge on every `userMax` change is a performance concern →
`.aipe/study-performance-engineering/` *(not yet generated)*. The *thread* the
serialization shares with render is `.aipe/study-runtime-systems/`. The *data*
itself (the graph → GeoJSON shaping, coordinate order) is engine code under
`features/map/`.

What to read next: the MapLibre style spec's "expressions" section — `["get",
…]`, `["interpolate", …]`, `["case", …]` — which is how you'd push *more* of
the grade logic into the layer instead of precomputing colors in JS.

---

## Interview defense

**Q: Why does the edges/zones toggle use a React `key` instead of just
swapping the source's `id` prop?**

Because MapLibre freezes a source's `id` once it's registered on the native
side — you can't rename a live source. So instead of mutating the id, I give
each branch a distinct React `key` (`src-edges` / `src-zones`). React then
unmounts one source and mounts the other, which makes MapLibre register a fresh
source cleanly. It's using React's identity primitive to drive the native
view's lifecycle.

```
  key drives remount, not mutation

  different key → React unmount/mount → MapLibre fresh register
  same key + new id → reuse node → frozen id → broken toggle
```

Anchor: *MapLibre freezes source ids, so I switch sources with a React `key`,
not a prop.*

**Q: How are 5,000 streets colored without a 5,000-iteration draw loop in JS?**

Data-driven styling. Each feature carries a `color` property (computed once in
`graphToGeoJSON`), and the layer style is `lineColor: ["get","color"]` — a
MapLibre expression evaluated natively per feature on the GPU. JS uploads the
data once; the renderer fans out the colors. The expensive part is the single
`data` serialization across the bridge, not per-segment JS.

```
  color in the data, evaluated native

  per-feature color prop ──bridge──► ["get","color"] ──► GPU per-segment draw
```

Anchor: *put the color in the feature; let the layer expression read it
natively.*

**Q: What's declarative here and what's imperative, and why the split?**

Sources, layers, and markers are declarative — they reflect state, React
reconciles them. Camera movement is imperative via `cameraRef.easeTo` — because
"animate to here now" is a transient action triggered by a handler, not a piece
of persistent state. State → declarative; one-shot actions → imperative ref.

Anchor: *data is declarative; camera animation is the one imperative escape
hatch.*

---

## Validate

**Reconstruct.** Draw the source/layer tree from memory: `<Map>` → two toggled
`<GeoJSONSource key=…>` with a styled `<Layer>` child, the conditional route
source, the markers, the camera ref. Name the lines: `MapScreen.tsx:263-292`.

**Explain.** Why is `lineColor` set to `["get","color"]` instead of a fixed
color, and where does that `color` property come from?
(`features/map/geojson.ts:19-33`, `bandColor(classifyAbs(...))` per edge.)

**Apply to a scenario.** You add a third view mode, "elevation contours." What
must you do so the toggle still works — and what specifically breaks if you
give the new source the same React `key` as `edges`? (Give it a distinct `key`;
sharing a key makes React reuse the node and MapLibre keep a frozen id → the
new mode won't render.)

**Defend the decision.** A reviewer says "just keep one source and update its
`data` and `id` on toggle — fewer elements." Explain why the frozen-id rule
makes that fail, and why the two-branch + `key` approach is the correct shape.

---

## See also

- `02-derived-render-time-astar.md` — produces `routed.fc`, the route source's
  data.
- `01-on-demand-tile-graph.md` — produces the `graph` behind `heatmap` and
  `zonesFC`.
- `04-controlled-search-with-debounce.md` — the `onPress`/camera handlers that
  drive endpoint selection.
- `audit.md` lens 1 (rendering boundary), lens 6 (band colors as tokens), lens
  8 red flag #2 (full-graph GeoJSON cost).
- `.aipe/study-performance-engineering/` *(not yet generated)* — bridge
  serialization cost of large `data` props.
- `.aipe/study-runtime-systems/` — the JS↔native thread boundary.
