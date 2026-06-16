// Run every stage over fixed INTERIOR pairs and print the comparison table.
// Usage: npm run bench
import { makeGridGraph } from "../features/routing/fixtures";
import { dijkstra, astar, gradeAstar, directedAstar } from "../features/routing/astar";
import { bidirectional } from "../features/routing/bidirectional";
import { distanceCost, gradeCostDirected } from "../features/routing/cost";
import { formatTable, type BenchRow } from "./report";
import { performance } from "node:perf_hooks";
import type { SearchResult } from "../features/routing/types";

// userMax=10 keeps interior grid paths below the grid's 6.25% max grade, so the
// grade router returns a clean optimum (no all-BLOCKED 1e11 costs in the table).
const USER_MAX = 10;

// INTERIOR pairs only. Corner-to-corner is degenerate: the goal is the farthest
// node, so Dijkstra expands the whole graph and NOTHING can be pruned.
const pairs: Array<{ name: string; start: string; goal: string; size: number }> = [
  { name: "grid30 12,12->17,17 (near interior)", start: "12,12", goal: "17,17", size: 30 },
  { name: "grid40 10,10->30,20 (mid interior)", start: "10,10", goal: "30,20", size: 40 },
  { name: "grid40 18,18->21,21 (short interior)", start: "18,18", goal: "21,21", size: 40 },
];

function time(fn: () => SearchResult): { result: SearchResult; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

for (const { name, start, goal, size } of pairs) {
  const g = makeGridGraph(size);
  // Two sub-stories share one table:
  //  - DISTANCE problem (same optimal cost): dijkstra -> astar -> bidirectional.
  //    Shows search efficiency improving for the SAME answer (§15.2 stages 1,2,5).
  //  - GRADE problem (different, higher cost by design): gradeAstar, directedAstar
  //    (§15.2 stages 3,4) — the domain cost model, not a search-speed comparison.
  const algos: Array<{ algorithm: string; run: () => SearchResult }> = [
    { algorithm: "dijkstra", run: () => dijkstra(g, start, goal) },
    { algorithm: "astar", run: () => astar(g, start, goal) },
    { algorithm: "bidirectional", run: () => bidirectional(g, start, goal, Infinity, distanceCost) },
    { algorithm: "gradeAstar", run: () => gradeAstar(g, start, goal, USER_MAX) },
    { algorithm: "directedAstar", run: () => directedAstar(g, start, goal, USER_MAX) },
  ];

  const rows: BenchRow[] = [];
  for (const { algorithm, run } of algos) {
    const { result, ms } = time(run);
    rows.push({
      algorithm,
      nodesExpanded: result.nodesExpanded,
      pushes: result.pushes,
      pops: result.pops,
      ms,
      cost: result.path ? result.path.cost : NaN,
    });
  }
  console.log("\n" + formatTable(name, rows));
}
console.log(
  "\nDISTANCE problem (dijkstra/astar/bidirectional, equal cost): A* prunes the flood to a cone;" +
    "\nbidirectional meets in the middle — far fewer expansions than dijkstra, typically slightly more" +
    "\nthan the single A* cone (expected on a near-Euclidean grid, not a bug)." +
    "\nGRADE problem (gradeAstar/directedAstar): higher cost is the grade penalty, by design."
);
