import { describe, it, expect } from "vitest";
import { dijkstra, astar, gradeAstar, directedAstar } from "./astar";
import { diamondGraph, makeGridGraph, gradeGraph, directionalGraph } from "./fixtures";

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

describe("gradeAstar (stage 3, domain cost)", () => {
  it("prefers the longer flat route over the shorter steep one", () => {
    const g = gradeGraph();
    const plain = astar(g, "S", "G");
    expect(plain.path!.nodes).toEqual(["S", "H", "G"]);
    const flat = gradeAstar(g, "S", "G", 5);
    expect(flat.path!.nodes).toEqual(["S", "L", "G"]);
    expect(flat.path!.lengthM).toBeGreaterThan(plain.path!.lengthM);
  });

  it("is symmetric: S->G and G->S give the same route (abs grade)", () => {
    const g = gradeGraph();
    const fwd = gradeAstar(g, "S", "G", 5);
    const rev = gradeAstar(g, "G", "S", 5);
    expect(rev.path!.nodes).toEqual([...fwd.path!.nodes].reverse());
  });
});

describe("directedAstar (stage 4, directional cost + honesty)", () => {
  it("detours uphill but takes the direct edge downhill (A->B != B->A)", () => {
    const g = directionalGraph();
    const up = directedAstar(g, "X", "Y", 5);
    expect(up.path!.nodes).toEqual(["X", "F", "Y"]);
    const down = directedAstar(g, "Y", "X", 5);
    expect(down.path!.nodes).toEqual(["Y", "X"]);
  });

  it("still returns an only-steep path and flags the steep edge", () => {
    const g = directionalGraph();
    g.edges = g.edges.filter((e) => e.id === "xy");
    g.adjacency = { X: ["xy"], Y: ["xy"], F: [] };
    const r = directedAstar(g, "X", "Y", 5);
    expect(r.path).not.toBeNull();
    expect(r.path!.steepEdges).toEqual(["xy"]);
  });

  it("returns null only when genuinely disconnected, not when merely steep", () => {
    const g = directionalGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];
    expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();
  });
});
