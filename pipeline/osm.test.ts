import { describe, it, expect } from "vitest";
import { parseOsm } from "./osm";
import type { OverpassResponse } from "./types";

const res: OverpassResponse = {
  elements: [
    { type: "node", id: 1, lat: 47.60, lon: -122.33 },
    { type: "node", id: 2, lat: 47.601, lon: -122.33 },
    { type: "node", id: 3, lat: 47.602, lon: -122.33 },
    // walkable footway 1-2-3
    { type: "way", id: 100, nodes: [1, 2, 3], tags: { highway: "footway" } },
    // excluded motorway
    { type: "way", id: 101, nodes: [1, 2], tags: { highway: "motorway" } },
    // residential (walkable)
    { type: "way", id: 102, nodes: [2, 3], tags: { highway: "residential" } },
    // degenerate: single resolvable node -> dropped
    { type: "way", id: 103, nodes: [1, 999], tags: { highway: "footway" } },
  ],
};

describe("parseOsm", () => {
  it("keeps only walkable ways and resolves their node coords in order", () => {
    const ways = parseOsm(res);
    const ids = ways.map((w) => w.id).sort();
    expect(ids).toEqual([100, 102]); // motorway excluded, degenerate dropped
    const w = ways.find((x) => x.id === 100)!;
    expect(w.kind).toBe("footway");
    expect(w.coords).toEqual([
      { lat: 47.60, lng: -122.33 },
      { lat: 47.601, lng: -122.33 },
      { lat: 47.602, lng: -122.33 },
    ]);
  });

  it("maps residential to its EdgeKind", () => {
    const w = parseOsm(res).find((x) => x.id === 102)!;
    expect(w.kind).toBe("residential");
  });
});
