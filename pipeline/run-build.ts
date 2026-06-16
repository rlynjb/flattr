// pipeline/run-build.ts — CLI: fetch OSM for BBOX, sample elevation, write data/graph.json.
// Usage: npm run build:graph   (set GOOGLE_ELEVATION_KEY to use real elevation)
import { mkdirSync } from "node:fs";
import { BBOX } from "./config";
import { fetchOverpass } from "./overpass";
import { buildGraph, writeGraph } from "./build-graph";
import { fixtureProvider, googleProvider, type ElevationProvider } from "./elevation";

async function main(): Promise<void> {
  const key = process.env.GOOGLE_ELEVATION_KEY;
  const elevation: ElevationProvider = key
    ? googleProvider(key)
    : fixtureProvider(() => {
        console.warn("No GOOGLE_ELEVATION_KEY set — using flat (0m) elevation. Grades will be 0.");
        return 0;
      });

  console.log(`Fetching OSM for bbox ${BBOX.join(",")} ...`);
  const osm = await fetchOverpass(BBOX);
  console.log(`Building graph ...`);
  const graph = await buildGraph("seattle-mvp", BBOX, osm, elevation);
  mkdirSync("data", { recursive: true });
  writeGraph(graph, "data/graph.json");
  console.log(
    `Wrote data/graph.json: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
