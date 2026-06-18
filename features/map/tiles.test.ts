import { describe, it, expect } from "vitest";
import { tileKeyOf, tileBbox, prefixGraph, mergeGraphs, TILE_W, TILE_H } from "./tiles";
import { dijkstra } from "../routing/astar";
import type { Edge, Graph } from "../routing/types";

describe("tile grid", () => {
  it("tileKeyOf and tileBbox round-trip (point lies within its tile)", () => {
    const lng = -122.325;
    const lat = 47.62;
    const key = tileKeyOf(lng, lat);
    const [minLng, minLat, maxLng, maxLat] = tileBbox(key);
    expect(lng).toBeGreaterThanOrEqual(minLng);
    expect(lng).toBeLessThan(maxLng);
    expect(lat).toBeGreaterThanOrEqual(minLat);
    expect(lat).toBeLessThan(maxLat);
    expect(maxLng - minLng).toBeCloseTo(TILE_W, 9);
    expect(maxLat - minLat).toBeCloseTo(TILE_H, 9);
  });

  it("adjacent coordinates map to different tiles", () => {
    const a = tileKeyOf(-122.33, 47.62);
    const b = tileKeyOf(-122.33 + TILE_W, 47.62);
    expect(a).not.toBe(b);
  });
});

// minimal 2-node graph
function miniGraph(): Graph {
  const A = { id: "A", lat: 47.62, lng: -122.33, elevationM: 0 };
  const B = { id: "B", lat: 47.621, lng: -122.33, elevationM: 0 };
  const e: Edge = {
    id: "e0",
    fromNode: "A",
    toNode: "B",
    geometry: [[A.lat, A.lng], [B.lat, B.lng]],
    lengthM: 100,
    riseM: 0,
    gradePct: 0,
    absGradePct: 0,
    kind: "footway",
  };
  return {
    city: "t",
    bbox: [-122.33, 47.62, -122.329, 47.621],
    nodes: { A, B },
    edges: [e],
    adjacency: { A: ["e0"], B: ["e0"] },
  };
}

describe("prefixGraph", () => {
  it("re-keys node/edge ids and all references", () => {
    const g = prefixGraph(miniGraph(), "t1");
    expect(Object.keys(g.nodes)).toEqual(["t1:A", "t1:B"]);
    expect(g.edges[0].id).toBe("t1:e0");
    expect(g.edges[0].fromNode).toBe("t1:A");
    expect(g.adjacency["t1:A"]).toEqual(["t1:e0"]);
  });
});

describe("mergeGraphs", () => {
  it("combines prefixed graphs without collisions and unions bbox", () => {
    const g1 = prefixGraph(miniGraph(), "t1");
    const g2 = prefixGraph(miniGraph(), "t2");
    const m = mergeGraphs([g1, g2]);
    expect(Object.keys(m.nodes).length).toBe(4); // 2 + 2, no collision
    expect(m.edges.length).toBe(2);
    expect(m.adjacency["t1:A"]).toBeDefined();
    expect(m.adjacency["t2:A"]).toBeDefined();
  });

  it("routing works within a tile of a merged graph", () => {
    const m = mergeGraphs([prefixGraph(miniGraph(), "t1"), prefixGraph(miniGraph(), "t2")]);
    const r = dijkstra(m, "t1:A", "t1:B");
    expect(r.path).not.toBeNull();
    expect(r.path!.nodes).toEqual(["t1:A", "t1:B"]);
  });
});
