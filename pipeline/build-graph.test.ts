import { describe, it, expect } from "vitest";
import { buildGraph } from "./build-graph";
import { fixtureProvider } from "./elevation";
import { sampleOverpass, sampleElevationFn } from "./fixtures";
import { dijkstra } from "../features/routing/astar";
import type { Graph } from "../features/routing/types";

const bbox: [number, number, number, number] = [-122.34, 47.6, -122.31, 47.62];

async function build(): Promise<Graph> {
  return buildGraph("test-city", bbox, sampleOverpass(), fixtureProvider(sampleElevationFn), 1000);
}

describe("buildGraph", () => {
  it("produces a Graph with snapped nodes, graded edges, and adjacency", async () => {
    const g = await build();
    expect(g.city).toBe("test-city");
    expect(Object.keys(g.nodes).length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    // every edge has real length and a defined adjacency entry on both ends
    for (const e of g.edges) {
      expect(e.lengthM).toBeGreaterThan(0);
      expect(g.adjacency[e.fromNode]).toContain(e.id);
      expect(g.adjacency[e.toNode]).toContain(e.id);
    }
  });

  it("output is routable by the Plan 1 engine (the Phase 0 gate)", async () => {
    const g = await build();
    // pick two distinct nodes that should be connected (the network is connected)
    const ids = Object.keys(g.nodes);
    const r = dijkstra(g, ids[0], ids[ids.length - 1]);
    expect(r.path).not.toBeNull();
    expect(r.path!.lengthM).toBeGreaterThan(0);
  });

  it("edges climbing north have positive grade (sanity on a known slope)", async () => {
    const g = await build();
    // find an edge whose toNode is north of its fromNode
    const climbing = g.edges.find((e) => g.nodes[e.toNode].lat > g.nodes[e.fromNode].lat);
    expect(climbing).toBeDefined();
    expect(climbing!.gradePct).toBeGreaterThan(0);
  });
});
