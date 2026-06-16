import { describe, it, expect } from "vitest";
import { edgeById, otherEnd, directedGrade, buildAdjacency } from "./graph";
import type { Edge, Graph } from "./types";

const edge: Edge = {
  id: "e1",
  fromNode: "A",
  toNode: "B",
  geometry: [
    [0, 0],
    [0, 1],
  ],
  lengthM: 100,
  riseM: 8,
  gradePct: 8,
  absGradePct: 8,
};

function graphWith(edges: Edge[]): Graph {
  return {
    city: "test",
    bbox: [0, 0, 1, 1],
    nodes: {},
    edges,
    adjacency: buildAdjacency(edges),
  };
}

describe("graph helpers", () => {
  it("edgeById returns the edge", () => {
    const g = graphWith([edge]);
    expect(edgeById(g, "e1")).toBe(edge);
  });

  it("edgeById throws on a missing id", () => {
    const g = graphWith([edge]);
    expect(() => edgeById(g, "nope")).toThrow(/nope/);
  });

  it("otherEnd returns the opposite node", () => {
    expect(otherEnd(edge, "A")).toBe("B");
    expect(otherEnd(edge, "B")).toBe("A");
  });

  it("otherEnd throws if the node is not an endpoint", () => {
    expect(() => otherEnd(edge, "Z")).toThrow();
  });

  it("directedGrade is +grade forward, -grade reverse", () => {
    expect(directedGrade(edge, "A")).toBe(8);
    expect(directedGrade(edge, "B")).toBe(-8);
  });

  it("buildAdjacency lists every incident edge for both endpoints", () => {
    const e2: Edge = { ...edge, id: "e2", fromNode: "B", toNode: "C" };
    const adj = buildAdjacency([edge, e2]);
    expect(adj["A"]).toEqual(["e1"]);
    expect(adj["B"].sort()).toEqual(["e1", "e2"]);
    expect(adj["C"]).toEqual(["e2"]);
  });
});
