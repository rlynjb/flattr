// One parametric search engine. The progression stages are just (costFn, heuristicFn) choices.
import type { CostFn, Edge, Graph, HeuristicFn, Node, Path, SearchResult } from "./types";
import { PQueue } from "./pqueue";
import { edgeById, otherEnd, directedGrade } from "./graph";
import { haversine } from "../../lib/geo";
import { distanceCost, gradeCostAbs, gradeCostDirected } from "./cost";

export const zeroHeuristic: HeuristicFn = () => 0;
export const haversineHeuristic: HeuristicFn = (node, goal) => haversine(node, goal);

/**
 * Generic grade-aware search with lazy-deletion + closed set.
 * Returns the optimal path for the given cost/heuristic, plus search metrics.
 */
export function search(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number,
  costFn: CostFn,
  heuristicFn: HeuristicFn
): SearchResult {
  const open = new PQueue<string>();
  const g = new Map<string, number>();
  const came = new Map<string, { edge: Edge; prev: string }>();
  const closed = new Set<string>();
  let pushes = 0;
  let pops = 0;
  let nodesExpanded = 0;

  const goal = graph.nodes[goalId];
  if (!graph.nodes[startId] || !goal) {
    return { path: null, nodesExpanded, pushes, pops };
  }

  g.set(startId, 0);
  open.push(startId, heuristicFn(graph.nodes[startId], goal));
  pushes++;

  while (!open.isEmpty()) {
    const current = open.pop()!;
    pops++;
    if (closed.has(current)) continue; // stale duplicate (lazy deletion)
    if (current === goalId) {
      return {
        path: summarizePath(graph, reconstructNodes(came, startId, goalId), userMax, costFn),
        nodesExpanded,
        pushes,
        pops,
      };
    }
    closed.add(current);
    nodesExpanded++;

    for (const edgeId of graph.adjacency[current] ?? []) {
      const edge = edgeById(graph, edgeId);
      const next = otherEnd(edge, current);
      if (closed.has(next)) continue;
      const tentative = g.get(current)! + costFn(edge, current, userMax);
      if (tentative < (g.get(next) ?? Infinity)) {
        g.set(next, tentative);
        came.set(next, { edge, prev: current });
        open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
        pushes++;
      }
    }
  }
  return { path: null, nodesExpanded, pushes, pops };
}

/** Walk came-from from goal back to start, returning the node id sequence. */
function reconstructNodes(
  came: Map<string, { edge: Edge; prev: string }>,
  startId: string,
  goalId: string
): string[] {
  const nodes: string[] = [goalId];
  let cur = goalId;
  while (cur !== startId) {
    const entry = came.get(cur)!;
    cur = entry.prev;
    nodes.push(cur);
  }
  nodes.reverse();
  return nodes;
}

/**
 * Turn a node sequence into a Path: resolve edges between consecutive nodes,
 * total cost + length, and flag edges whose DIRECTED grade exceeds userMax.
 * Shared by `search` and `bidirectional`.
 */
export function summarizePath(
  graph: Graph,
  nodeSeq: string[],
  userMax: number,
  costFn: CostFn
): Path {
  const edges: string[] = [];
  const steepEdges: string[] = [];
  let cost = 0;
  let lengthM = 0;
  for (let i = 0; i + 1 < nodeSeq.length; i++) {
    const from = nodeSeq[i];
    const to = nodeSeq[i + 1];
    const edge = edgeBetween(graph, from, to);
    edges.push(edge.id);
    cost += costFn(edge, from, userMax);
    lengthM += edge.lengthM;
    if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
      steepEdges.push(edge.id);
    }
  }
  return { nodes: nodeSeq, edges, cost, lengthM, steepEdges };
}

/** The (lowest-cost-by-length) edge connecting two adjacent nodes. */
function edgeBetween(graph: Graph, fromId: string, toId: string): Edge {
  let best: Edge | undefined;
  for (const edgeId of graph.adjacency[fromId] ?? []) {
    const e = edgeById(graph, edgeId);
    if (otherEnd(e, fromId) === toId && (!best || e.lengthM < best.lengthM)) best = e;
  }
  if (!best) throw new Error(`edgeBetween: no edge connects "${fromId}" and "${toId}"`);
  return best;
}

// --- stage wrappers ---------------------------------------------------------

/** Stage 1: Dijkstra — distance cost, no heuristic. */
export function dijkstra(graph: Graph, startId: string, goalId: string): SearchResult {
  return search(graph, startId, goalId, Infinity, distanceCost, zeroHeuristic);
}

/** Stage 2: A* — distance cost, haversine heuristic. */
export function astar(graph: Graph, startId: string, goalId: string): SearchResult {
  return search(graph, startId, goalId, Infinity, distanceCost, haversineHeuristic);
}

/** Stage 3: grade A* — undirected steepness penalty + haversine. */
export function gradeAstar(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number
): SearchResult {
  return search(graph, startId, goalId, userMax, gradeCostAbs, haversineHeuristic);
}

/** Stage 4: directional A* — signed directed-grade penalty + haversine. */
export function directedAstar(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number
): SearchResult {
  return search(graph, startId, goalId, userMax, gradeCostDirected, haversineHeuristic);
}
