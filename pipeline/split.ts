// pipeline/split.ts — densify long edges + snap coincident vertices to shared node ids.
import type { Edge, Node } from "../features/routing/types";
import type { RawWay } from "./types";
import { haversine } from "../lib/geo";

type LatLng = { lat: number; lng: number };

/** Identical coordinates -> identical key, so shared OSM vertices become one node. */
function snapKey(p: LatLng): string {
  return `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
}

/** Insert points so no sub-segment of the polyline exceeds maxSegM (linear interpolation). */
function densify(coords: LatLng[], maxSegM: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    out.push(a);
    const d = haversine(a, b);
    if (d > maxSegM) {
      const steps = Math.ceil(d / maxSegM);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      }
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/**
 * Turn walkable ways into a snapped, densified node/edge skeleton. Elevation and
 * grade are left at 0 — `sampleElevations` then `computeGrades` fill them.
 */
export function splitWays(
  ways: RawWay[],
  maxSegM: number
): { nodes: Record<string, Node>; edges: Edge[] } {
  const nodes: Record<string, Node> = {};
  const keyToId = new Map<string, string>();
  const edges: Edge[] = [];
  let nodeCounter = 0;
  let edgeCounter = 0;

  function nodeId(p: LatLng): string {
    const key = snapKey(p);
    let id = keyToId.get(key);
    if (id === undefined) {
      id = `n${nodeCounter++}`;
      keyToId.set(key, id);
      nodes[id] = { id, lat: p.lat, lng: p.lng, elevationM: 0 };
    }
    return id;
  }

  for (const way of ways) {
    const dense = densify(way.coords, maxSegM);
    for (let i = 0; i + 1 < dense.length; i++) {
      const a = dense[i];
      const b = dense[i + 1];
      const fromNode = nodeId(a);
      const toNode = nodeId(b);
      if (fromNode === toNode) continue; // coincident after snapping
      edges.push({
        id: `e${edgeCounter++}`,
        fromNode,
        toNode,
        geometry: [
          [a.lat, a.lng],
          [b.lat, b.lng],
        ],
        lengthM: 0,
        riseM: 0,
        gradePct: 0,
        absGradePct: 0,
        kind: way.kind,
      });
    }
  }
  return { nodes, edges };
}
