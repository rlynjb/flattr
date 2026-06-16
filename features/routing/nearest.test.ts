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
