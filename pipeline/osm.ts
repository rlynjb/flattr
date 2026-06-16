// pipeline/osm.ts — Overpass response -> walkable ways with resolved coordinates.
import type { OverpassResponse, RawWay } from "./types";
import { WALKABLE } from "./config";

export function parseOsm(res: OverpassResponse): RawWay[] {
  const coordsById = new Map<number, { lat: number; lng: number }>();
  for (const el of res.elements) {
    if (el.type === "node") coordsById.set(el.id, { lat: el.lat, lng: el.lon });
  }

  const ways: RawWay[] = [];
  for (const el of res.elements) {
    if (el.type !== "way") continue;
    const hw = el.tags?.highway;
    if (!hw || !(hw in WALKABLE)) continue;
    const coords: { lat: number; lng: number }[] = [];
    for (const nodeId of el.nodes) {
      const c = coordsById.get(nodeId);
      if (c) coords.push(c);
    }
    if (coords.length < 2) continue; // need a segment
    ways.push({ id: el.id, kind: WALKABLE[hw], coords });
  }
  return ways;
}
