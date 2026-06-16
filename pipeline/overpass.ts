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

// Overpass public servers commonly return these transiently under load.
const RETRYABLE = new Set([429, 502, 503, 504]);

/** Fetch raw OSM for a bbox. `fetchImpl` is injectable so tests never hit the network. */
export async function fetchOverpass(
  bbox: [number, number, number, number],
  endpoint: string = DEFAULT_ENDPOINT,
  fetchImpl: typeof fetch = fetch,
  opts: { retries?: number; delayMs?: number } = {}
): Promise<OverpassResponse> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const body = "data=" + encodeURIComponent(buildOverpassQuery(bbox));

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "flatr/0.1 (grade-aware routing graph builder)",
      },
      body,
    });
    if (res.ok) return (await res.json()) as OverpassResponse;
    if (RETRYABLE.has(res.status) && attempt < retries) {
      await sleep(delayMs * (attempt + 1));
      continue;
    }
    throw new Error(`Overpass request failed: ${res.status}`);
  }
}
