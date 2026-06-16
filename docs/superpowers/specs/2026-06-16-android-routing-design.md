# flatr Android — Sub-plan 3b: routing UI (design)

> Design spec for the second Android deliverable: pick A→B on the map, run the
> on-device grade-aware router, draw the route colored by directed grade, and a
> `userMax` slider that drives both the route and the heatmap. Builds on 3a.
> Date: 2026-06-16.

## Context

3a (Expo scaffold + grade heatmap) is code-complete on `main`: a native MapLibre map
renders `graph.json` edges colored by `absGradePct` over OpenFreeMap. 3b adds routing.
The hand-rolled engine (`features/routing/*`, esp. `directedAstar`) and the Plan 2
`graph.json` are reused unchanged; routing runs on-device. Implements spec §6 (cost),
§7 (directed-grade coloring + presets), §10 Phase 2, and the §2 wedge ("everything
keys off one number").

## Decisions (from brainstorming)

- **A→B selection:** two taps on the map. Tap 1 → start, tap 2 → end (each snaps to
  the nearest graph node), tap 3 → reset. No geocoder.
- **`userMax` control:** a slider (2–15%) plus four preset chips (§7: Kick 5%,
  Walk 8%, Strict 5%, Any 15%).
- **Slider scope:** changing `userMax` recolors the heatmap AND re-runs/recolors the
  route — the §2 differentiator.

## New pure logic (vitest-tested at repo root)

1. **`features/routing/nearest.ts`** — `nearestNode(graph, { lat, lng }): string`
   (haversine scan over `graph.nodes`; throws on empty graph). Snaps a tap to a
   routable node.
2. **`features/grade/classify.ts`** (extend):
   - `Band` gains `"grey"`. `bandColor("grey")` → e.g. `#9aa0a6`.
   - `classifyDirected(directedGradePct: number, userMax: number): Band` per §7:
     `g <= 0` → green; `0 < g <= 0.5*userMax` → yellow; `0.5*userMax < g <= userMax`
     → red; `g > userMax` → grey.
   - `bandsForUserMax(userMax: number): Bands` → `{ greenMax: 0.5*userMax, yellowMax: userMax }`
     (the heatmap's abs-grade bands, so "where red begins" = the user's number).
   - `USERMAX_PRESETS: { label: string; userMax: number }[]` from §7.
3. **`features/map/geojson.ts`** (extend) — `routeToGeoJSON(graph, path, userMax): EdgeFeatureCollection`:
   one `LineString` per route edge, `color` = `bandColor(classifyDirected(directedGrade(edge, fromNode), userMax))`,
   where `fromNode = path.nodes[i]`. Same `[lat,lng]→[lng,lat]` flip. `classifyAbs`
   stays for the heatmap (callers pass `bandsForUserMax(userMax)`).

## UI (RN, run-verified)

- **`mobile/src/GradeSlider.tsx`** — slider (`@react-native-community/slider`,
  2–15%) + preset chips; calls `onChange(userMax)`. (New native module → one more
  `expo prebuild`.)
- **`mobile/src/MapScreen.tsx`** (extend) — state `{ startId, endId, userMax }`
  (default `userMax` = Walk 8%). `Map` `onPress` → `[lng,lat]` → `nearestNode` →
  set start, then end (3rd tap resets). When both endpoints set, derive
  `route = directedAstar(graph, startId, endId, userMax)`. Layers, top to bottom:
  heatmap (recolored via `graphToGeoJSON(graph, bandsForUserMax(userMax))`), route
  (`routeToGeoJSON(graph, route.path, userMax)`), start/end `Marker`s. Renders
  `GradeSlider` as an overlay.

## Data flow

```
tap -> [lng,lat] -> nearestNode -> startId/endId
userMax (slider/preset) ─┐
startId & endId ─────────┴-> directedAstar(graph, start, end, userMax) -> Path
   route layer:   routeToGeoJSON(graph, Path, userMax)      (directed-grade colors)
   heatmap layer: graphToGeoJSON(graph, bandsForUserMax(userMax))  (abs-grade colors)
```

## Engine-on-device

First RN import of the routing engine (`directedAstar` → PQueue/graph/cost/geo, all
pure, RN-safe). Confirms the Metro `watchFolders` path works for `features/routing/*`.
Routing is <5ms on the bundled graph, so re-routing on every slider change is fine —
no debounce (YAGNI).

## Error handling

- No route found (`path === null`, disconnected) → no route layer + a brief "no route"
  notice; endpoints stay so the user can retry / reset.
- Tap before graph loads → ignored (graph is bundled/synchronous, so not expected).
- Over-`userMax` segments render **grey** (honest coloring); narration is 3c.

## Testing

- **Unit (vitest):** `nearestNode` (closest wins; empty graph throws); `classifyDirected`
  (downhill green even when steep; over-max grey; band boundaries at `0`, `0.5*userMax`,
  `userMax`); `bandsForUserMax`; `USERMAX_PRESETS` values; `routeToGeoJSON` (one feature
  per route edge, directed color incl. a green descent on a steep edge, coord flip).
- **Run-verified:** two taps draw a route gentler than the straight line, colored by
  direction; slider/presets recolor heatmap AND reroute; markers show; grey appears on
  forced-steep routes.
- **Done when:** on device, A→B yields a grade-aware directed-colored route and the
  slider re-tints both map and route; repo unit tests stay green; `mobile` `tsc` clean.

## Out of scope for 3b (→ 3c, parked)

"Flattest available, N steep blocks" messaging, route distance/elevation summary,
zone choropleth, saved routes, turn-by-turn. 3b colors over-max segments grey but does
not narrate them.

## Notes / gotchas

- `@react-native-community/slider` is a native module → must `expo install` it and
  re-run `expo prebuild` before the next device run.
- MapLibre v11 `Map` `onPress` payload (verified against installed types):
  `onPress={(event) => ...}` where `event.nativeEvent.lngLat` is a `[longitude, latitude]`
  tuple. The tap handler destructures `const [lng, lat] = event.nativeEvent.lngLat`
  then calls `nearestNode(graph, { lat, lng })`. Start/end pins use the exported
  `Marker` component.
