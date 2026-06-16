# Android Heatmap (Sub-plan 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Expo (React Native) Android app that renders the `graph.json` edges on a native MapLibre map, colored green/yellow/red by `absGradePct` over an OpenFreeMap basemap.

**Architecture:** Two new **pure, vitest-tested** modules (`features/grade/classify.ts`, `features/map/geojson.ts`) hold all the grade→color and Graph→GeoJSON logic. A new Expo app in `mobile/` imports them plus the existing `features/routing/types.ts` directly (Metro `watchFolders` → repo root; no copy, no port). The RN map component is thin and verified by running the app. A committed sample `graph.json` (generated offline from the Plan 2 pipeline) is bundled as an asset.

**Tech Stack:** Expo + React Native + TypeScript, `@maplibre/maplibre-react-native` (native module → dev build, not Expo Go), OpenFreeMap basemap. Pure modules tested with the repo's existing Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-16-android-heatmap-design.md`. Decisions: `docs/superpowers/plans/ROADMAP.md`.

---

## File structure

| File | Responsibility | Tested by |
|---|---|---|
| `features/grade/classify.ts` | `absGradePct` → band → color hex (fixed bands, injectable) | vitest |
| `features/map/geojson.ts` | `graphToGeoJSON` (flip `[lat,lng]→[lng,lat]`, attach color) + `bboxToCameraBounds` | vitest |
| `mobile/scripts/make-sample-graph.ts` | generate a varied Seattle sample graph offline | run once |
| `mobile/assets/graph.sample.json` | committed bundled sample graph (build artifact) | — |
| `mobile/src/loadGraph.ts` | load the bundled graph asset as a typed `Graph` | thin |
| `mobile/src/MapScreen.tsx` | native MapLibre map: OpenFreeMap + colored edge `LineLayer` | run-verified |
| `mobile/App.tsx` | render `MapScreen`; load-error/empty state | run-verified |
| `mobile/metro.config.js` | `watchFolders` → repo root so `../features`/`../lib` resolve | run-verified |
| `mobile/app.json` | MapLibre config plugin | run-verified |

Build order: pure modules first (Tasks 1–2, fully TDD), then the Expo scaffold (Task 3), the sample asset + loader (Task 4), the map UI (Task 5), and a device run (Task 6).

---

## Task 1: `features/grade/classify.ts` — grade → band → color

**Files:**
- Create: `features/grade/classify.ts`
- Test: `features/grade/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// features/grade/classify.test.ts
import { describe, it, expect } from "vitest";
import { classifyAbs, bandColor, DEFAULT_BANDS, type Band } from "./classify";

describe("classifyAbs (fixed bands, §10 Phase 1)", () => {
  it("green at or below the green ceiling", () => {
    expect(classifyAbs(0)).toBe("green");
    expect(classifyAbs(4)).toBe("green"); // boundary inclusive
  });
  it("yellow between green and yellow ceilings", () => {
    expect(classifyAbs(4.01)).toBe("yellow");
    expect(classifyAbs(8)).toBe("yellow"); // boundary inclusive
  });
  it("red above the yellow ceiling", () => {
    expect(classifyAbs(8.01)).toBe("red");
    expect(classifyAbs(25)).toBe("red");
  });
  it("accepts injected bands (the seam 3b uses for userMax)", () => {
    const bands = { greenMax: 2, yellowMax: 5 };
    expect(classifyAbs(3, bands)).toBe("yellow");
    expect(classifyAbs(6, bands)).toBe("red");
  });
  it("treats negative input as its magnitude (defensive; abs is non-negative)", () => {
    expect(classifyAbs(-10)).toBe("red");
  });
});

describe("bandColor", () => {
  it("maps each band to a distinct hex color", () => {
    const colors = (["green", "yellow", "red"] as Band[]).map(bandColor);
    expect(new Set(colors).size).toBe(3);
    expect(bandColor("green")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
  it("exposes default band thresholds", () => {
    expect(DEFAULT_BANDS.greenMax).toBe(4);
    expect(DEFAULT_BANDS.yellowMax).toBe(8);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/grade/classify.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `features/grade/classify.ts`**

```ts
// features/grade/classify.ts — grade magnitude -> band -> color (spec §7).
// 3a uses fixed thresholds; 3b injects userMax-derived bands through the same seam.
export type Band = "green" | "yellow" | "red";

export type Bands = { greenMax: number; yellowMax: number };

/** Fixed placeholder thresholds (percent), pedestrian-ish (§10 Phase 1). */
export const DEFAULT_BANDS: Bands = { greenMax: 4, yellowMax: 8 };

/** Classify a steepness (abs grade %) into a color band. */
export function classifyAbs(absGradePct: number, bands: Bands = DEFAULT_BANDS): Band {
  const g = Math.abs(absGradePct);
  if (g <= bands.greenMax) return "green";
  if (g <= bands.yellowMax) return "yellow";
  return "red";
}

const COLORS: Record<Band, string> = {
  green: "#2e9e3f",
  yellow: "#e8b500",
  red: "#d23b2e",
};

export function bandColor(band: Band): string {
  return COLORS[band];
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/grade/classify.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add features/grade/classify.ts features/grade/classify.test.ts
git commit -m "feat: add grade band classification and colors"
```

---

## Task 2: `features/map/geojson.ts` — Graph → GeoJSON + camera bounds

**Files:**
- Create: `features/map/geojson.ts`
- Test: `features/map/geojson.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// features/map/geojson.test.ts
import { describe, it, expect } from "vitest";
import { graphToGeoJSON, bboxToCameraBounds } from "./geojson";
import type { Edge, Graph } from "../routing/types";

function edge(id: string, geometry: [number, number][], absGradePct: number): Edge {
  return {
    id,
    fromNode: "a",
    toNode: "b",
    geometry,
    lengthM: 100,
    riseM: 0,
    gradePct: absGradePct,
    absGradePct,
    kind: "footway",
  };
}

function graphWith(edges: Edge[]): Graph {
  return { city: "t", bbox: [-122.34, 47.6, -122.31, 47.62], nodes: {}, edges, adjacency: {} };
}

describe("graphToGeoJSON", () => {
  it("emits one LineString feature per edge", () => {
    const fc = graphToGeoJSON(graphWith([edge("e0", [[47.6, -122.33], [47.601, -122.33]], 2)]));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.type).toBe("LineString");
  });

  it("flips coordinates from [lat,lng] to GeoJSON [lng,lat]", () => {
    const fc = graphToGeoJSON(graphWith([edge("e0", [[47.6, -122.33], [47.601, -122.329]], 2)]));
    expect(fc.features[0].geometry.coordinates).toEqual([
      [-122.33, 47.6],
      [-122.329, 47.601],
    ]);
  });

  it("attaches id, absGradePct, and a color matching classifyAbs", () => {
    const fc = graphToGeoJSON(graphWith([edge("e9", [[47.6, -122.33], [47.601, -122.33]], 10)]));
    const props = fc.features[0].properties;
    expect(props.id).toBe("e9");
    expect(props.absGradePct).toBe(10);
    expect(props.color).toBe("#d23b2e"); // 10% -> red
  });

  it("empty graph -> empty FeatureCollection", () => {
    const fc = graphToGeoJSON(graphWith([]));
    expect(fc.features).toEqual([]);
  });
});

describe("bboxToCameraBounds", () => {
  it("maps [minLng,minLat,maxLng,maxLat] to {ne,sw} in [lng,lat]", () => {
    expect(bboxToCameraBounds([-122.34, 47.6, -122.31, 47.62])).toEqual({
      ne: [-122.31, 47.62],
      sw: [-122.34, 47.6],
    });
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/map/geojson.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `features/map/geojson.ts`**

```ts
// features/map/geojson.ts — Graph -> GeoJSON for the MapLibre heatmap layer.
// Edge.geometry is [lat,lng]; GeoJSON requires [lng,lat] — we flip here (and test it).
import type { Graph } from "../routing/types";
import { classifyAbs, bandColor, type Bands } from "../grade/classify";

export type EdgeFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { id: string; absGradePct: number; color: string };
};

export type EdgeFeatureCollection = {
  type: "FeatureCollection";
  features: EdgeFeature[];
};

/** Convert graph edges to a colored GeoJSON FeatureCollection (color via classifyAbs). */
export function graphToGeoJSON(graph: Graph, bands?: Bands): EdgeFeatureCollection {
  const features: EdgeFeature[] = graph.edges.map((e) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: e.geometry.map(([lat, lng]) => [lng, lat] as [number, number]),
    },
    properties: {
      id: e.id,
      absGradePct: e.absGradePct,
      color: bandColor(classifyAbs(e.absGradePct, bands)),
    },
  }));
  return { type: "FeatureCollection", features };
}

export type CameraBounds = { ne: [number, number]; sw: [number, number] };

/** [minLng,minLat,maxLng,maxLat] -> MapLibre camera bounds ({ne,sw} in [lng,lat]). */
export function bboxToCameraBounds(bbox: [number, number, number, number]): CameraBounds {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/map/geojson.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite (no regressions in Plans 1–2)**

Run: `npm test`
Expected: all prior tests + these still pass.

- [ ] **Step 6: Commit**

```bash
git add features/map/geojson.ts features/map/geojson.test.ts
git commit -m "feat: add Graph->GeoJSON converter and camera bounds"
```

---

## Task 3: Scaffold the Expo app in `mobile/`

No unit tests (scaffold). Verified by typecheck + Metro starting. Run all commands
from the repo root unless told otherwise.

- [ ] **Step 1: Create the Expo app (TypeScript, blank) in `mobile/`**

Run:
```bash
npx create-expo-app@latest mobile --template blank-typescript
```
Expected: `mobile/` created with its own `package.json`, `App.tsx`, `tsconfig.json`, `app.json`.

- [ ] **Step 2: Install MapLibre React Native into the app**

Run:
```bash
npm --prefix mobile install @maplibre/maplibre-react-native
```
Expected: dependency added to `mobile/package.json`. (This is a native module; Step 5 / Task 6 build a dev client — it will NOT run in Expo Go.)

- [ ] **Step 3: Configure Metro to import the engine from the repo root**

Create `mobile/metro.config.js`:
```js
// Lets the app import ../features/* and ../lib/* (the shared TS engine) at the repo root.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];
module.exports = config;
```

- [ ] **Step 4: Register the MapLibre config plugin**

In `mobile/app.json`, add the plugin to `expo.plugins` (create the array if absent):
```json
{
  "expo": {
    "plugins": ["@maplibre/maplibre-react-native"]
  }
}
```
(Keep the existing `expo` keys create-expo-app generated; just add `plugins`.)

- [ ] **Step 5: Verify the app typechecks and Metro resolves**

Run:
```bash
npm --prefix mobile run -s tsc -- --noEmit 2>/dev/null || npx --prefix mobile tsc --noEmit
```
If the app has no `tsc` script, run `cd mobile && npx tsc --noEmit` instead.
Expected: no type errors (only the default `App.tsx` exists so far).

- [ ] **Step 6: Commit**

```bash
git add mobile/ -- ':!mobile/node_modules'
git commit -m "chore: scaffold Expo app with MapLibre and root engine imports"
```
(Ensure `mobile/node_modules/` is git-ignored — create-expo-app writes a `mobile/.gitignore` that ignores it; if not, add `mobile/node_modules/` to the root `.gitignore`.)

---

## Task 4: Generate + bundle the sample graph; load it

**Files:**
- Create: `mobile/scripts/make-sample-graph.ts`
- Create (generated, committed): `mobile/assets/graph.sample.json`
- Create: `mobile/src/loadGraph.ts`

- [ ] **Step 1: Write the sample-graph generator — `mobile/scripts/make-sample-graph.ts`**

```ts
// mobile/scripts/make-sample-graph.ts — build a varied Seattle sample graph OFFLINE
// (synthetic street grid + a hill) so 3a renders all three color bands without network.
// Run from repo root:  npx tsx mobile/scripts/make-sample-graph.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { buildGraph } from "../../pipeline/build-graph";
import { fixtureProvider } from "../../pipeline/elevation";
import { BBOX } from "../../pipeline/config";
import type { OverpassElement, OverpassResponse } from "../../pipeline/types";

const [minLng, minLat, maxLng, maxLat] = BBOX;
const N = 9; // 9x9 intersections across the bbox

const elements: OverpassElement[] = [];
const nodeId = (r: number, c: number) => 1 + r * N + c;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    elements.push({
      type: "node",
      id: nodeId(r, c),
      lat: minLat + (maxLat - minLat) * (r / (N - 1)),
      lon: minLng + (maxLng - minLng) * (c / (N - 1)),
    });
  }
}
let wayId = 10000;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    if (c + 1 < N) elements.push({ type: "way", id: wayId++, nodes: [nodeId(r, c), nodeId(r, c + 1)], tags: { highway: "residential" } });
    if (r + 1 < N) elements.push({ type: "way", id: wayId++, nodes: [nodeId(r, c), nodeId(r + 1, c)], tags: { highway: "residential" } });
  }
}
const osm: OverpassResponse = { elements };

// Hill rising toward the NE plus sinusoidal ripples -> grades that span green/yellow/red.
const elevation = fixtureProvider((lat, lng) => {
  const nx = (lng - minLng) / (maxLng - minLng);
  const ny = (lat - minLat) / (maxLat - minLat);
  return 120 * (0.6 * nx + 0.4 * ny) + 25 * Math.sin(nx * 6) * Math.cos(ny * 6);
});

const graph = await buildGraph("seattle-sample", BBOX, osm, elevation, 30);
mkdirSync("mobile/assets", { recursive: true });
writeFileSync("mobile/assets/graph.sample.json", JSON.stringify(graph));

const bands = { green: 0, yellow: 0, red: 0 };
for (const e of graph.edges) {
  const g = e.absGradePct;
  if (g <= 4) bands.green++;
  else if (g <= 8) bands.yellow++;
  else bands.red++;
}
console.log(`wrote mobile/assets/graph.sample.json: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges`);
console.log(`band distribution: ${JSON.stringify(bands)}`);
```

- [ ] **Step 2: Generate the asset**

Run: `npx tsx mobile/scripts/make-sample-graph.ts`
Expected: prints node/edge counts and a band distribution with **non-zero green, yellow, AND red** counts (proves the heatmap will show all three). `mobile/assets/graph.sample.json` now exists.

- [ ] **Step 3: Write the loader — `mobile/src/loadGraph.ts`**

```ts
// mobile/src/loadGraph.ts — load the bundled sample graph as a typed Graph.
import type { Graph } from "../../features/routing/types";
import sample from "../assets/graph.sample.json";

export function loadGraph(): Graph {
  return sample as unknown as Graph;
}
```

- [ ] **Step 4: Verify the asset parses and is non-trivial (quick node check)**

Run:
```bash
node -e "const g=require('./mobile/assets/graph.sample.json'); if(!g.edges.length||!g.bbox) throw new Error('bad graph'); console.log('edges',g.edges.length)"
```
Expected: prints an edge count > 100, no error.

- [ ] **Step 5: Commit (the generated asset is committed; it is NOT under data/)**

```bash
git add mobile/scripts/make-sample-graph.ts mobile/assets/graph.sample.json mobile/src/loadGraph.ts
git commit -m "feat: generate and bundle a varied sample graph for the heatmap"
```

---

## Task 5: Map UI — `MapScreen` + `App`

These are RN components: no unit test (rendering). All data/logic they use is
already tested (Tasks 1–2). Verified by running the app (Task 6).

- [ ] **Step 1: Write the map screen — `mobile/src/MapScreen.tsx`**

```tsx
// mobile/src/MapScreen.tsx — native MapLibre map: OpenFreeMap basemap + colored edges.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { MapView, Camera, ShapeSource, LineLayer } from "@maplibre/maplibre-react-native";
import { graphToGeoJSON, bboxToCameraBounds } from "../../features/map/geojson";
import { loadGraph } from "./loadGraph";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export function MapScreen(): React.JSX.Element {
  let graph;
  try {
    graph = loadGraph();
  } catch (err) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to load graph: {String(err)}</Text>
      </View>
    );
  }

  const geojson = graphToGeoJSON(graph);
  const bounds = bboxToCameraBounds(graph.bbox);

  return (
    <MapView style={styles.map} mapStyle={STYLE_URL}>
      <Camera
        defaultSettings={{ bounds: { ...bounds, paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24 } }}
      />
      {geojson.features.length > 0 && (
        <ShapeSource id="edges" shape={geojson}>
          <LineLayer
            id="edge-lines"
            style={{ lineColor: ["get", "color"], lineWidth: 3, lineCap: "round" }}
          />
        </ShapeSource>
      )}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { color: "#d23b2e", textAlign: "center" },
});
```

> Version note: this targets `@maplibre/maplibre-react-native` v10 (prop `mapStyle`,
> named exports `MapView`/`Camera`/`ShapeSource`/`LineLayer`). If the installed
> version differs: the style prop may be `styleURL`; `Camera` bounds may be passed as
> `bounds={bounds}` directly instead of under `defaultSettings`. Adjust to the
> installed API — the data (`geojson`, `bounds`) is unchanged.

- [ ] **Step 2: Wire it into `mobile/App.tsx`**

Replace the generated `mobile/App.tsx` with:
```tsx
import React from "react";
import { SafeAreaView, StatusBar, StyleSheet } from "react-native";
import { MapScreen } from "./src/MapScreen";

export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <MapScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
```

- [ ] **Step 3: Typecheck the app**

Run: `cd mobile && npx tsc --noEmit`
Expected: no type errors. (Imports of `../../features/...` resolve as relative TS files.)
If TS complains it cannot find the JSON module, ensure `mobile/tsconfig.json` has
`"resolveJsonModule": true` (Expo's base config sets it; add it under
`compilerOptions` if missing) and re-run.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/MapScreen.tsx mobile/App.tsx mobile/tsconfig.json
git commit -m "feat: render grade-colored edges on a MapLibre map"
```

---

## Task 6: Build a dev client and run on Android (verification)

The native module requires a dev build (not Expo Go). This task is manual
verification; it has no commit unless prebuild changes tracked files.

- [ ] **Step 1: Generate the native project**

Run: `cd mobile && npx expo prebuild --platform android`
Expected: an `android/` directory is generated under `mobile/`.

- [ ] **Step 2: Run on an emulator or connected device**

Ensure an Android emulator is running (or a device is attached with USB debugging), then:
Run: `cd mobile && npx expo run:android`
Expected: the app builds, installs, and launches.

- [ ] **Step 3: Verify the heatmap (the "done when")**

Confirm on the device/emulator:
- The OpenFreeMap basemap renders, framed to the Seattle bbox.
- Edge lines are drawn over it, colored a mix of **green, yellow, and red**.
- No crash; if the graph failed to load you'd see the red error text instead.

Capture a screenshot for the record if possible.

- [ ] **Step 4: Decide on `mobile/android/`**

`expo prebuild` output (`mobile/android/`) is regenerable. Prefer to gitignore it
(managed workflow): ensure `mobile/.gitignore` includes `/android` and `/ios`
(create-expo-app's template usually does). Only commit `mobile/android/` if you
deliberately switch to the bare workflow. If a config change to `mobile/app.json`
was needed to make it run, commit that:
```bash
git add mobile/app.json mobile/.gitignore
git commit -m "chore: dev-build config for Android run"
```

---

## Done when

- `npm test` (repo root) passes — Plans 1–2 plus `classify` and `geojson` tests.
- `cd mobile && npx tsc --noEmit` is clean.
- `npx tsx mobile/scripts/make-sample-graph.ts` reports non-zero green/yellow/red.
- The Expo dev build runs on Android and shows green/yellow/red edges over the
  OpenFreeMap basemap, framed to the bbox.

Next sub-plan (per `ROADMAP.md`): **3b — routing UI** (tap A→B, run the on-device
engine, draw the route colored by directed grade, `userMax` slider that drives the
same `Bands` seam used here).

---

## Self-review notes (spec coverage)

- Platform/Expo + `mobile/` + Metro watchFolders → Task 3. Reuse engine by import (no port) → `loadGraph`/`MapScreen` import `../../features/*` (Tasks 4–5).
- `classify.ts` (band + color, injectable bands) → Task 1. `graphToGeoJSON` + coord flip + per-edge color → Task 2 (the flip is explicitly tested — the spec's called-out gotcha). `bboxToCameraBounds` → Task 2.
- OpenFreeMap basemap + `LineLayer` colored by `['get','color']` → Task 5. Bundled sample graph (offline, committed under `mobile/assets/`) → Task 4. Fixed bands now, `userMax` seam later → `Bands` param threaded through Tasks 1–2.
- Native-module dev build (not Expo Go) → Task 6. Error/empty states → `MapScreen` try/catch + `features.length > 0` guard.
- Out of scope (routing, slider, honesty, zones, runtime download) honored — none appear in tasks.
