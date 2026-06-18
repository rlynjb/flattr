// features/map/tiles.ts — fixed-grid tiling + graph merge for pan-to-load coverage.
// Each tile builds an independent graph; ids are prefixed per tile so merged graphs
// don't collide. (Tiles don't share boundary nodes, so routing won't cross seams yet.)
import type { Edge, Graph, Node } from "../routing/types";

export const TILE_W = 0.004; // ~0.3 km of longitude near Seattle (smaller = faster loads)
export const TILE_H = 0.003; // ~0.33 km of latitude

/** Grid key "col,row" for a coordinate. */
export function tileKeyOf(lng: number, lat: number): string {
  return `${Math.floor(lng / TILE_W)},${Math.floor(lat / TILE_H)}`;
}

/** [minLng, minLat, maxLng, maxLat] for a tile key. */
export function tileBbox(key: string): [number, number, number, number] {
  const [col, row] = key.split(",").map(Number);
  return [col * TILE_W, row * TILE_H, (col + 1) * TILE_W, (row + 1) * TILE_H];
}

/** Re-key every node/edge id (and references) with `prefix:` so merges don't collide. */
export function prefixGraph(graph: Graph, prefix: string): Graph {
  const p = (id: string) => `${prefix}:${id}`;
  const nodes: Record<string, Node> = {};
  for (const id of Object.keys(graph.nodes)) {
    nodes[p(id)] = { ...graph.nodes[id], id: p(id) };
  }
  const edges: Edge[] = graph.edges.map((e) => ({
    ...e,
    id: p(e.id),
    fromNode: p(e.fromNode),
    toNode: p(e.toNode),
  }));
  const adjacency: Record<string, string[]> = {};
  for (const id of Object.keys(graph.adjacency)) {
    adjacency[p(id)] = graph.adjacency[id].map(p);
  }
  return { ...graph, nodes, edges, adjacency };
}

/** Combine prefixed graphs into one (display + within-tile routing). Unions bbox. */
export function mergeGraphs(graphs: Graph[]): Graph {
  const nodes: Record<string, Node> = {};
  const adjacency: Record<string, string[]> = {};
  const edges: Edge[] = [];
  let bbox: [number, number, number, number] | null = null;
  for (const g of graphs) {
    Object.assign(nodes, g.nodes);
    Object.assign(adjacency, g.adjacency);
    edges.push(...g.edges);
    bbox = bbox
      ? [
          Math.min(bbox[0], g.bbox[0]),
          Math.min(bbox[1], g.bbox[1]),
          Math.max(bbox[2], g.bbox[2]),
          Math.max(bbox[3], g.bbox[3]),
        ]
      : [...g.bbox];
  }
  return { city: "merged", bbox: bbox ?? [0, 0, 0, 0], nodes, edges, adjacency };
}
