# flatr Android — Sub-plan 3c: honesty messaging + zone choropleth (design)

> Third and final Android MVP deliverable (spec §10 Phase 3). Adds an honest
> route-summary card and a zone (area) choropleth toggle to the 3a/3b map.
> Date: 2026-06-16.

## Context

3a (heatmap) and 3b (tap-to-route + `userMax` slider) are code-complete on `main`.
3c completes the §10 Phase 3 MVP: narrate the route's steep blocks / no-route state
honestly (§14.4), and add the area choropleth derived from edges (§4 zones, §9
`grade/zones.ts`). Reuses the engine, `classify`, and `geojson` modules; all new
heavy logic is pure and vitest-tested.

## Decisions (from brainstorming)

- **Honesty UI:** a route-summary card with distance, elevation gain, and steep-block
  count, in three states — clean / flattest-but-N-steep / no-route.
- **Zones display:** a toggle between the per-edge heatmap (3a) and the area
  choropleth (one or the other, not both).
- **Zone aggregation:** tile the bbox into a `16×16` grid; each cell's value = 85th
  percentile of the `absGradePct` of edges whose midpoint falls in the cell (§4);
  color via the SAME `userMax`-driven bands as the heatmap (§2 wedge).

## New pure logic (vitest-tested at repo root)

1. **`features/grade/zones.ts`**
   - `percentile(values: number[], p: number): number` — linear-interpolation
     percentile; `p` in `[0,1]`; throws on empty input.
   - `type ZoneCell = { bbox: [number, number, number, number]; value: number }`
     (bbox = `[minLng,minLat,maxLng,maxLat]`, value = p85 absGradePct).
   - `computeZones(graph: Graph, gridN: number): ZoneCell[]` — split `graph.bbox`
     into `gridN×gridN` equal cells; assign each edge to the cell containing its
     geometry midpoint (clamped to the grid); for each non-empty cell, `value =
     percentile(absGradePcts, 0.85)`. Cells with no edges are omitted.
2. **`features/routing/summary.ts`**
   - `type RouteSummary = { distanceM: number; climbM: number; steepCount: number }`.
   - `routeSummary(graph: Graph, path: Path, userMax: number): RouteSummary` —
     `distanceM = path.lengthM`; `climbM` = sum over route edges of the positive part
     of the directed rise (`fromNode===edge.fromNode ? riseM : -riseM`, only when
     `> 0`); `steepCount = path.steepEdges.length`. (`userMax` is accepted for a
     stable signature / future use; steepCount already reflects it via `path`.)
3. **`features/map/geojson.ts`** (extend) — `zonesToGeoJSON(cells, userMax): ZoneFeatureCollection`:
   one **Polygon** feature per cell (a closed `[lng,lat]` rectangle ring from
   `cell.bbox`), `properties.color = bandColor(classifyAbs(cell.value, bandsForUserMax(userMax)))`.
   New `ZoneFeature`/`ZoneFeatureCollection` types (Polygon geometry), separate from
   the existing LineString `EdgeFeature`.

## UI (RN, run-verified)

- **`mobile/src/RouteSummaryCard.tsx`** — props `{ found: boolean; summary: RouteSummary | null; userMax: number }`. Renders:
  - `!found` → "No route between those points." (disconnected, §14.4)
  - `found && steepCount === 0` → "Flat all the way · {km} · +{m} climb"
  - `found && steepCount > 0` → "⚠ Flattest available · {steepCount} steep blocks (>{userMax}%) · {km} · +{m} climb"
  Replaces 3b's bare no-route banner.
- **`mobile/src/MapScreen.tsx`** (extend):
  - Add `view: "edges" | "zones"` state + a small toggle control (two buttons).
  - `zoneCells = useMemo(() => computeZones(graph, 16), [graph])` (geometry, once);
    `zonesFC = useMemo(() => zonesToGeoJSON(zoneCells, userMax), [zoneCells, userMax])`.
  - Restructure the route memo to also expose the `Path` so the card can summarize:
    derive `{ routeFC, summary, found }` from one `directedAstar` call.
  - Render: `view === "edges"` → the edge `LineLayer` (3a); `view === "zones"` →
    a zone `Layer type="fill"` (`fillColor: ['get','color']`, `fillOpacity: 0.5`).
    Route line + markers + `RouteSummaryCard` + `GradeSlider` overlay in both views.

## Data flow

```
graph → computeZones(16) → cells ─(userMax)→ zonesToGeoJSON → fill Layer (view=zones)
directedAstar → Path ─(userMax)→ routeToGeoJSON → route line
                      └────────→ routeSummary  → RouteSummaryCard (3 states)
slider(userMax) re-tints: heatmap + zones + route ; toggle(view) swaps edges↔zones
```

## Error handling

- Empty graph → existing "Failed to load graph" guard (unchanged).
- No route (`path === null`) → card's no-route state; endpoints kept for retry.
- A cell with no edges → omitted from `computeZones` output (no fill drawn there).
- `percentile([], p)` → throws (callers only pass non-empty cell lists).

## Testing

- **Unit (vitest):** `percentile` (p85 of `[1..10]`, exact-index and interpolated
  cases, single value, throws on empty); `computeZones` (edge assigned to correct
  cell by midpoint, p85 value per cell, empty cells omitted, cell bbox spans);
  `zonesToGeoJSON` (Polygon with a closed 5-point `[lng,lat]` ring, color from
  userMax bands); `routeSummary` (distance = lengthM, climb counts only uphill
  directed rise, steepCount = steepEdges length).
- **Run-verified:** toggle switches edges↔zones; slider re-tints zones, heatmap, and
  route together; the card shows clean / flattest-but-steep / no-route correctly.
- **Done when:** on device, the user can flip to a zone choropleth, the card honestly
  reports steep blocks or no-route, and the slider re-tints zones + heatmap + route;
  repo unit tests stay green; `mobile` `tsc` clean.

## Out of scope (→ Plan 4, spec §13)

Saved routes, multi-city, turn-by-turn, accounts/sync, the LLM destination parser.
3c completes the §10 Phase 3 MVP.

## Notes / gotchas

- MapLibre v11 `Layer type="fill"` takes `style?: FillLayerStyle` (`fillColor`,
  `fillOpacity`) — confirmed present in the installed types; zone source is a
  Polygon `GeoJSONSource`.
- Polygon rings must be **closed** (first coordinate repeated as last) and in
  `[lng, lat]` order — `zonesToGeoJSON` builds and unit-tests this.
- `computeZones` returns geometry independent of `userMax`; only `zonesToGeoJSON`
  (color) depends on it, so the slider needn't recompute the grid.
