export type Node = {
  id: string;
  lat: number;
  lng: number;
  elevationM: number;
};

export type EdgeKind = "sidewalk" | "footway" | "residential" | "path" | "crossing";

export type Edge = {
  id: string;
  fromNode: string;
  toNode: string;
  geometry: [number, number][]; // [lat, lng] polyline
  lengthM: number;
  riseM: number; // signed, from -> to
  gradePct: number; // signed, from -> to
  absGradePct: number; // |gradePct| — steepness only
  kind?: EdgeKind;
};

export type Graph = {
  city: string;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  nodes: Record<string, Node>;
  edges: Edge[];
  adjacency: Record<string, string[]>; // nodeId -> incident edgeIds
};

/** A resolved route. cost is in routing units; lengthM is real distance. */
export type Path = {
  nodes: string[]; // start..goal, inclusive
  edges: string[]; // edgeIds, length = nodes.length - 1
  cost: number; // total routing cost (sum of costFn over edges)
  lengthM: number; // total real distance
  steepEdges: string[]; // edgeIds whose directed grade exceeds userMax (honesty)
};

/** Cost of traversing `edge` starting at `fromNodeId`, given the user's max grade. */
export type CostFn = (edge: Edge, fromNodeId: string, userMax: number) => number;

/** Admissible estimate of remaining cost from `node` to `goal`. */
export type HeuristicFn = (node: Node, goal: Node) => number;

/** A search result plus the metrics the benchmark records. */
export type SearchResult = {
  path: Path | null;
  nodesExpanded: number; // nodes finalized (added to closed set)
  pushes: number; // total heap pushes
  pops: number; // total heap pops (incl. stale)
};
