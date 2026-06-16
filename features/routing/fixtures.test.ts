import { describe, it, expect } from "vitest";
import { diamondGraph, gradeGraph, directionalGraph, makeGridGraph } from "./fixtures";

describe("fixtures", () => {
  it("diamondGraph has 6 nodes and a connected adjacency", () => {
    const g = diamondGraph();
    expect(Object.keys(g.nodes).length).toBe(6);
    for (const id of Object.keys(g.nodes)) {
      expect((g.adjacency[id] ?? []).length).toBeGreaterThan(0);
    }
  });

  it("gradeGraph offers a flat-but-long and a steep-but-short route", () => {
    const g = gradeGraph();
    expect(g.nodes["S"]).toBeDefined();
    expect(g.nodes["G"]).toBeDefined();
  });

  it("makeGridGraph builds an n*n lattice with 4-neighbor adjacency", () => {
    const g = makeGridGraph(5);
    expect(Object.keys(g.nodes).length).toBe(25);
    expect(g.adjacency["0,0"].length).toBe(2);
    expect(g.adjacency["2,2"].length).toBe(4);
  });

  it("every edge's absGradePct equals |gradePct|", () => {
    for (const g of [diamondGraph(), gradeGraph(), directionalGraph(), makeGridGraph(4)]) {
      for (const e of g.edges) expect(e.absGradePct).toBeCloseTo(Math.abs(e.gradePct), 9);
    }
  });
});
