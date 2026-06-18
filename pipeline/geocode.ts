// pipeline/geocode.ts — forward geocoding (address -> coordinate) via Nominatim (OSM).
// Free, no key; respect the usage policy (User-Agent required, ~1 req/sec).
export type GeocodeResult = { lat: number; lng: number; label: string };

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

type NominatimRow = { lat: string; lon: string; display_name: string };

export async function geocode(
  query: string,
  opts: { viewbox?: [number, number, number, number]; fetchImpl?: typeof fetch } = {}
): Promise<GeocodeResult | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
  if (opts.viewbox) {
    const [minLng, minLat, maxLng, maxLat] = opts.viewbox;
    // Nominatim viewbox is left,top,right,bottom; bounded=0 biases (not restricts).
    params.set("viewbox", `${minLng},${maxLat},${maxLng},${minLat}`);
    params.set("bounded", "0");
  }
  const res = await fetchImpl(`${ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": "flattr/0.1 (grade-aware routing)" },
  });
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  const rows = (await res.json()) as NominatimRow[];
  if (!rows.length) return null;
  return { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon), label: rows[0].display_name };
}

/** Autocomplete: up to `limit` matches (addresses AND named places/POIs). */
export async function geocodeSuggest(
  query: string,
  opts: {
    viewbox?: [number, number, number, number];
    bounded?: boolean;
    limit?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<GeocodeResult[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: String(opts.limit ?? 5) });
  if (opts.viewbox) {
    const [minLng, minLat, maxLng, maxLat] = opts.viewbox;
    params.set("viewbox", `${minLng},${maxLat},${maxLng},${minLat}`);
    params.set("bounded", opts.bounded ? "1" : "0"); // 1 = restrict results to the box
  }
  const res = await fetchImpl(`${ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": "flattr/0.1 (grade-aware routing)" },
  });
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  const rows = (await res.json()) as NominatimRow[];
  return rows.map((r) => ({ lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: r.display_name }));
}

const REVERSE_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";

/** Reverse geocode a coordinate to a human address (label), or null if none. */
export async function reverseGeocode(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2" });
  const res = await fetchImpl(`${REVERSE_ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": "flattr/0.1 (grade-aware routing)" },
  });
  if (!res.ok) throw new Error(`Reverse geocode failed: ${res.status}`);
  const json = (await res.json()) as { display_name?: string };
  return json.display_name ?? null;
}
