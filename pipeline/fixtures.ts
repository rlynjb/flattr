// pipeline/fixtures.ts — a hand-built Overpass response + elevation fn for tests.
import type { OverpassResponse } from "./types";

/**
 * A small connected network: a footway 1-2-3 and a residential 3-4, sharing node 3.
 * Coordinates are a few hundred meters apart in Seattle.
 */
export function sampleOverpass(): OverpassResponse {
  return {
    elements: [
      { type: "node", id: 1, lat: 47.600, lon: -122.330 },
      { type: "node", id: 2, lat: 47.601, lon: -122.330 },
      { type: "node", id: 3, lat: 47.602, lon: -122.330 },
      { type: "node", id: 4, lat: 47.602, lon: -122.329 },
      { type: "way", id: 100, nodes: [1, 2, 3], tags: { highway: "footway" } },
      { type: "way", id: 101, nodes: [3, 4], tags: { highway: "residential" } },
      { type: "way", id: 102, nodes: [1, 2], tags: { highway: "motorway" } }, // excluded
    ],
  };
}

/** Deterministic elevation: a north-facing ramp so 1->2->3 climbs. */
export function sampleElevationFn(lat: number, _lng: number): number {
  return Math.round((lat - 47.6) * 100000) / 100; // ~1m per 0.00001 deg lat
}
