// mobile/src/loadGraph.ts — load the bundled graph as a typed Graph.
// graph.json is the REAL build artifact (Capitol Hill via Overpass + Open-Meteo);
// regenerate with `npm run build:graph` then copy data/graph.json here.
// (graph.sample.json remains an offline synthetic fallback, produced by
// mobile/scripts/make-sample-graph.ts — not bundled unless imported.)
import type { Graph } from "features/routing/types";
import graph from "../assets/graph.json";

export function loadGraph(): Graph {
  return graph as unknown as Graph;
}
