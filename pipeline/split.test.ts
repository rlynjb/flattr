import { describe, it, expect } from "vitest";
import { splitWays } from "./split";
import type { RawWay } from "./types";
import { haversine } from "../lib/geo";
import { buildAdjacency } from "../features/routing/graph";

// ~111m north-south at this latitude per 0.001 deg lat.
const A = { lat: 47.6, lng: -122.33 };
const B = { lat: 47.601, lng: -122.33 }; // ~111m north of A

describe("splitWays", () => {
  it("densifies a long segment so no edge exceeds maxSegM", () => {
    const ways: RawWay[] = [{ id: 1, kind: "footway", coords: [A, B] }];
    const { nodes, edges } = splitWays(ways, 12);
    expect(edges.length).toBeGreaterThan(8); // ~111m / 12m
    for (const e of edges) {
      const [from, to] = e.geometry;
      expect(haversine({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] })).toBeLessThanOrEqual(12.001);
    }
    // endpoints preserved as nodes
    const coords = Object.values(nodes).map((n) => `${n.lat},${n.lng}`);
    expect(coords).toContain(`${A.lat},${A.lng}`);
    expect(coords).toContain(`${B.lat},${B.lng}`);
  });

  it("snaps a shared vertex so two ways connect through ONE node", () => {
    const C = { lat: 47.6, lng: -122.329 }; // east of A, shares A as a corner
    const ways: RawWay[] = [
      { id: 1, kind: "footway", coords: [A, B] },
      { id: 2, kind: "footway", coords: [A, C] }, // shares A
    ];
    const { nodes, edges } = splitWays(ways, 1000); // no densify (segments < 1000m)
    const adj = buildAdjacency(edges);
    // the snapped A node must be incident to one edge from each way (degree 2)
    const aKey = `${A.lat},${A.lng}`;
    const aId = Object.values(nodes).find((n) => `${n.lat},${n.lng}` === aKey)!.id;
    expect(adj[aId].length).toBe(2);
  });

  it("emits Node skeletons with elevationM 0 (filled later) and zeroed grade fields", () => {
    const { nodes, edges } = splitWays([{ id: 1, kind: "footway", coords: [A, B] }], 1000);
    expect(Object.values(nodes).every((n) => n.elevationM === 0)).toBe(true);
    expect(edges.every((e) => e.gradePct === 0 && e.lengthM === 0)).toBe(true);
    expect(edges[0].kind).toBe("footway");
  });
});
