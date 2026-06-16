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
  provider: ElevationProvider,
  opts: { dedupePrecision?: number } = {}
): Promise<Record<string, Node>> {
  const ids = Object.keys(nodes);
  const prec = opts.dedupePrecision;

  // No dedup: one sample per node, in order.
  if (!prec) {
    const elevs = await provider.sample(ids.map((id) => ({ lat: nodes[id].lat, lng: nodes[id].lng })));
    const out: Record<string, Node> = {};
    ids.forEach((id, i) => {
      out[id] = { ...nodes[id], elevationM: elevs[i] };
    });
    return out;
  }

  // Dedup: nodes within the same `prec`-sized cell share one query — don't sample
  // finer than the DEM resolution (and stay under free-tier request limits).
  const keyOf = (lat: number, lng: number) => `${Math.round(lat / prec)},${Math.round(lng / prec)}`;
  const repByKey = new Map<string, { lat: number; lng: number }>();
  for (const id of ids) {
    const n = nodes[id];
    const k = keyOf(n.lat, n.lng);
    if (!repByKey.has(k)) repByKey.set(k, { lat: n.lat, lng: n.lng });
  }
  const keys = [...repByKey.keys()];
  const elevs = await provider.sample(keys.map((k) => repByKey.get(k)!));
  const elevByKey = new Map<string, number>();
  keys.forEach((k, i) => elevByKey.set(k, elevs[i]));

  const out: Record<string, Node> = {};
  for (const id of ids) {
    const n = nodes[id];
    out[id] = { ...n, elevationM: elevByKey.get(keyOf(n.lat, n.lng))! };
  }
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

const OPEN_METEO_BATCH = 100; // Open-Meteo elevation allows up to 100 locations/request.

/**
 * Free, no-key elevation via the Open-Meteo Elevation API (Copernicus 90m DEM).
 * Default real source. 90m is coarse — it smooths short steep pitches (§11.A); the
 * Google/LIDAR providers are the fidelity upgrade. `fetchImpl` injectable for tests.
 */
export function openMeteoProvider(
  fetchImpl: typeof fetch = fetch,
  opts: { delayMs?: number; retries?: number } = {}
): ElevationProvider {
  const delayMs = opts.delayMs ?? 300; // throttle between batches (free-tier friendly)
  const retries = opts.retries ?? 3; // retry 429s with exponential backoff
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    async sample(points) {
      const out: number[] = [];
      for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {
        const batch = points.slice(i, i + OPEN_METEO_BATCH);
        const lats = batch.map((p) => p.lat).join(",");
        const lngs = batch.map((p) => p.lng).join(",");
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
        let json: { elevation: number[] } | null = null;
        for (let attempt = 0; ; attempt++) {
          const res = await fetchImpl(url);
          if (res.ok) {
            json = (await res.json()) as { elevation: number[] };
            break;
          }
          if (res.status === 429 && attempt < retries) {
            await sleep(delayMs * 2 ** (attempt + 1));
            continue;
          }
          throw new Error(`Open-Meteo elevation: ${res.status}`);
        }
        for (const e of json.elevation) out.push(e);
        if (delayMs && i + OPEN_METEO_BATCH < points.length) await sleep(delayMs);
      }
      return out;
    },
  };
}
