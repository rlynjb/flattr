// Bidirectional A* with a balanced consistent potential. Forward from start, backward from goal.
import type { CostFn, Edge, Graph, SearchResult } from "./types";
import { PQueue } from "./pqueue";
import { otherEnd } from "./graph";
import { haversine } from "../../lib/geo";
import { summarizePath, indexEdges } from "./astar";

export function bidirectional(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number,
  costFn: CostFn
): SearchResult {
  let pushes = 0;
  let pops = 0;
  let nodesExpanded = 0;

  const start = graph.nodes[startId];
  const goal = graph.nodes[goalId];
  if (!start || !goal) return { path: null, nodesExpanded, pushes, pops };

  if (startId === goalId) {
    return { path: summarizePath([startId], [], userMax, costFn), nodesExpanded, pushes, pops };
  }

  const byId = indexEdges(graph);

  // Balanced potential: pf consistent for forward, pr = -pf consistent for reverse.
  const pf = (id: string) =>
    (haversine(graph.nodes[id], goal) - haversine(graph.nodes[id], start)) / 2;
  const pr = (id: string) => -pf(id);

  const gf = new Map<string, number>([[startId, 0]]);
  const gr = new Map<string, number>([[goalId, 0]]);
  const cameF = new Map<string, { edge: Edge; prev: string }>();
  const cameR = new Map<string, { edge: Edge; next: string }>();
  const closedF = new Set<string>();
  const closedR = new Set<string>();
  const openF = new PQueue<string>();
  const openR = new PQueue<string>();
  openF.push(startId, pf(startId));
  openR.push(goalId, pr(goalId));
  pushes += 2;

  let mu = Infinity; // best total cost found
  let meet: string | null = null;

  while (!openF.isEmpty() && !openR.isEmpty()) {
    const topF = openF.peekPriority()!;
    const topR = openR.peekPriority()!;
    if (topF + topR >= mu) break; // standard stopping rule

    if (topF <= topR) {
      const u = openF.pop()!;
      pops++;
      if (closedF.has(u)) continue;
      closedF.add(u);
      nodesExpanded++;
      // If the other side already closed this node, check if we have optimal meeting point
      if (closedR.has(u)) {
        const total = gf.get(u)! + gr.get(u)!;
        if (total < mu) { mu = total; meet = u; }
        continue;
      }
      for (const edgeId of graph.adjacency[u] ?? []) {
        const edge = byId.get(edgeId)!;
        const v = otherEnd(edge, u);
        const tentative = gf.get(u)! + costFn(edge, u, userMax); // forward: from = u
        if (tentative < (gf.get(v) ?? Infinity)) {
          gf.set(v, tentative);
          cameF.set(v, { edge, prev: u });
          openF.push(v, tentative + pf(v));
          pushes++;
          if (gr.has(v)) {
            const total = tentative + gr.get(v)!;
            if (total < mu) {
              mu = total;
              meet = v;
            }
          }
        }
      }
    } else {
      const u = openR.pop()!;
      pops++;
      if (closedR.has(u)) continue;
      closedR.add(u);
      nodesExpanded++;
      // If the other side already closed this node, check if we have optimal meeting point
      if (closedF.has(u)) {
        const total = gf.get(u)! + gr.get(u)!;
        if (total < mu) { mu = total; meet = u; }
        continue;
      }
      for (const edgeId of graph.adjacency[u] ?? []) {
        const edge = byId.get(edgeId)!;
        const v = otherEnd(edge, u); // v is the predecessor in the forward path
        const tentative = gr.get(u)! + costFn(edge, v, userMax); // forward dir: from = v
        if (tentative < (gr.get(v) ?? Infinity)) {
          gr.set(v, tentative);
          cameR.set(v, { edge, next: u });
          openR.push(v, tentative + pr(v));
          pushes++;
          if (gf.has(v)) {
            const total = gf.get(v)! + tentative;
            if (total < mu) {
              mu = total;
              meet = v;
            }
          }
        }
      }
    }
  }

  if (meet === null) return { path: null, nodesExpanded, pushes, pops };

  // Reconstruct start..meet (forward) and meet..goal (reverse), collecting the
  // exact relaxed edges (not re-resolved by node pair) so parallel edges stay correct.
  const front: string[] = [meet];
  const frontEdges: Edge[] = [];
  let cur = meet;
  while (cur !== startId) {
    const entry = cameF.get(cur)!;
    frontEdges.push(entry.edge);
    cur = entry.prev;
    front.push(cur);
  }
  front.reverse(); // [start, ..., meet]
  frontEdges.reverse(); // edges in start->meet order

  const back: string[] = [];
  const backEdges: Edge[] = [];
  cur = meet;
  while (cur !== goalId) {
    const entry = cameR.get(cur)!;
    backEdges.push(entry.edge); // edge from cur toward goal (cur -> entry.next)
    cur = entry.next;
    back.push(cur);
  }
  // back = [nodeAfterMeet, ..., goal]; front ends with meet -> concatenate.
  const nodes = [...front, ...back];
  const edges = [...frontEdges, ...backEdges];
  return {
    path: summarizePath(nodes, edges, userMax, costFn),
    nodesExpanded,
    pushes,
    pops,
  };
}
