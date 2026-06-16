// pipeline/grade.ts — fill lengthM / riseM / gradePct / absGradePct per edge.
import type { Edge, Node } from "../features/routing/types";
import { haversine } from "../lib/geo";

/**
 * Physical clamp on |grade|. A walkable/rollable path steeper than this is a wall —
 * values beyond it are coarse-DEM noise (a short edge straddling an elevation step),
 * not real terrain. Real grades (e.g. Capitol Hill ~30%) stay well under it.
 */
export const MAX_GRADE_PCT = 40;

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
    const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;
    // Clamp out coarse-DEM noise; keep riseM (true elevation delta) for climb totals.
    const gradePct = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, raw));
    return { ...e, lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) };
  });
}
