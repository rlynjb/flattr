// One parametric search engine. The progression stages are just (costFn, heuristicFn) choices.
import type { CostFn, Edge, Graph, HeuristicFn, Path, SearchResult } from "./types";
import { PQueue } from "./pqueue";
import { otherEnd, directedGrade } from "./graph";
import { haversine } from "../../lib/geo";
import { distanceCost, gradeCostAbs, gradeCostDirected } from "./cost";

export const zeroHeuristic: HeuristicFn = () => 0;
export const haversineHeuristic: HeuristicFn = (node, goal) => haversine(node, goal);

/** Build an id->edge index once, so expansions are O(1) per edge, not O(E). */
export function indexEdges(graph: Graph): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of graph.edges) m.set(e.id, e);
  return m;
}

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
  const byId = indexEdges(graph);
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
      const { nodes, edges } = reconstruct(came, startId, goalId);
      return {
        path: summarizePath(nodes, edges, userMax, costFn),
        nodesExpanded,
        pushes,
        pops,
      };
    }
    closed.add(current);
    nodesExpanded++;

    for (const edgeId of graph.adjacency[current] ?? []) {
      const edge = byId.get(edgeId)!;
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

/**
 * Walk came-from from goal back to start, returning the node id sequence AND the
 * exact edges the search relaxed (start->goal order). Using the relaxed edges —
 * not re-resolving by node pair — keeps cost/steepEdges correct when parallel
 * edges share a node pair.
 */
function reconstruct(
  came: Map<string, { edge: Edge; prev: string }>,
  startId: string,
  goalId: string
): { nodes: string[]; edges: Edge[] } {
  const nodes: string[] = [goalId];
  const edges: Edge[] = [];
  let cur = goalId;
  while (cur !== startId) {
    const entry = came.get(cur)!;
    edges.push(entry.edge);
    cur = entry.prev;
    nodes.push(cur);
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges };
}

/**
 * Turn a node sequence + the exact traversed edges into a Path: total cost +
 * length, and flag edges whose DIRECTED grade exceeds userMax. Shared by
 * `search` and `bidirectional`. `edges[i]` is the edge traversed from `nodes[i]`.
 */
export function summarizePath(
  nodes: string[],
  edges: Edge[],
  userMax: number,
  costFn: CostFn
): Path {
  const edgeIds: string[] = [];
  const steepEdges: string[] = [];
  let cost = 0;
  let lengthM = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const from = nodes[i];
    edgeIds.push(edge.id);
    cost += costFn(edge, from, userMax);
    lengthM += edge.lengthM;
    if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
      steepEdges.push(edge.id);
    }
  }
  return { nodes, edges: edgeIds, cost, lengthM, steepEdges };
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
