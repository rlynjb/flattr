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
    const path: Path = { nodes: ["B", "A"], edges: ["ab"], cost: 0, lengthM: 100, steepEdges: [] };
    const s = routeSummary(g, path, 8);
    expect(s.climbM).toBe(0);
    expect(s.steepCount).toBe(0);
  });
});
