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
  it("returns MapLibre v11 LngLatBounds [west,south,east,north] (= our bbox)", () => {
    expect(bboxToCameraBounds([-122.34, 47.6, -122.31, 47.62])).toEqual([
      -122.34, 47.6, -122.31, 47.62,
    ]);
  });
});

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
  it("colors a steep CLIMB grey when it exceeds userMax (A->B direction)", () => {
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
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[0]).toEqual([-122.34, 47.6]);
  });

  it("colors cells by the userMax-driven abs-grade bands", () => {
    const fc = zonesToGeoJSON(cells, 8);
    expect(fc.features[0].properties.color).toBe("#2e9e3f"); // value 2 -> green
    expect(fc.features[1].properties.color).toBe("#d23b2e"); // value 10 -> red
  });

  it("empty cells -> empty FeatureCollection", () => {
    expect(zonesToGeoJSON([], 8).features).toEqual([]);
  });
});
