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
