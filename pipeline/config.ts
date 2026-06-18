// pipeline/config.ts — build-time configuration.
import type { EdgeKind } from "../features/routing/types";

/**
 * [minLng, minLat, maxLng, maxLat] — a small Capitol Hill slice, Seattle (steep area
 * near the spec's Pine St reference). Kept small so the free Open-Meteo build stays
 * under rate limits and the bundled graph.json stays phone-friendly. Widen later
 * (and use a Google/LIDAR key) for the full city.
 */
export const BBOX: [number, number, number, number] = [-122.3284, 47.6181, -122.3214, 47.6241];

/** Split long edges so no segment exceeds this (§11.C: 10-15m in hilly areas). */
export const MAX_SEGMENT_M = 12;

/** OSM `highway` values treated as walkable/rollable, mapped to our EdgeKind. */
export const WALKABLE: Record<string, EdgeKind> = {
  footway: "footway",
  sidewalk: "sidewalk",
  pedestrian: "footway",
  path: "path",
  steps: "path",
  living_street: "residential",
  residential: "residential",
  service: "residential",
};
