# Android Honesty + Zones (Sub-plan 3c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Android MVP — an honest route-summary card (distance, climb, steep-block count; clean / flattest-but-steep / no-route) and a zone (area) choropleth toggle, both keyed off `userMax`.

**Architecture:** New pure, vitest-tested logic — `percentile` + `computeZones` (`features/grade/zones.ts`), `routeSummary` (`features/routing/summary.ts`), and `zonesToGeoJSON` (extend `geojson.ts`). `MapScreen` gains a `view: "edges"|"zones"` toggle, a zone fill layer, and a `RouteSummaryCard`. Reuses the engine, `classify`, `geojson`, and 3a/3b UI.

**Tech Stack:** Expo + React Native + TypeScript, `@maplibre/maplibre-react-native` v11 (`Layer type="fill"` with `FillLayerStyle`). Pure modules tested with Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-16-android-honesty-zones-design.md`. Decisions: `docs/superpowers/plans/ROADMAP.md`. Reuses Plan 1 `features/routing/{astar,graph,types}.ts`; 3a/3b `features/grade/classify.ts`, `features/map/geojson.ts`, `mobile/src/{MapScreen,GradeSlider}.tsx`.

**Verified v11 API facts (used below):** `Layer type="fill"` takes `style={{ fillColor: ["get","color"], fillOpacity: 0.5 }}` (`FillLayerStyle`); zone source is a Polygon `GeoJSONSource`.

---

## File structure

| File | Responsibility | Tested by |
|---|---|---|
| `features/grade/zones.ts` | `percentile` + `computeZones(graph, gridN)` → `ZoneCell[]` (p85 absGrade per cell) | vitest |
| `features/routing/summary.ts` | `routeSummary(graph, path, userMax)` → `{distanceM, climbM, steepCount}` | vitest |
| `features/map/geojson.ts` (extend) | `+zonesToGeoJSON(cells, userMax)` (Polygon features, userMax-colored) | vitest |
| `mobile/src/RouteSummaryCard.tsx` | 3-state honesty card | run-verified |
| `mobile/src/MapScreen.tsx` (extend) | view toggle, zone fill layer, summary card | run-verified |

Build order: pure logic first (Tasks 1–3, fully TDD), then the card (Task 4), then `MapScreen` wiring (Task 5), then device run (Task 6).

---

## Task 1: `features/grade/zones.ts` — percentile + zone aggregation

**Files:**
- Create: `features/grade/zones.ts`
- Test: `features/grade/zones.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// features/grade/zones.test.ts
import { describe, it, expect } from "vitest";
import { percentile, computeZones } from "./zones";
import type { Edge, Graph } from "../routing/types";

describe("percentile", () => {
  it("returns the exact value at an index", () => {
    expect(percentile([10], 0.85)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
  });
  it("interpolates between ranks", () => {
    // p50 of [1,2,3,4] -> rank 1.5 -> 2.5
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
  });
  it("p85 of 1..10 is 8.65", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.85)).toBeCloseTo(8.65, 6);
  });
  it("throws on empty input", () => {
    expect(() => percentile([], 0.85)).toThrow();
  });
});

// Two edges with known midpoints + grades, in a unit-ish bbox.
function edge(id: string, mid: [number, number], absGradePct: number): Edge {
  // a tiny segment centered on `mid` ([lat,lng])
  const [lat, lng] = mid;
  return {
    id,
    fromNode: id + "a",
    toNode: id + "b",
    geometry: [
      [lat - 0.0001, lng - 0.0001],
      [lat + 0.0001, lng + 0.0001],
    ],
    lengthM: 30,
    riseM: 0,
    gradePct: absGradePct,
    absGradePct,
    kind: "footway",
  };
}

function graphWith(edges: Edge[], bbox: [number, number, number, number]): Graph {
  return { city: "t", bbox, nodes: {}, edges, adjacency: {} };
}

describe("computeZones", () => {
  it("assigns edges to grid cells and stores p85 absGrade per cell", () => {
    // bbox [minLng,minLat,maxLng,maxLat] = [0,0,1,1], 2x2 grid -> cells of 0.5.
    // Put two edges in the SW cell (lng<0.5,lat<0.5) with grades 4 and 10.
    const g = graphWith(
      [edge("e1", [0.1, 0.1], 4), edge("e2", [0.2, 0.2], 10)],
      [0, 0, 1, 1]
    );
    const cells = computeZones(g, 2);
    expect(cells.length).toBe(1); // only the SW cell has edges
    const c = cells[0];
    expect(c.bbox).toEqual([0, 0, 0.5, 0.5]);
    expect(c.value).toBeCloseTo(percentile([4, 10], 0.85), 6);
  });

  it("omits cells with no edges", () => {
    const g = graphWith([edge("e1", [0.1, 0.1], 5)], [0, 0, 1, 1]);
    expect(computeZones(g, 4).length).toBe(1); // 16 cells, only 1 populated
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/grade/zones.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `features/grade/zones.ts`**

```ts
// features/grade/zones.ts — roll per-edge grade up into bbox grid cells (spec §4).
import type { Graph } from "../routing/types";

/** Linear-interpolation percentile. `p` in [0,1]. Throws on empty input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export type ZoneCell = { bbox: [number, number, number, number]; value: number };

/**
 * Tile graph.bbox into gridN x gridN equal cells; assign each edge to the cell
 * containing its geometry midpoint; cell.value = p85 of its edges' absGradePct.
 * Empty cells are omitted. cell.bbox is [minLng,minLat,maxLng,maxLat].
 */
export function computeZones(graph: Graph, gridN: number): ZoneCell[] {
  const [minLng, minLat, maxLng, maxLat] = graph.bbox;
  const cellW = (maxLng - minLng) / gridN;
  const cellH = (maxLat - minLat) / gridN;
  const buckets = new Map<string, number[]>(); // "col,row" -> absGradePcts

  const clamp = (v: number) => Math.min(gridN - 1, Math.max(0, v));

  for (const e of graph.edges) {
    // midpoint of the polyline endpoints, in [lat,lng]
    const first = e.geometry[0];
    const last = e.geometry[e.geometry.length - 1];
    const midLat = (first[0] + last[0]) / 2;
    const midLng = (first[1] + last[1]) / 2;
    const col = clamp(Math.floor((midLng - minLng) / cellW));
    const row = clamp(Math.floor((midLat - minLat) / cellH));
    const key = `${col},${row}`;
    const arr = buckets.get(key);
    if (arr) arr.push(e.absGradePct);
    else buckets.set(key, [e.absGradePct]);
  }

  const cells: ZoneCell[] = [];
  for (const [key, grades] of buckets) {
    const [col, row] = key.split(",").map(Number);
    cells.push({
      bbox: [
        minLng + col * cellW,
        minLat + row * cellH,
        minLng + (col + 1) * cellW,
        minLat + (row + 1) * cellH,
      ],
      value: percentile(grades, 0.85),
    });
  }
  return cells;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/grade/zones.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add features/grade/zones.ts features/grade/zones.test.ts
git commit -m "feat: add zone aggregation (p85 abs-grade per grid cell)"
```

---

## Task 2: `features/routing/summary.ts` — route summary

**Files:**
- Create: `features/routing/summary.ts`
- Test: `features/routing/summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// features/routing/summary.test.ts
import { describe, it, expect } from "vitest";
import { routeSummary } from "./summary";
import type { Edge, Graph, Path } from "./types";

function edge(id: string, from: string, to: string, riseM: number): Edge {
  return {
    id,
    fromNode: from,
    toNode: to,
    geometry: [[0, 0], [0, 1]],
    lengthM: 100,
    riseM,
    gradePct: riseM,
    absGradePct: Math.abs(riseM),
    kind: "footway",
  };
}

// A -> B climbs 5, B -> C descends 3 (riseM stored from->to).
const g: Graph = {
  city: "t",
  bbox: [0, 0, 1, 1],
  nodes: {
    A: { id: "A", lat: 0, lng: 0, elevationM: 0 },
    B: { id: "B", lat: 0, lng: 0.001, elevationM: 5 },
    C: { id: "C", lat: 0, lng: 0.002, elevationM: 2 },
  },
  edges: [edge("ab", "A", "B", 5), edge("bc", "B", "C", -3)],
  adjacency: { A: ["ab"], B: ["ab", "bc"], C: ["bc"] },
};

describe("routeSummary", () => {
  it("sums distance, counts only uphill directed climb, and reports steepCount", () => {
    const path: Path = {
      nodes: ["A", "B", "C"],
      edges: ["ab", "bc"],
      cost: 0,
      lengthM: 200,
      steepEdges: ["ab"],
    };
    const s = routeSummary(g, path, 8);
    expect(s.distanceM).toBe(200);
    expect(s.climbM).toBe(5); // +5 on A->B; B->C is downhill (-3), not counted
    expect(s.steepCount).toBe(1);
  });

  it("counts climb in the actual travel direction (reverse descent is free)", () => {
    // Traverse B->A: the 'ab' edge is now a descent, so climb 0.
    const path: Path = { nodes: ["B", "A"], edges: ["ab"], cost: 0, lengthM: 100, steepEdges: [] };
    const s = routeSummary(g, path, 8);
    expect(s.climbM).toBe(0);
    expect(s.steepCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/routing/summary.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `features/routing/summary.ts`**

```ts
// features/routing/summary.ts — human-facing totals for a resolved route.
import type { Graph, Path } from "./types";
import { edgeById } from "./graph";

export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };

/**
 * distanceM = path length; climbM = sum of positive DIRECTED rise (uphill only, in
 * the travel direction); steepCount = edges flagged over userMax (path.steepEdges).
 */
export function routeSummary(graph: Graph, path: Path, _userMax: number): RouteSummary {
  let climbM = 0;
  for (let i = 0; i < path.edges.length; i++) {
    const edge = edgeById(graph, path.edges[i]);
    const fromNode = path.nodes[i];
    const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
    if (directedRise > 0) climbM += directedRise;
  }
  return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/routing/summary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/summary.ts features/routing/summary.test.ts
git commit -m "feat: add route summary (distance, directed climb, steep count)"
```

---

## Task 3: extend `features/map/geojson.ts` — `zonesToGeoJSON`

**Files:**
- Modify: `features/map/geojson.ts`
- Modify: `features/map/geojson.test.ts`

- [ ] **Step 1: Add failing tests** (append to `features/map/geojson.test.ts`)

```ts
import { zonesToGeoJSON } from "./geojson";
import type { ZoneCell } from "../grade/zones";

describe("zonesToGeoJSON", () => {
  const cells: ZoneCell[] = [
    { bbox: [-122.34, 47.6, -122.33, 47.61], value: 2 }, // green at userMax 8 (<=4)
    { bbox: [-122.33, 47.6, -122.32, 47.61], value: 10 }, // red at userMax 8 (>8)
  ];

  it("emits one closed [lng,lat] Polygon ring per cell", () => {
    const fc = zonesToGeoJSON(cells, 8);
    expect(fc.features).toHaveLength(2);
    const ring = fc.features[0].geometry.coordinates[0];
    expect(ring).toHaveLength(5); // closed rectangle
    expect(ring[0]).toEqual(ring[4]); // first == last
    expect(ring[0]).toEqual([-122.34, 47.6]); // [lng,lat]
  });

  it("colors cells by the userMax-driven abs-grade bands", () => {
    const fc = zonesToGeoJSON(cells, 8);
    expect(fc.features[0].properties.color).toBe("#2e9e3f"); // value 2 -> green
    expect(fc.features[1].properties.color).toBe("#d23b2e"); // value 10 -> red (>yellowMax 8)
  });

  it("empty cells -> empty FeatureCollection", () => {
    expect(zonesToGeoJSON([], 8).features).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run features/map/geojson.test.ts`
Expected: FAIL (`zonesToGeoJSON` not exported).

- [ ] **Step 3: Edit `features/map/geojson.ts`**

Add to the imports at the top (extend the existing `classify` import and add `ZoneCell` + `bandsForUserMax`):
```ts
import { classifyAbs, classifyDirected, bandColor, bandsForUserMax, type Bands } from "../grade/classify";
import type { ZoneCell } from "../grade/zones";
```

Append to the end of the file:
```ts
export type ZoneFeature = {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: { color: string; value: number };
};

export type ZoneFeatureCollection = {
  type: "FeatureCollection";
  features: ZoneFeature[];
};

/** Zone cells as colored GeoJSON polygons; color via userMax-driven abs-grade bands. */
export function zonesToGeoJSON(cells: ZoneCell[], userMax: number): ZoneFeatureCollection {
  const bands = bandsForUserMax(userMax);
  const features: ZoneFeature[] = cells.map((c) => {
    const [minLng, minLat, maxLng, maxLat] = c.bbox;
    const ring: [number, number][] = [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat], // closed
    ];
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { color: bandColor(classifyAbs(c.value, bands)), value: c.value },
    };
  });
  return { type: "FeatureCollection", features };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run features/map/geojson.test.ts`
Expected: PASS (all prior + 3 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all repo tests pass.

- [ ] **Step 6: Commit**

```bash
git add features/map/geojson.ts features/map/geojson.test.ts
git commit -m "feat: add zonesToGeoJSON (userMax-colored choropleth polygons)"
```

---

## Task 4: `mobile/src/RouteSummaryCard.tsx` — 3-state honesty card

**Files:**
- Create: `mobile/src/RouteSummaryCard.tsx`

- [ ] **Step 1: Implement — `mobile/src/RouteSummaryCard.tsx`**

```tsx
// mobile/src/RouteSummaryCard.tsx — honest route status (clean / flattest-but-steep / no route).
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { RouteSummary } from "../../features/routing/summary";

export function RouteSummaryCard({
  found,
  summary,
  userMax,
}: {
  found: boolean;
  summary: RouteSummary | null;
  userMax: number;
}): React.JSX.Element | null {
  if (!found || !summary) {
    if (found) return null; // no endpoints yet -> nothing to show
    return (
      <View style={[styles.card, styles.bad]}>
        <Text style={styles.badText}>No route between those points.</Text>
      </View>
    );
  }

  const km = (summary.distanceM / 1000).toFixed(2);
  const climb = Math.round(summary.climbM);
  const clean = summary.steepCount === 0;

  return (
    <View style={[styles.card, clean ? styles.ok : styles.warn]}>
      <Text style={styles.title}>
        {clean ? "Flat all the way" : `⚠ Flattest available`}
      </Text>
      {!clean && (
        <Text style={styles.detail}>
          {summary.steepCount} steep block{summary.steepCount === 1 ? "" : "s"} ({">"}
          {userMax}%)
        </Text>
      )}
      <Text style={styles.detail}>
        {km} km · +{climb} m climb
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", top: 12, left: 12, right: 12, borderRadius: 10, padding: 10 },
  ok: { backgroundColor: "rgba(46,158,63,0.92)" },
  warn: { backgroundColor: "rgba(232,181,0,0.95)" },
  bad: { backgroundColor: "rgba(210,59,46,0.92)" },
  title: { color: "#fff", fontWeight: "700" },
  detail: { color: "#fff" },
  badText: { color: "#fff", textAlign: "center", fontWeight: "600" },
});
```

> The card's only `found`/`summary` decisions mirror the tested `routeSummary` output;
> all numeric logic lives in `routeSummary` (Task 2), so this component stays
> presentational.

- [ ] **Step 2: Typecheck the app**

Run: `cd mobile && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/RouteSummaryCard.tsx
git commit -m "feat: add 3-state route summary card"
```

---

## Task 5: wire zones + card into `mobile/src/MapScreen.tsx`

**Files:**
- Modify: `mobile/src/MapScreen.tsx`

- [ ] **Step 1: Replace `mobile/src/MapScreen.tsx`**

```tsx
// mobile/src/MapScreen.tsx — heatmap/zones toggle + tap-to-route + slider + honesty card.
import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Map, Camera, GeoJSONSource, Layer, Marker } from "@maplibre/maplibre-react-native";
import { graphToGeoJSON, routeToGeoJSON, zonesToGeoJSON, bboxToCameraBounds } from "../../features/map/geojson";
import { bandsForUserMax } from "../../features/grade/classify";
import { computeZones } from "../../features/grade/zones";
import { nearestNode } from "../../features/routing/nearest";
import { directedAstar } from "../../features/routing/astar";
import { routeSummary, type RouteSummary } from "../../features/routing/summary";
import { loadGraph } from "./loadGraph";
import { GradeSlider } from "./GradeSlider";
import { RouteSummaryCard } from "./RouteSummaryCard";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_USERMAX = 8;
const GRID_N = 16;

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
  const [view, setView] = useState<"edges" | "zones">("edges");

  const heatmap = useMemo(
    () => (graph ? graphToGeoJSON(graph, bandsForUserMax(userMax)) : null),
    [graph, userMax]
  );
  const zoneCells = useMemo(() => (graph ? computeZones(graph, GRID_N) : []), [graph]);
  const zonesFC = useMemo(() => zonesToGeoJSON(zoneCells, userMax), [zoneCells, userMax]);

  // One directedAstar call -> route line + summary + found flag.
  const routed = useMemo(() => {
    if (!graph || !startId || !endId) return { fc: null as ReturnType<typeof routeToGeoJSON> | null, summary: null as RouteSummary | null, found: true };
    const r = directedAstar(graph, startId, endId, userMax);
    if (!r.path) return { fc: null, summary: null, found: false };
    return { fc: routeToGeoJSON(graph, r.path, userMax), summary: routeSummary(graph, r.path, userMax), found: true };
  }, [graph, startId, endId, userMax]);

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

  const showCard = startId != null && endId != null;

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={STYLE_URL} onPress={handlePress}>
        <Camera bounds={bboxToCameraBounds(graph.bbox)} />
        {view === "edges" ? (
          <GeoJSONSource id="edges" data={heatmap as unknown as GeoJSON.FeatureCollection}>
            <Layer id="edge-lines" type="line" style={{ lineColor: ["get", "color"], lineWidth: 2 }} />
          </GeoJSONSource>
        ) : (
          <GeoJSONSource id="zones" data={zonesFC as unknown as GeoJSON.FeatureCollection}>
            <Layer id="zone-fill" type="fill" style={{ fillColor: ["get", "color"], fillOpacity: 0.5 }} />
          </GeoJSONSource>
        )}
        {routed.fc && (
          <GeoJSONSource id="route" data={routed.fc as unknown as GeoJSON.FeatureCollection}>
            <Layer id="route-line" type="line" style={{ lineColor: ["get", "color"], lineWidth: 6, lineCap: "round" }} />
          </GeoJSONSource>
        )}
        {startId && marker(startId, "#1565c0")}
        {endId && marker(endId, "#000000")}
      </Map>

      <View style={styles.toggle}>
        {(["edges", "zones"] as const).map((v) => (
          <Pressable key={v} onPress={() => setView(v)} style={[styles.toggleBtn, view === v && styles.toggleOn]}>
            <Text style={[styles.toggleText, view === v && styles.toggleTextOn]}>{v}</Text>
          </Pressable>
        ))}
      </View>

      {showCard && <RouteSummaryCard found={routed.found} summary={routed.summary} userMax={userMax} />}
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
  toggle: { position: "absolute", top: 12, right: 12, flexDirection: "row", borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: "#fff" },
  toggleBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "rgba(255,255,255,0.9)" },
  toggleOn: { backgroundColor: "#1565c0" },
  toggleText: { fontSize: 12, color: "#1565c0" },
  toggleTextOn: { color: "#fff", fontWeight: "700" },
});
```

> Note: the summary card and the view toggle both render near the top; the toggle is
> top-right and the card spans the top with a margin — they don't overlap. If they do
> on a narrow device, move the toggle below the card (adjust `toggle.top`).

- [ ] **Step 2: Typecheck the app**

Run: `cd mobile && npx tsc --noEmit`
Expected: no type errors. (If the `fill`/`line` layer style union complains, the
`style` object already matches the active `type`; ensure each `Layer` keeps its
`type` and matching `style` together as written.)

- [ ] **Step 3: Run the repo unit suite (no regressions)**

Run (from repo root): `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/MapScreen.tsx
git commit -m "feat: edges/zones toggle + honesty summary card"
```

---

## Task 6: re-prebuild (no new native module) and run on Android (verification)

3c adds no native module, so a rebuild of the existing dev client suffices.

- [ ] **Step 1: Run on an emulator/device**

Run: `cd mobile && npx expo run:android`
Expected: app builds, installs, launches. (If the JS bundle alone changed and a dev
build is already installed, `npx expo start` + reload also works.)

- [ ] **Step 2: Verify (the "done when")**

On the device/emulator:
- Default "edges" view shows the heatmap (3a) and routing works (3b).
- Tap the **zones** toggle → the map switches to filled grid cells colored by area
  steepness; tap **edges** → back to per-edge lines. The route line stays visible in both.
- Tap A→B → the **summary card** appears: "Flat all the way · {km} · +{m}" for a gentle
  route, or "⚠ Flattest available · N steep blocks (>{userMax}%) · …" when the route has
  over-max segments. Pick two disconnected points (if any) → "No route between those points."
- Move the slider → heatmap, zones, AND the route all re-tint; the card's steep-block
  count updates.
- Capture a screenshot of the zones view + a steep-route card.

- [ ] **Step 3: Commit any prebuild/config changes (only if tracked files changed)**

```bash
git status --short
git add mobile/app.json 2>/dev/null || true
git commit -m "chore: 3c device build config" || echo "nothing to commit"
```

---

## Done when

- `npm test` (repo root) passes — adds `percentile`/`computeZones`, `routeSummary`, and `zonesToGeoJSON` tests.
- `cd mobile && npx tsc --noEmit` is clean.
- On device: the edges/zones toggle works; the route summary card shows clean / flattest-but-steep / no-route honestly; the slider re-tints heatmap + zones + route together.

This completes the **Android MVP** (spec §10 Phases 1–3). Beyond MVP (per `ROADMAP.md` / spec §13): Plan 4 — vehicle presets refinement, multi-city pipeline, saved routes.

---

## Self-review notes (spec coverage)

- §4 zones (tile bbox, p85 absGrade per cell, derived from edges) → Task 1 (`computeZones`/`percentile`). §9 `grade/zones.ts` → Task 1. Choropleth render → Task 3 (`zonesToGeoJSON` polygons) + Task 5 (`Layer type="fill"`).
- §14.4 honest fallback (steep-flagged vs disconnected) → Task 2 (`routeSummary.steepCount`) + Task 4 card's three states (clean / flattest-but-steep / no-route). §10 Phase 3 messaging → Task 4.
- §2 wedge (one number re-tints everything) → Task 5 `useMemo` on `userMax` for heatmap, `zonesFC`, and `routed` (route + summary). Toggle edges↔zones → Task 5 `view` state.
- v11 `Layer type="fill"` + `FillLayerStyle` (`fillColor`/`fillOpacity`) verified against installed types, used in Task 5. Polygon ring closed + `[lng,lat]` → Task 3 (tested).
- Out of scope (saved routes, multi-city, turn-by-turn) honored — not in any task.
