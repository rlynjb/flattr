// pipeline/grade.ts — fill lengthM / riseM / gradePct / absGradePct per edge.
import type { Edge, Node } from "../features/routing/types";
import { haversine } from "../lib/geo";

/** Length along an edge's polyline geometry, in meters. */
function geometryLength(geometry: [number, number][]): number {
  let len = 0;
  for (let i = 0; i + 1 < geometry.length; i++) {
    len += haversine(
      { lat: geometry[i][0], lng: geometry[i][1] },
      { lat: geometry[i + 1][0], lng: geometry[i + 1][1] }
    );
  }
  return len;
}

export function computeGrades(nodes: Record<string, Node>, edges: Edge[]): Edge[] {
  return edges.map((e) => {
    const lengthM = geometryLength(e.geometry);
    const riseM = nodes[e.toNode].elevationM - nodes[e.fromNode].elevationM;
    const gradePct = lengthM > 0 ? (riseM / lengthM) * 100 : 0;
    return { ...e, lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) };
  });
}
