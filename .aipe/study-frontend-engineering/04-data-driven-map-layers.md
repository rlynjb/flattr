# Data-driven map layers — GeoJSON sources styled by feature properties

**Industry name(s):** declarative data-driven styling / GeoJSON source-layer model (MapLibre/Mapbox GL).
**Type:** Industry-standard (the MapLibre model), with one project-specific quirk (frozen-id
remount-by-key).

## Zoom out, then zoom in

The map isn't drawn imperatively — you don't loop over edges calling `drawLine(color)`. You hand MapLibre
a GeoJSON `FeatureCollection` where each feature carries a `color` property, and a `Layer` whose style says
"paint each feature using its own `color`." React reconciles the *declaration*; the native renderer does
the drawing. It's the same declarative-over-imperative move as JSX itself, applied to a map.

```
  Zoom out — the rendering seam for map graphics

  ┌─ UI (MapScreen render) ───────────────────────────────────────┐
  │  heatmap/zonesFC/routed.fc  (GeoJSON, color baked per feature) │
  │            │                                                   │
  │            ▼  declarative props                                │
  │  <GeoJSONSource data={fc}> <Layer style={lineColor:[get,color]}│ ← here
  └────────────┬──────────────────────────────────────────────────┘
               │ React reconciles → native bridge
  ┌─ MapLibre native renderer ▼───────────────────────────────────┐
  │  GPU draws each feature using its property-driven color        │
  └────────────────────────────────────────────────────────────────┘
```

The thing you control is *data shaped a certain way*; the rendering is the renderer's job. That inversion
is what this file is about.

## Structure pass

**Layers:** (1) graph/route → GeoJSON with baked properties, (2) declarative `<GeoJSONSource>`/`<Layer>`,
(3) native GPU render.

**Axis traced — "who decides the color of a line?"**

```
  axis = "who decides the pixel color?"

  ┌─ data builder ──────────┐   CODE decides — classify grade → hex,
  │  graphToGeoJSON         │   bakes `color` into each feature
  └───────────┬──────────────┘
              │ seam: GeoJSON property `color`
  ┌─ Layer style ─▼──────────┐   DECLARATION decides — "use the
  │  lineColor:["get","color"]│   feature's own color" (a data expression)
  └───────────┬──────────────┘
              │ seam: React ↔ native bridge
  ┌─ GPU ─────▼──────────────┐   RENDERER decides nothing about color —
  │  paints what it's told    │   just executes the expression per feature
  └───────────────────────────┘
```

**The seam is the `["get","color"]` style expression** (`MapScreen.tsx:288,293,301`). It's the contract:
the data layer promises every feature has a `color` property; the style layer promises to read it. Neither
side knows the other's internals — you could swap the classifier or the renderer independently.

## How it works

### Move 1 — the mental model

It's `array.map(item => <Row color={item.color} />)` but for map geometry. You precompute the visual
property into each datum, then declare a view that reads that property. The renderer is the `.map`'s JSX —
it just renders what each item says.

```
  data-driven styling shape

   graph edges ──► graphToGeoJSON ──► features[{geometry, color}]
                   (classify grade                  │
                    → hex)                          ▼
                                    <Layer lineColor=["get","color"]>
                                          │
                                          ▼  per-feature
                                    GPU paints each line its own color
```

The strategy: **bake the visual decision into the data, declare a view that reads it.** The color logic
lives in one place (the classifier), the rendering lives in another (the layer), connected only by a
property name.

### Move 2 — the walkthrough

**Building the data.** `graphToGeoJSON` maps each edge to a feature, classifying its grade into a band and
baking the band's hex into `properties.color` (`features/map/geojson.ts:20-34`):

```ts
properties: {
  id: e.id,
  absGradePct: e.absGradePct,
  color: bandColor(classifyAbs(e.absGradePct, bands)),   // ← visual decision baked into the datum
},
```

The route does the same but with *directed* grade so a descent is green even on a steep edge
(`geojson.ts:51-69`) — the coloring logic differs, the data-driven mechanism is identical. Three feature
collections, three callers: `heatmap` (edges), `zonesFC` (polygons), `routed.fc` (the route line)
(`MapScreen.tsx:121-129, 151-162`).

**Declaring the view.** Each source/layer pair reads the baked property (`MapScreen.tsx:286-304`):

```tsx
{view === "edges" && heatmap && (
  <GeoJSONSource key="src-edges" id="edges" data={heatmap}>
    <Layer id="edge-lines" type="line"
           style={{ lineColor: ["get", "color"], lineWidth: 2 }} />  {/* ← read per-feature color */}
  </GeoJSONSource>
)}
```

`["get","color"]` is a MapLibre *data expression* — evaluated per feature against its properties. You
never set a color in JS imperatively; you declare "color = this feature's `color` field" and the renderer
does the rest. The route line is the same with `lineWidth:6, lineCap:"round"` (`:296-303`).

**The frozen-id quirk — remount by key.** Here's the project-specific gotcha. MapLibre freezes a source's
`id` once mounted — you can't mutate it in place. So the edges/zones layers carry a distinct React `key`
per branch (`key="src-edges"`, `key="src-zones"`, `:287,292`):

```
  why the key matters — frozen native id

  without distinct key:                with distinct key:
  ──────────────────────               ───────────────────
  React tries to reuse the same        toggling view unmounts the old
  GeoJSONSource node when view         source (key changes) and mounts
  flips edges↔zones → native id        a fresh one → clean native
  is frozen → stale/broken layer       source with the right id
```

The comment in the code says it directly (`MapScreen.tsx:284-285`): "Distinct React `key` per branch since
MapLibre freezes source/layer `id` and can't mutate it in place." This is React reconciliation meeting a
native-side constraint — `key` forces a remount instead of an in-place update.

```
  State diagram — the view toggle and its layers

  ┌─ "off" ──┐   no source mounted (clean map)
  └────┬─────┘
   tap │ Grades
  ┌────▼─────┐   <GeoJSONSource key="src-edges"> mounts
  │ "edges"  │   heatmap memo computes (displayGraph + userMax)
  └────┬─────┘
   tap │ Zones
  ┌────▼─────┐   key flips → edges unmounts, zones mounts fresh
  │ "zones"  │   zonesFC memo computes
  └──────────┘
```

**On-demand computation.** The heatmap/zones GeoJSON is only built when its view is active — the memos
guard on `view === "edges"` / `view === "zones"` (`MapScreen.tsx:121-128`). Off means no source mounted and
no GeoJSON computed: clean map, zero work. The route source has no such guard — it mounts whenever
`routed.fc` is non-null (`:296`).

### Move 3 — the principle

Push visual decisions into the data and let a declarative layer read them, so the "what color" logic and
the "how to draw" logic stay independent and each lives in exactly one place. The cost is that changing a
color means rebuilding the data (every `userMax` change re-maps every edge — see `audit.md` red flag #2);
the benefit is that the classifier and the renderer never need to know about each other.

## Primary diagram

```
  Data-driven map layers — full picture

  ┌─ data builders (features/map/geojson.ts) ─────────────────────┐
  │  graphToGeoJSON   zonesToGeoJSON   routeToGeoJSON             │
  │  classifyAbs ──► bandColor ──► properties.color (baked)       │
  └────────┬──────────────┬──────────────────┬────────────────────┘
           │ heatmap       │ zonesFC          │ routed.fc
           ▼               ▼                  ▼
  ┌─ declarative layers (MapScreen render) ───────────────────────┐
  │  <GeoJSONSource key=src-edges>  <key=src-zones>  <id=route>   │
  │     <Layer lineColor=[get,color]> ... fillColor ... lineColor │
  │     ▲ key forces remount (frozen native id)                   │
  └────────────────────────┬──────────────────────────────────────┘
                           │ React ↔ native bridge
  ┌─ MapLibre native renderer ▼───────────────────────────────────┐
  │  GPU paints each feature its property-driven color            │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The GeoJSON source/layer model with data expressions (`["get", ...]`) is Mapbox GL's design, inherited by
MapLibre — it's the same declarative-styling philosophy as CSS (`color: var(--x)`) or D3's data-join, where
you bind data to marks and let the renderer reconcile. The frozen-id constraint is RN-binding-specific:
the JS `id` maps to a native object that can't be renamed, so React's `key` (the universal "this is a
different element, remount it" lever) is the tool. You've used `key` to force list-item remounts — same
mechanism, different motivation.

If the heatmap rebuild cost mattered (it's O(edges) per `userMax` change), the move would be to *not* bake
color into the data and instead push `absGradePct` plus the band thresholds into the style expression as a
`step`/`interpolate` expression — then changing `userMax` updates only the style, not the whole
FeatureCollection. That's a real MapLibre capability the repo doesn't use yet. Read next:
`01-render-time-astar.md` (produces `routed.fc`), `study-performance-engineering` (the rebuild cost).

## Interview defense

**Q: How do you color thousands of map lines by grade without looping in JS?**

I don't loop at draw time. I bake a `color` property into each GeoJSON feature when I build the
FeatureCollection — classify the grade, map it to a hex — then the `<Layer>` style is `lineColor:
["get","color"]`, a data expression the native renderer evaluates per feature. The visual logic lives in
the classifier, the rendering in the layer, connected by one property name. To re-color on a setting
change I rebuild the data; the alternative — pushing the threshold into the style expression so only the
style updates — is the optimization I'd reach for if the rebuild cost showed up.

**Q: Why do the layers have explicit React `key`s?**

Because MapLibre freezes a source's native `id` once mounted — you can't mutate it. When the view toggles
edges↔zones, I want a fresh source, not an in-place update of a frozen one. A distinct `key` per branch is
the React lever that forces an unmount + remount instead of reconciliation. It's the same `key`-forces-
remount trick you'd use on a list item, here solving a native-binding constraint.

```
  the part people forget: key = remount, not just list-diff hint

  frozen native id + reused node → broken layer
  frozen native id + new key     → clean remount  ✓
```

**Anchor:** "Color is baked into each GeoJSON feature and read by a `["get","color"]` style expression —
declarative data-driven styling — and the layers carry distinct `key`s to force a remount because MapLibre
freezes the native source id."

## See also

- `01-render-time-astar.md` — produces `routed.fc` consumed here
- `03-single-flight-tile-pump.md` — produces the `displayGraph` the heatmap maps
- `study-performance-engineering` — the O(edges) rebuild cost per setting change
- `study-system-design` — the GeoJSON shaping layer in `features/map/`
