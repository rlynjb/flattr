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
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
  });
  it("p85 of 1..10 is 8.65", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.85)).toBeCloseTo(8.65, 6);
  });
  it("throws on empty input", () => {
    expect(() => percentile([], 0.85)).toThrow();
  });
});

function edge(id: string, mid: [number, number], absGradePct: number): Edge {
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
