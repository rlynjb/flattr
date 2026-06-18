// pipeline/build-graph.ts — orchestrate the stages into a Graph.
// No node:fs here so this module bundles for the app (on-device tile building).
import type { Graph } from "../features/routing/types";
import { buildAdjacency } from "../features/routing/graph";
import type { OverpassResponse } from "./types";
import { parseOsm } from "./osm";
import { splitWays } from "./split";
import { sampleElevations, type ElevationProvider } from "./elevation";
import { computeGrades } from "./grade";
import { MAX_SEGMENT_M } from "./config";

export async function buildGraph(
  city: string,
  bbox: [number, number, number, number],
  osm: OverpassResponse,
  elevation: ElevationProvider,
  maxSegM: number = MAX_SEGMENT_M,
  sampleOpts: { dedupePrecision?: number } = {}
): Promise<Graph> {
  const ways = parseOsm(osm);
  const { nodes: skeletonNodes, edges: skeletonEdges } = splitWays(ways, maxSegM);
  const nodes = await sampleElevations(skeletonNodes, elevation, sampleOpts);
  const edges = computeGrades(nodes, skeletonEdges);
  return { city, bbox, nodes, edges, adjacency: buildAdjacency(edges) };
}
