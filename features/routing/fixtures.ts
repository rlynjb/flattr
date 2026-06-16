// Hand-built graphs for tests + benchmark.
import type { Edge, Graph, Node } from "./types";
import { buildAdjacency } from "./graph";

function node(id: string, lat: number, lng: number, elevationM: number): Node {
  return { id, lat, lng, elevationM };
}

/** Build an undirected edge between two nodes; derives length/rise/grade from the nodes. */
function edge(id: string, from: Node, to: Node, lengthM: number): Edge {
  const riseM = to.elevationM - from.elevationM;
  const gradePct = (riseM / lengthM) * 100;
  return {
    id,
    fromNode: from.id,
    toNode: to.id,
    geometry: [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ],
    lengthM,
    riseM,
    gradePct,
    absGradePct: Math.abs(gradePct),
  };
}

function assemble(city: string, nodes: Node[], edges: Edge[]): Graph {
  const nodeMap: Record<string, Node> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  const lats = nodes.map((n) => n.lat);
  const lngs = nodes.map((n) => n.lng);
  return {
    city,
    bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    nodes: nodeMap,
    edges,
    adjacency: buildAdjacency(edges),
  };
}

/**
 * 6-node graph with a known shortest path by distance. Flat (all elevation 0).
 * Known: shortest S->G = S,A,G (200).
 */
export function diamondGraph(): Graph {
  const S = node("S", 0, 0, 0);
  const A = node("A", 0.001, 0.001, 0);
  const B = node("B", -0.001, 0.001, 0);
  const G = node("G", 0, 0.002, 0);
  const C = node("C", 0, 0.0015, 0);
  const D = node("D", 0.003, 0.001, 0);
  const nodes = [S, A, B, G, C, D];
  const edges = [
    edge("sa", S, A, 100),
    edge("ag", A, G, 100),
    edge("sb", S, B, 100),
    edge("bg", B, G, 150),
    edge("ac", A, C, 100),
    edge("cb", C, B, 100),
    edge("sd", S, D, 300),
    edge("dg", D, G, 300),
  ];
  return assemble("diamond", nodes, edges);
}

/**
 * Flat-vs-steep choice. Short path via H is steep; long path via L is flat.
 */
export function gradeGraph(): Graph {
  const S = node("S", 0, 0, 0);
  const H = node("H", 0.001, 0.0005, 9);
  const L = node("L", -0.001, 0.001, 0);
  const G = node("G", 0, 0.002, 0);
  const nodes = [S, H, L, G];
  const edges = [
    edge("sh", S, H, 100),
    edge("hg", H, G, 100),
    edge("sl", S, L, 160),
    edge("lg", L, G, 160),
  ];
  return assemble("grade", nodes, edges);
}

/**
 * Directional asymmetry. Direct edge X->Y climbs 8%; flat detour via F.
 */
export function directionalGraph(): Graph {
  const X = node("X", 0, 0, 0);
  const Y = node("Y", 0, 0.001, 8);
  const F = node("F", 0.0008, 0.0005, 0);
  const nodes = [X, Y, F];
  const edges = [
    edge("xy", X, Y, 100),
    edge("xf", X, F, 90),
    edge("fy", F, Y, 90),
  ];
  // Force the detour edges flat regardless of Y's elevation, so only "xy" is steep.
  edges[1] = { ...edges[1], riseM: 0, gradePct: 0, absGradePct: 0 };
  edges[2] = { ...edges[2], riseM: 0, gradePct: 0, absGradePct: 0 };
  return assemble("directional", nodes, edges);
}

/**
 * n*n lattice for the benchmark. Node ids are "row,col". Smooth ramp + ridge so
 * grades vary. Edge length ~80m grid spacing.
 */
export function makeGridGraph(n: number): Graph {
  const spacingM = 80;
  const nodes: Node[] = [];
  const id = (r: number, c: number) => `${r},${c}`;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const elevationM = c * 3 + Math.max(0, 6 - Math.abs(c - (n - 1) / 2)) * 2;
      nodes.push(node(id(r, c), r * 0.00072, c * 0.00072, elevationM));
    }
  }
  const nodeMap: Record<string, Node> = {};
  for (const nd of nodes) nodeMap[nd.id] = nd;
  const edges: Edge[] = [];
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (c + 1 < n) edges.push(edge(`e${k++}`, nodeMap[id(r, c)], nodeMap[id(r, c + 1)], spacingM));
      if (r + 1 < n) edges.push(edge(`e${k++}`, nodeMap[id(r, c)], nodeMap[id(r + 1, c)], spacingM));
    }
  }
  return assemble(`grid${n}`, nodes, edges);
}
