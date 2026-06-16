import { describe, it, expect } from "vitest";
import { bidirectional } from "./bidirectional";
import { dijkstra, gradeAstar, directedAstar } from "./astar";
import { distanceCost, gradeCostDirected } from "./cost";
import { diamondGraph, gradeGraph, directionalGraph, makeGridGraph } from "./fixtures";

describe("bidirectional A* (stage 5)", () => {
  it("matches Dijkstra's optimal path on the diamond (distance cost)", () => {
    const g = diamondGraph();
    const b = bidirectional(g, "S", "G", Infinity, distanceCost);
    const d = dijkstra(g, "S", "G");
    expect(b.path!.nodes).toEqual(d.path!.nodes);
    expect(b.path!.cost).toBeCloseTo(d.path!.cost, 6);
  });

  it("matches directional A*'s optimal cost on the grid (directed cost)", () => {
    // Interior pair + userMax=10 (grid30 max grade is 6.25%, so nothing is BLOCKED):
    // a clean grade-aware optimum, not an all-too-steep fallback path.
    const g = makeGridGraph(30);
    const ref = directedAstar(g, "12,12", "17,17", 10);
    const b = bidirectional(g, "12,12", "17,17", 10, gradeCostDirected);
    expect(b.path).not.toBeNull();
    expect(b.path!.cost).toBeCloseTo(ref.path!.cost, 4);
  });

  it("expands far fewer nodes than uninformed Dijkstra (meet-in-the-middle)", () => {
    // Bidirectional A*'s provable win is meeting in the middle vs the uninformed
    // FLOOD -- NOT beating an already-tight unidirectional A* cone (with a strong
    // near-exact heuristic on a Euclidean grid, bidirectional legitimately expands
    // slightly MORE than one-directional A*). Compare against Dijkstra with the SAME
    // cost function on an INTERIOR pair (corner-to-corner is degenerate: the goal is
    // the farthest node, so Dijkstra expands the whole graph and nothing can prune).
    const g = makeGridGraph(30);
    const dj = dijkstra(g, "12,12", "17,17");
    const b = bidirectional(g, "12,12", "17,17", Infinity, distanceCost);
    expect(b.path!.cost).toBeCloseTo(dj.path!.cost, 6); // same optimal cost
    expect(b.nodesExpanded).toBeLessThan(dj.nodesExpanded); // ~43 << ~203
  });

  it("respects direction like the forward engine (flat fixture)", () => {
    const g = gradeGraph();
    const b = bidirectional(g, "S", "G", 5, gradeCostDirected);
    const ref = directedAstar(g, "S", "G", 5);
    expect(b.path!.cost).toBeCloseTo(ref.path!.cost, 6);
  });

  it("returns null when disconnected", () => {
    const g = directionalGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];
    expect(bidirectional(g, "X", "ISO", 5, gradeCostDirected).path).toBeNull();
  });

  it("handles start === goal", () => {
    const g = diamondGraph();
    const b = bidirectional(g, "S", "S", Infinity, distanceCost);
    expect(b.path!.nodes).toEqual(["S"]);
    expect(b.path!.cost).toBe(0);
  });
});
