// pipeline/elevation.ts — pluggable elevation sampling. Tests use fixtureProvider;
// googleProvider is the real adapter (needs an API key), never called by the suite.
import type { Node } from "../features/routing/types";

export type LatLng = { lat: number; lng: number };

export interface ElevationProvider {
  /** Elevation in meters for each point, in the same order. */
  sample(points: LatLng[]): Promise<number[]>;
}

/** Deterministic provider: elevation is a pure function of lat/lng. */
export function fixtureProvider(fn: (lat: number, lng: number) => number): ElevationProvider {
  return {
    async sample(points) {
      return points.map((p) => fn(p.lat, p.lng));
    },
  };
}

/** Fill `elevationM` on every node from the provider, preserving other fields. */
export async function sampleElevations(
  nodes: Record<string, Node>,
  provider: ElevationProvider
): Promise<Record<string, Node>> {
  const ids = Object.keys(nodes);
  const elevs = await provider.sample(ids.map((id) => ({ lat: nodes[id].lat, lng: nodes[id].lng })));
  const out: Record<string, Node> = {};
  ids.forEach((id, i) => {
    out[id] = { ...nodes[id], elevationM: elevs[i] };
  });
  return out;
}

const GOOGLE_BATCH = 256; // Google Elevation allows up to 512 locations/request; stay conservative.

/** Real adapter: Google Elevation API. `fetchImpl` injectable for testing. */
export function googleProvider(apiKey: string, fetchImpl: typeof fetch = fetch): ElevationProvider {
  return {
    async sample(points) {
      const out: number[] = [];
      for (let i = 0; i < points.length; i += GOOGLE_BATCH) {
        const batch = points.slice(i, i + GOOGLE_BATCH);
        const locations = batch.map((p) => `${p.lat},${p.lng}`).join("|");
        const url = `https://maps.googleapis.com/maps/api/elevation/json?locations=${encodeURIComponent(
          locations
        )}&key=${apiKey}`;
        const res = await fetchImpl(url);
        const json = (await res.json()) as { status: string; results: { elevation: number }[] };
        if (json.status !== "OK") throw new Error(`Google Elevation API: ${json.status}`);
        for (const r of json.results) out.push(r.elevation);
      }
      return out;
    },
  };
}
