// pipeline/types.ts — Overpass API shapes (subset) + the parsed way form.
import type { EdgeKind } from "../features/routing/types";

export type OverpassNode = { type: "node"; id: number; lat: number; lon: number };
export type OverpassWay = {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};
export type OverpassElement = OverpassNode | OverpassWay;
export type OverpassResponse = { elements: OverpassElement[] };

/** A walkable way resolved to ordered lat/lng coordinates. */
export type RawWay = {
  id: number;
  kind?: EdgeKind;
  coords: { lat: number; lng: number }[];
};
