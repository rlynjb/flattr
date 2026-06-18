// pipeline/run-build.ts — CLI: fetch OSM for BBOX, sample elevation, write data/graph.json.
// Elevation source: GOOGLE_ELEVATION_KEY (paid, best) > Open-Meteo (free, default) >
// FLAT_ELEVATION=1 (synthetic 0m, offline fallback). Usage: npm run build:graph
import { mkdirSync, writeFileSync } from "node:fs";
import type { Graph } from "../features/routing/types";
import { BBOX, MAX_SEGMENT_M } from "./config";
import { fetchOverpass } from "./overpass";
import { buildGraph } from "./build-graph";

/** Serialize a graph to JSON on disk (the static artifact the app reads). */
function writeGraph(graph: Graph, path: string): void {
  writeFileSync(path, JSON.stringify(graph));
}
import { fixtureProvider, googleProvider, openMeteoProvider, type ElevationProvider } from "./elevation";

type Picked = {
  provider: ElevationProvider;
  sampleOpts: { dedupePrecision?: number };
  maxSegM: number;
};

function pickElevation(): Picked {
  const key = process.env.GOOGLE_ELEVATION_KEY;
  if (key) {
    console.log("Elevation: Google Elevation API (paid).");
    return { provider: googleProvider(key), sampleOpts: {}, maxSegM: MAX_SEGMENT_M };
  }
  if (process.env.FLAT_ELEVATION === "1") {
    console.warn("Elevation: FLAT (0m) — grades will be 0. For testing only.");
    return { provider: fixtureProvider(() => 0), sampleOpts: {}, maxSegM: MAX_SEGMENT_M };
  }
  console.log("Elevation: Open-Meteo (free, 90m DEM). Set GOOGLE_ELEVATION_KEY for higher fidelity.");
  // Match split granularity AND the elevation-dedup grid to the ~90m DEM resolution:
  // splitting finer than the DEM would compute grades over sub-DEM baselines and spike
  // wildly at cell steps. ~90m keeps grades physically sane on this coarse source, and
  // one query per cell keeps us under the free-tier rate limit.
  return { provider: openMeteoProvider(), sampleOpts: { dedupePrecision: 0.0008 }, maxSegM: 90 };
}

async function main(): Promise<void> {
  const { provider, sampleOpts, maxSegM } = pickElevation();

  console.log(`Fetching OSM for bbox ${BBOX.join(",")} ...`);
  const osm = await fetchOverpass(BBOX);
  console.log(`Building graph ...`);
  const graph = await buildGraph("seattle-mvp", BBOX, osm, provider, maxSegM, sampleOpts);
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
