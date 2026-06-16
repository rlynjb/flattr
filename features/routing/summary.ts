// features/routing/summary.ts — human-facing totals for a resolved route.
import type { Graph, Path } from "./types";
import { edgeById } from "./graph";

export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };

/**
 * distanceM = path length; climbM = sum of positive DIRECTED rise (uphill only, in
 * the travel direction); steepCount = edges flagged over userMax (path.steepEdges).
 */
export function routeSummary(graph: Graph, path: Path, _userMax: number): RouteSummary {
  let climbM = 0;
  for (let i = 0; i < path.edges.length; i++) {
    const edge = edgeById(graph, path.edges[i]);
    const fromNode = path.nodes[i];
    const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
    if (directedRise > 0) climbM += directedRise;
  }
  return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
}
