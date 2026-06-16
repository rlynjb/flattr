# Android Routing UI (Sub-plan 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the 3a Android map, let the user tap A→B to get a grade-aware route (run on-device) drawn and colored by *directed* grade, with a `userMax` slider + presets that re-tints both the heatmap and the route.

**Architecture:** New pure, vitest-tested logic — `nearestNode` (snap a tap to a graph node), `classifyDirected` + `bandsForUserMax` + `USERMAX_PRESETS` (extend `classify.ts`), and `routeToGeoJSON` (extend `geojson.ts`). `MapScreen` gains `{ startId, endId, userMax }` state, a two-tap handler, a route layer, markers, and a `GradeSlider` overlay. Routing uses the existing `directedAstar` imported into the app (first on-device use of the engine).

**Tech Stack:** Expo + React Native + TypeScript, `@maplibre/maplibre-react-native` v11 (`Map`/`Camera`/`GeoJSONSource`/`Layer`/`Marker`), `@react-native-community/slider`. Pure modules tested with Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-16-android-routing-design.md`. Decisions: `docs/superpowers/plans/ROADMAP.md`. Reuses Plan 1 `features/routing/{astar,graph,types}.ts`, `lib/geo.ts`; 3a `features/grade/classify.ts`, `features/map/geojson.ts`, `mobile/`.

**Verified v11 API facts (used below):** `Map` `onPress={(e)=>...}` with `e.nativeEvent.lngLat` = `[lng, lat]` tuple; `Marker` takes `lngLat={[lng,lat]}` (pin as child); `Layer type="line"` with `style={{ lineColor, lineWidth }}`.

---

## File structure

| File | Responsibility | Tested by |
|---|---|---|
| `features/routing/nearest.ts` | `nearestNode(graph, {lat,lng})` → nearest node id | vitest |
| `features/grade/classify.ts` (extend) | `+grey` band/color, `classifyDirected`, `bandsForUserMax`, `USERMAX_PRESETS` | vitest |
| `features/map/geojson.ts` (extend) | `+routeToGeoJSON(graph, path, userMax)` (directed-grade colors) | vitest |
| `mobile/src/GradeSlider.tsx` | slider (2–15%) + preset chips → `onChange(userMax)` | run-verified |
| `mobile/src/MapScreen.tsx` (extend) | tap-to-route state, route layer, markers, slider overlay | run-verified |

Build order: pure logic first (Tasks 1–3, fully TDD), then the slider dep + component (Task 4), then `MapScreen` wiring (Task 5), then device run (Task 6).

---

## Task 1: `features/routing/nearest.ts` — snap a coordinate to a node

**Files:**
- Create: `features/routing/nearest.ts`
- Test: `features/routing/nearest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// features/routing/nearest.test.ts
import { describe, it, expect } from "vitest";
import { nearestNode } from "./nearest";
import type { Graph, Node } from "./types";

function graphWith(nodes: Node[]): Graph {
  const map: Record<string, Node> = {};
  for (const n of nodes) map[n.id] = n;
  return { city: "t", bbox: [0, 0, 1, 1], nodes: map, edges: [], adjacency: {} };
}

const g = graphWith([
  { id: "a", lat: 47.60, lng: -122.33, elevationM: 0 },
  { id: "b", lat: 47.62, lng: -122.31, elevationM: 0 },
]);

describe("nearestNode", () => {
  it("returns the closest node to a coordinate", () => {
    expect(nearestNode(g, { lat: 47.601, lng: -122.329 })).toBe("a");
    expect(nearestNode(g, { lat: 47.619, lng: -122.311 })).toBe("b");
  });

  it("returns the exact node when the coordinate matches one", () => {
    expect(nearestNode(g, { lat: 47.62, lng: -122.31 })).toBe("b");
  });

  it("throws on an empty graph", () => {
    expect(() => nearestNode(graphWith([]), { lat: 0, lng: 0 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/routing/nearest.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `features/routing/nearest.ts`**

```ts
// features/routing/nearest.ts — snap a tapped coordinate to the nearest graph node.
import type { Graph } from "./types";
import { haversine, type LatLng } from "../../lib/geo";

export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/routing/nearest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/nearest.ts features/routing/nearest.test.ts
git commit -m "feat: add nearestNode (snap coordinate to graph node)"
```

---

## Task 2: extend `features/grade/classify.ts` — directed bands + presets

**Files:**
- Modify: `features/grade/classify.ts`
- Modify: `features/grade/classify.test.ts`

- [ ] **Step 1: Add failing tests** (append to `features/grade/classify.test.ts`)

```ts
import { classifyDirected, bandsForUserMax, USERMAX_PRESETS } from "./classify";

describe("classifyDirected (signed directed grade, §7)", () => {
  const max = 8;
  it("downhill or flat is green (free), even when steep downhill", () => {
    expect(classifyDirected(0, max)).toBe("green");
    expect(classifyDirected(-20, max)).toBe("green");
  });
  it("moderate uphill (0 .. 0.5*max) is yellow", () => {
    expect(classifyDirected(0.01, max)).toBe("yellow");
    expect(classifyDirected(4, max)).toBe("yellow"); // 0.5*max boundary
  });
  it("steep uphill (0.5*max .. max) is red", () => {
    expect(classifyDirected(4.01, max)).toBe("red");
    expect(classifyDirected(8, max)).toBe("red"); // max boundary
  });
  it("above max is grey (too steep / blocked)", () => {
    expect(classifyDirected(8.01, max)).toBe("grey");
  });
});

describe("bandsForUserMax", () => {
  it("derives heatmap abs-grade bands from userMax (green<=0.5*max, yellow<=max)", () => {
    expect(bandsForUserMax(8)).toEqual({ greenMax: 4, yellowMax: 8 });
  });
});

describe("USERMAX_PRESETS", () => {
  it("includes the spec §7 presets with their userMax values", () => {
    const byLabel = Object.fromEntries(USERMAX_PRESETS.map((p) => [p.label, p.userMax]));
    expect(byLabel["Kick scooter"]).toBe(5);
    expect(byLabel["Walking"]).toBe(8);
    expect(byLabel["Any"]).toBe(15);
    expect(USERMAX_PRESETS.length).toBeGreaterThanOrEqual(3);
  });
});

describe("grey band color", () => {
  it("has a distinct grey color", () => {
    expect(bandColor("grey")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/grade/classify.test.ts`
Expected: FAIL (`classifyDirected`/`bandsForUserMax`/`USERMAX_PRESETS` not exported; `"grey"` not assignable to `Band`).

- [ ] **Step 3: Edit `features/grade/classify.ts`**

Change the `Band` type to add `"grey"`:
```ts
export type Band = "green" | "yellow" | "red" | "grey";
```

Add `grey` to the `COLORS` map (keep the existing three):
```ts
const COLORS: Record<Band, string> = {
  green: "#2e9e3f",
  yellow: "#e8b500",
  red: "#d23b2e",
  grey: "#9aa0a6",
};
```

Append these exports to the end of the file:
```ts
/**
 * Classify a SIGNED directed grade against userMax (spec §7):
 * downhill/flat -> green (free); 0..0.5*max -> yellow; 0.5*max..max -> red; >max -> grey.
 */
export function classifyDirected(directedGradePct: number, userMax: number): Band {
  if (directedGradePct <= 0) return "green";
  if (directedGradePct > userMax) return "grey";
  if (directedGradePct <= 0.5 * userMax) return "yellow";
  return "red";
}

/** Heatmap abs-grade bands derived from userMax — "where red begins" is the user's number. */
export function bandsForUserMax(userMax: number): Bands {
  return { greenMax: 0.5 * userMax, yellowMax: userMax };
}

/** Preset max-grade choices (spec §7). */
export const USERMAX_PRESETS: { label: string; userMax: number }[] = [
  { label: "Kick scooter", userMax: 5 },
  { label: "Walking", userMax: 8 },
  { label: "Strict", userMax: 5 },
  { label: "Any", userMax: 15 },
];
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/grade/classify.test.ts`
Expected: PASS (original 7 + 4 new describe blocks).

- [ ] **Step 5: Commit**

```bash
git add features/grade/classify.ts features/grade/classify.test.ts
git commit -m "feat: add directed grade bands, userMax heatmap bands, presets"
```

---

## Task 3: extend `features/map/geojson.ts` — `routeToGeoJSON`

**Files:**
- Modify: `features/map/geojson.ts`
- Modify: `features/map/geojson.test.ts`

- [ ] **Step 1: Add failing tests** (append to `features/map/geojson.test.ts`)

```ts
import { routeToGeoJSON } from "./geojson";
import type { Path } from "../routing/types";

// Two-node route on a steep edge; directed color depends on travel direction.
function steepGraph(): Graph {
  const A = { id: "A", lat: 47.6, lng: -122.33, elevationM: 0 };
  const B = { id: "B", lat: 47.601, lng: -122.33, elevationM: 10 };
  const e: Edge = {
    id: "ab",
    fromNode: "A",
    toNode: "B",
    geometry: [[47.6, -122.33], [47.601, -122.33]],
    lengthM: 100,
    riseM: 10,
    gradePct: 10, // +10% A->B (steep climb), -10% B->A (descent)
    absGradePct: 10,
    kind: "footway",
  };
  return {
    city: "t",
    bbox: [-122.34, 47.6, -122.31, 47.62],
    nodes: { A, B },
    edges: [e],
    adjacency: { A: ["ab"], B: ["ab"] },
  };
}

describe("routeToGeoJSON (directed-grade coloring)", () => {
  it("colors a steep CLIMB red (or grey if over max) in the A->B direction", () => {
    const g = steepGraph();
    const path: Path = { nodes: ["A", "B"], edges: ["ab"], cost: 0, lengthM: 100, steepEdges: [] };
    const fc = routeToGeoJSON(g, path, 8); // 10% > 8% userMax -> grey
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.color).toBe("#9aa0a6"); // grey, over max
  });

  it("colors the same edge GREEN in the descending B->A direction (free)", () => {
    const g = steepGraph();
    const path: Path = { nodes: ["B", "A"], edges: ["ab"], cost: 0, lengthM: 100, steepEdges: [] };
    const fc = routeToGeoJSON(g, path, 8);
    expect(fc.features[0].properties.color).toBe("#2e9e3f"); // downhill green
  });

  it("flips coordinates to [lng,lat]", () => {
    const g = steepGraph();
    const path: Path = { nodes: ["A", "B"], edges: ["ab"], cost: 0, lengthM: 100, steepEdges: [] };
    const fc = routeToGeoJSON(g, path, 8);
    expect(fc.features[0].geometry.coordinates).toEqual([[-122.33, 47.6], [-122.33, 47.601]]);
  });

  it("empty path -> empty FeatureCollection", () => {
    const g = steepGraph();
    const path: Path = { nodes: [], edges: [], cost: 0, lengthM: 0, steepEdges: [] };
    expect(routeToGeoJSON(g, path, 8).features).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/map/geojson.test.ts`
Expected: FAIL (`routeToGeoJSON` not exported).

- [ ] **Step 3: Edit `features/map/geojson.ts`**

Update the import line to add `classifyDirected` and `directedGrade`:
```ts
import { classifyAbs, classifyDirected, bandColor, type Bands } from "../grade/classify";
import { directedGrade, edgeById } from "../routing/graph";
```
(Add a `Path` import alongside `Graph`:)
```ts
import type { Graph, Path } from "../routing/types";
```

Append `routeToGeoJSON` to the end of the file:
```ts
/**
 * The edges of a resolved route as GeoJSON, each colored by its DIRECTED grade in
 * the travel direction (spec §7) — a descent is green even on a steep edge.
 * `path.edges[i]` is traversed starting from `path.nodes[i]`.
 */
export function routeToGeoJSON(graph: Graph, path: Path, userMax: number): EdgeFeatureCollection {
  const features: EdgeFeature[] = path.edges.map((edgeId, i) => {
    const edge = edgeById(graph, edgeId);
    const fromNode = path.nodes[i];
    const g = directedGrade(edge, fromNode);
    return {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: edge.geometry.map(([lat, lng]) => [lng, lat] as [number, number]),
      },
      properties: {
        id: edge.id,
        absGradePct: edge.absGradePct,
        color: bandColor(classifyDirected(g, userMax)),
      },
    };
  });
  return { type: "FeatureCollection", features };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/map/geojson.test.ts`
Expected: PASS (5 original + 4 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all repo tests pass.

- [ ] **Step 6: Commit**

```bash
git add features/map/geojson.ts features/map/geojson.test.ts
git commit -m "feat: add routeToGeoJSON (directed-grade route coloring)"
```

---

## Task 4: `mobile/src/GradeSlider.tsx` — slider + presets

**Files:**
- Create: `mobile/src/GradeSlider.tsx`
- Modify: `mobile/package.json` (via expo install)

- [ ] **Step 1: Install the slider dependency**

Run: `cd mobile && npx expo install @react-native-community/slider`
Expected: dependency added to `mobile/package.json`. (Native module → a re-`prebuild` is needed in Task 6.)

- [ ] **Step 2: Implement — `mobile/src/GradeSlider.tsx`**

```tsx
// mobile/src/GradeSlider.tsx — userMax control: a slider (2-15%) plus preset chips.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import Slider from "@react-native-community/slider";
import { USERMAX_PRESETS } from "../../features/grade/classify";

export function GradeSlider({
  userMax,
  onChange,
}: {
  userMax: number;
  onChange: (userMax: number) => void;
}): React.JSX.Element {
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Max grade: {userMax.toFixed(0)}%</Text>
      <Slider
        style={styles.slider}
        minimumValue={2}
        maximumValue={15}
        step={1}
        value={userMax}
        onValueChange={onChange}
        minimumTrackTintColor="#2e9e3f"
        maximumTrackTintColor="#d23b2e"
      />
      <View style={styles.chips}>
        {USERMAX_PRESETS.map((p) => (
          <Pressable key={p.label} style={styles.chip} onPress={() => onChange(p.userMax)}>
            <Text style={styles.chipText}>
              {p.label} {p.userMax}%
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 24,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 12,
    padding: 12,
  },
  label: { fontWeight: "600", marginBottom: 4 },
  slider: { width: "100%", height: 36 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  chip: { backgroundColor: "#eef0f2", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 12 },
});
```

- [ ] **Step 3: Typecheck the app**

Run: `cd mobile && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/GradeSlider.tsx mobile/package.json mobile/package-lock.json
git commit -m "feat: add userMax slider + preset chips"
```

---

## Task 5: wire routing into `mobile/src/MapScreen.tsx`

**Files:**
- Modify: `mobile/src/MapScreen.tsx`

- [ ] **Step 1: Replace `mobile/src/MapScreen.tsx` with the routing version**

```tsx
// mobile/src/MapScreen.tsx — heatmap + tap-to-route + userMax slider (v11 MapLibre).
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Map, Camera, GeoJSONSource, Layer, Marker } from "@maplibre/maplibre-react-native";
import { graphToGeoJSON, routeToGeoJSON, bboxToCameraBounds } from "../../features/map/geojson";
import { bandsForUserMax } from "../../features/grade/classify";
import { nearestNode } from "../../features/routing/nearest";
import { directedAstar } from "../../features/routing/astar";
import { loadGraph } from "./loadGraph";
import { GradeSlider } from "./GradeSlider";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_USERMAX = 8; // Walking preset

export function MapScreen(): React.JSX.Element {
  const graph = useMemo(() => {
    try {
      return loadGraph();
    } catch {
      return null;
    }
  }, []);

  const [userMax, setUserMax] = useState(DEFAULT_USERMAX);
  const [startId, setStartId] = useState<string | null>(null);
  const [endId, setEndId] = useState<string | null>(null);

  // Heatmap recolors with userMax (abs-grade bands).
  const heatmap = useMemo(
    () => (graph ? graphToGeoJSON(graph, bandsForUserMax(userMax)) : null),
    [graph, userMax]
  );

  // Route is derived from endpoints + userMax (directedAstar on-device).
  const route = useMemo(() => {
    if (!graph || !startId || !endId) return null;
    const r = directedAstar(graph, startId, endId, userMax);
    return r.path ? routeToGeoJSON(graph, r.path, userMax) : null;
  }, [graph, startId, endId, userMax]);

  const noRoute = graph != null && startId != null && endId != null && route == null;

  if (!graph || !heatmap) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to load graph.</Text>
      </View>
    );
  }

  const handlePress = (event: { nativeEvent: { lngLat: [number, number] } }) => {
    const [lng, lat] = event.nativeEvent.lngLat;
    const id = nearestNode(graph, { lat, lng });
    if (!startId || (startId && endId)) {
      // first tap, or third tap after a complete pair -> restart
      setStartId(id);
      setEndId(null);
    } else {
      setEndId(id);
    }
  };

  const marker = (id: string, color: string) => {
    const n = graph.nodes[id];
    return (
      <Marker key={id} lngLat={[n.lng, n.lat]}>
        <View style={[styles.pin, { backgroundColor: color }]} />
      </Marker>
    );
  };

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={STYLE_URL} onPress={handlePress}>
        <Camera bounds={bboxToCameraBounds(graph.bbox)} />
        <GeoJSONSource id="edges" data={heatmap as unknown as GeoJSON.FeatureCollection}>
          <Layer id="edge-lines" type="line" style={{ lineColor: ["get", "color"], lineWidth: 2 }} />
        </GeoJSONSource>
        {route && (
          <GeoJSONSource id="route" data={route as unknown as GeoJSON.FeatureCollection}>
            <Layer id="route-line" type="line" style={{ lineColor: ["get", "color"], lineWidth: 6, lineCap: "round" }} />
          </GeoJSONSource>
        )}
        {startId && marker(startId, "#1565c0")}
        {endId && marker(endId, "#000000")}
      </Map>
      {noRoute && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>No route between those points.</Text>
        </View>
      )}
      <GradeSlider userMax={userMax} onChange={setUserMax} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { color: "#d23b2e", textAlign: "center" },
  pin: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: "#fff" },
  banner: { position: "absolute", top: 12, left: 12, right: 12, backgroundColor: "rgba(210,59,46,0.92)", borderRadius: 8, padding: 10 },
  bannerText: { color: "#fff", textAlign: "center" },
});
```

> Version note (v11, verified against installed types AND by typecheck during
> implementation): `onPress` gives `event.nativeEvent.lngLat` as `[lng, lat]`;
> `Marker` takes **`lngLat={[lng,lat]}`** (not `coordinate`) with the pin as a child
> element. The data (route/heatmap) is unchanged.

- [ ] **Step 2: Typecheck the app**

Run: `cd mobile && npx tsc --noEmit`
Expected: no type errors. If `onPress`'s event type complains, type the param as
`any` and destructure `event.nativeEvent.lngLat` (the runtime shape is verified).

- [ ] **Step 3: Run the repo unit suite (no regressions)**

Run (from repo root): `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/MapScreen.tsx
git commit -m "feat: tap-to-route with directed coloring and userMax slider"
```

---

## Task 6: re-prebuild and run on Android (verification)

The new native module (`@react-native-community/slider`) requires regenerating the
native project. Manual verification; no commit unless config files change.

- [ ] **Step 1: Re-generate the native project**

Run: `cd mobile && npx expo prebuild --platform android --no-install`
Expected: `android/` regenerated, no plugin errors.

- [ ] **Step 2: Run on an emulator/device**

Run: `cd mobile && npx expo run:android`
Expected: app builds, installs, launches.

- [ ] **Step 3: Verify (the "done when")**

On the device/emulator:
- Heatmap renders over OpenFreeMap (as in 3a).
- Tap once → a start pin (blue); tap again → an end pin (black) and a thick route
  line appears, colored by direction (green descents, yellow/red climbs, grey if a
  segment exceeds `userMax`). The route bends toward gentler streets vs a straight line.
- Move the slider / tap a preset chip → the heatmap re-tints AND the route re-runs
  and recolors.
- Tap a third time → resets to a new start.
- Capture a screenshot for the record.

- [ ] **Step 4: Commit any config changes from prebuild (if tracked files changed)**

```bash
git add mobile/app.json mobile/package.json 2>/dev/null || true
git commit -m "chore: prebuild config for slider native module" || echo "nothing to commit"
```

---

## Done when

- `npm test` (repo root) passes — adds `nearestNode`, `classifyDirected`/`bandsForUserMax`/`presets`, and `routeToGeoJSON` tests.
- `cd mobile && npx tsc --noEmit` is clean.
- On device: tap A→B draws a directed-colored, grade-aware route; the slider/presets re-tint heatmap + reroute; third tap resets; over-`userMax` segments show grey.

Next sub-plan (per `ROADMAP.md`): **3c — honesty messaging + zone choropleth** (narrate the grey segments: "flattest available, N steep blocks"; add the area choropleth).

---

## Self-review notes (spec coverage)

- Two-tap A→B + nearest-node snap → Task 1 (`nearestNode`) + Task 5 (`handlePress`, third-tap reset). §6 routing → `directedAstar` used in Task 5. §7 directed coloring + presets → Task 2 (`classifyDirected`, `USERMAX_PRESETS`) + Task 3 (`routeToGeoJSON`). §2 wedge (one number → heatmap + route) → Task 5 `useMemo` on `userMax` for both `heatmap` (`bandsForUserMax`) and `route`.
- Slider + preset chips → Task 4 (`GradeSlider`). Engine-on-device (first import of `directedAstar`) → Task 5. Markers → Task 5 (`Marker`). No-route handling → Task 5 `noRoute` banner. Grey over-max segments → `classifyDirected` (Task 2) applied in `routeToGeoJSON` (Task 3).
- Out of scope (honesty narration, zones, summaries) → not implemented; grey is shown but not narrated, deferred to 3c.
- v11 API facts (`onPress`→`nativeEvent.lngLat` `[lng,lat]`, `Marker coordinate`, `Layer type="line"`) verified against installed types and used in Task 5.
