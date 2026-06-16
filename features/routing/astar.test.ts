import { describe, it, expect } from "vitest";
import { dijkstra, astar } from "./astar";
import { diamondGraph, makeGridGraph } from "./fixtures";

describe("dijkstra (stage 1, correctness baseline)", () => {
  it("finds the known shortest path S->G in the diamond graph", () => {
    const r = dijkstra(diamondGraph(), "S", "G");
    expect(r.path).not.toBeNull();
    expect(r.path!.nodes).toEqual(["S", "A", "G"]);
    expect(r.path!.lengthM).toBe(200);
    expect(r.path!.cost).toBe(200);
  });

  it("returns a trivial path when start === goal", () => {
    const r = dijkstra(diamondGraph(), "S", "S");
    expect(r.path!.nodes).toEqual(["S"]);
    expect(r.path!.edges).toEqual([]);
    expect(r.path!.cost).toBe(0);
  });

  it("returns null when goal is unreachable", () => {
    const g = diamondGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];
    const r = dijkstra(g, "S", "ISO");
    expect(r.path).toBeNull();
  });

  it("records metrics (expanded/pushes/pops)", () => {
    const r = dijkstra(diamondGraph(), "S", "G");
    expect(r.nodesExpanded).toBeGreaterThan(0);
    expect(r.pushes).toBeGreaterThan(0);
    expect(r.pops).toBeGreaterThan(0);
  });
});

describe("astar (stage 2, informed search)", () => {
  it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
    const g = makeGridGraph(12);
    const d = dijkstra(g, "0,0", "11,11");
    const a = astar(g, "0,0", "11,11");
    expect(a.path).not.toBeNull();
    expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6);
    expect(a.path!.lengthM).toBeCloseTo(d.path!.lengthM, 6);
  });

  it("expands no more nodes than Dijkstra, usually far fewer", () => {
    const g = makeGridGraph(12);
    const d = dijkstra(g, "0,0", "11,11");
    const a = astar(g, "0,0", "11,11");
    expect(a.nodesExpanded).toBeLessThanOrEqual(d.nodesExpanded);
  });
});
