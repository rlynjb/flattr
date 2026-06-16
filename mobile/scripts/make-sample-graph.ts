// mobile/scripts/make-sample-graph.ts — build a varied Seattle sample graph OFFLINE
// (synthetic street grid + a hill) so 3a renders all three color bands without network.
// Run from repo root:  npx tsx mobile/scripts/make-sample-graph.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { buildGraph } from "../../pipeline/build-graph";
import { fixtureProvider } from "../../pipeline/elevation";
import { BBOX } from "../../pipeline/config";
import type { OverpassElement, OverpassResponse } from "../../pipeline/types";

const [minLng, minLat, maxLng, maxLat] = BBOX;
const N = 9; // 9x9 intersections across the bbox

const elements: OverpassElement[] = [];
const nodeId = (r: number, c: number) => 1 + r * N + c;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    elements.push({
      type: "node",
      id: nodeId(r, c),
      lat: minLat + (maxLat - minLat) * (r / (N - 1)),
      lon: minLng + (maxLng - minLng) * (c / (N - 1)),
    });
  }
}
let wayId = 10000;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    if (c + 1 < N)
      elements.push({ type: "way", id: wayId++, nodes: [nodeId(r, c), nodeId(r, c + 1)], tags: { highway: "residential" } });
    if (r + 1 < N)
      elements.push({ type: "way", id: wayId++, nodes: [nodeId(r, c), nodeId(r + 1, c)], tags: { highway: "residential" } });
  }
}
const osm: OverpassResponse = { elements };

// Hill rising toward the NE plus sinusoidal ripples -> grades that span green/yellow/red.
const elevation = fixtureProvider((lat, lng) => {
  const nx = (lng - minLng) / (maxLng - minLng);
  const ny = (lat - minLat) / (maxLat - minLat);
  return 120 * (0.6 * nx + 0.4 * ny) + 25 * Math.sin(nx * 6) * Math.cos(ny * 6);
});

// Wrapped in main() (not top-level await): this file lives under mobile/, whose
// package.json is not ESM, so tsx would reject a top-level await here.
async function main(): Promise<void> {
  const graph = await buildGraph("seattle-sample", BBOX, osm, elevation, 30);
  mkdirSync("mobile/assets", { recursive: true });
  writeFileSync("mobile/assets/graph.sample.json", JSON.stringify(graph));

  const bands = { green: 0, yellow: 0, red: 0 };
  for (const e of graph.edges) {
    const g = e.absGradePct;
    if (g <= 4) bands.green++;
    else if (g <= 8) bands.yellow++;
    else bands.red++;
  }
  console.log(
    `wrote mobile/assets/graph.sample.json: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges`
  );
  console.log(`band distribution: ${JSON.stringify(bands)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
