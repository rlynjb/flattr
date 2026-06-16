// mobile/src/loadGraph.ts — load the bundled sample graph as a typed Graph.
import type { Graph } from "../../features/routing/types";
import sample from "../assets/graph.sample.json";

export function loadGraph(): Graph {
  return sample as unknown as Graph;
}
