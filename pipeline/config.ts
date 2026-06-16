// pipeline/config.ts — build-time configuration.
import type { EdgeKind } from "../features/routing/types";

/** [minLng, minLat, maxLng, maxLat] — downtown + Capitol Hill, Seattle (placeholder, §10). */
export const BBOX: [number, number, number, number] = [-122.34, 47.6, -122.31, 47.62];

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
