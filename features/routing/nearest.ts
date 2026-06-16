// features/routing/nearest.ts — snap a tapped coordinate to the nearest graph node.
import type { Graph } from "./types";
import { haversine, type LatLng } from "../../lib/geo";

export function nearestNode(graph: Graph, point: LatLng): string {
  let bestId: string | undefined;
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  if (bestId === undefined) throw new Error("nearestNode: graph has no nodes");
  return bestId;
}
