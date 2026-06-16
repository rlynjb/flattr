import type { Edge, Graph } from "./types";

export function edgeById(graph: Graph, edgeId: string): Edge {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) throw new Error(`edgeById: no edge with id "${edgeId}"`);
  return edge;
}

/** The endpoint of `edge` opposite `nodeId`. */
export function otherEnd(edge: Edge, nodeId: string): string {
  if (nodeId === edge.fromNode) return edge.toNode;
  if (nodeId === edge.toNode) return edge.fromNode;
  throw new Error(`otherEnd: "${nodeId}" is not an endpoint of edge "${edge.id}"`);
}

/** Signed grade in the direction of travel: +gradePct forward, -gradePct reverse. */
export function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
}

/** Map each node id to the ids of edges incident to it. */
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);
    (adj[e.toNode] ??= []).push(e.id);
  }
  return adj;
}
