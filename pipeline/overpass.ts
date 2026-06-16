// pipeline/overpass.ts — build the Overpass QL query and fetch a bbox.
import type { OverpassResponse } from "./types";

const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";

/** Overpass QL for all `highway` ways in a bbox. Overpass bbox order is S,W,N,E. */
export function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const b = `${minLat},${minLng},${maxLat},${maxLng}`;
  return `[out:json][timeout:60];
(way["highway"](${b}););
out body;
>;
out skel qt;`;
}

/** Fetch raw OSM for a bbox. `fetchImpl` is injectable so tests never hit the network. */
export async function fetchOverpass(
  bbox: [number, number, number, number],
  endpoint: string = DEFAULT_ENDPOINT,
  fetchImpl: typeof fetch = fetch
): Promise<OverpassResponse> {
  const res = await fetchImpl(endpoint, { method: "POST", body: buildOverpassQuery(bbox) });
  if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
  return (await res.json()) as OverpassResponse;
}
