# Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A build-time Node/TS pipeline that turns an OSM bbox + elevation samples into a grade-annotated `graph.json` that the Plan 1 router consumes directly — `osm → split → elevation → grade → build-graph`.

**Architecture:** Pure transform stages wired in `build-graph.ts`. All network/secret access sits behind seams: OSM via an injectable `fetchImpl`, elevation via an `ElevationProvider` interface. Tests and a sample build run entirely offline on fixtures (a saved Overpass JSON + a deterministic elevation function); the real Overpass and Google Elevation adapters are written and wired but never invoked by the test suite. The output reuses Plan 1's `Node`/`Edge`/`Graph` types and `buildAdjacency`, and the integration test proves the artifact routes via Plan 1's `dijkstra`.

**Tech Stack:** TypeScript (strict), Vitest, tsx, Node 20 global `fetch`. No OSM library (we hit Overpass and parse JSON ourselves), no elevation SDK.

**Source specs:** `docs/flattr-spec.md` (§5 architecture, §9 `pipeline/`, §10 Phase 0, §11.A/C/E, §14.3 graph rigor). Build order + locked decisions: `docs/superpowers/plans/ROADMAP.md`. Decisions for this plan: OSM = Overpass live (fixture-tested); elevation = provider interface, fixture for tests, Google adapter wired; bbox = configurable, Seattle default.

---

## File structure

| File | Responsibility |
|---|---|
| `pipeline/types.ts` | Overpass response types, `RawWay` |
| `pipeline/config.ts` | `BBOX` default, `MAX_SEGMENT_M`, `WALKABLE` highway→kind map |
| `pipeline/overpass.ts` | `buildOverpassQuery(bbox)` + `fetchOverpass` (injectable fetch) |
| `pipeline/osm.ts` | `parseOsm(response)` → walkable `RawWay[]` with resolved coords |
| `pipeline/split.ts` | `splitWays` — densify long edges to ≤`MAX_SEGMENT_M`, snap coincident vertices (node identity), emit `Node`/`Edge` skeletons |
| `pipeline/elevation.ts` | `ElevationProvider` interface, `fixtureProvider`, `googleProvider`, `sampleElevations` |
| `pipeline/grade.ts` | `computeGrades` — fill `lengthM`/`riseM`/`gradePct`/`absGradePct` |
| `pipeline/build-graph.ts` | `buildGraph(...)` orchestration + `writeGraph` |
| `pipeline/run-build.ts` | CLI entry (`npm run build:graph`) — real Overpass + provider, gated on network/key |
| `pipeline/fixtures.ts` | Hand-built Overpass response + elevation fn, shared by tests |

Tests co-located as `pipeline/*.test.ts`. Reuses `lib/geo.ts` (`haversine`), `features/routing/types.ts`, `features/routing/graph.ts` (`buildAdjacency`), and (in the integration test only) `features/routing/astar.ts` (`dijkstra`).

Build order is strict: scaffold → types → config → overpass → osm → split → elevation → grade → build-graph (+ integration) → run-build CLI.

---

## Task 0: Scaffold the pipeline

**Files:**
- Modify: `tsconfig.json` (add `pipeline` to `include`)
- Modify: `package.json` (add `build:graph` script)
- Modify: `.gitignore` (ignore the build output)

- [ ] **Step 1: Add `pipeline` to `tsconfig.json` `include`**

Change the `include` array from:
```json
  "include": ["features", "lib", "bench"]
```
to:
```json
  "include": ["features", "lib", "bench", "pipeline"]
```

- [ ] **Step 2: Add the build script to `package.json`**

In `"scripts"`, add `build:graph` after `bench`:
```json
    "bench": "tsx bench/run.ts",
    "build:graph": "tsx pipeline/run-build.ts"
```

- [ ] **Step 3: Ignore the build output in `.gitignore`**

Append:
```
data/
```

- [ ] **Step 4: Verify nothing broke**

Run: `npm test && npm run typecheck`
Expected: existing 50 tests pass; typecheck clean (no pipeline files yet, so `include` of an empty dir is fine).

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json package.json .gitignore
git commit -m "chore: scaffold pipeline build target"
```

---

## Task 1: `pipeline/types.ts` — OSM/Overpass types

**Files:**
- Create: `pipeline/types.ts`

Type-only; verified by `tsc`.

- [ ] **Step 1: Write the types**

```ts
// pipeline/types.ts — Overpass API shapes (subset) + the parsed way form.
import type { EdgeKind } from "../features/routing/types";

export type OverpassNode = { type: "node"; id: number; lat: number; lon: number };
export type OverpassWay = {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};
export type OverpassElement = OverpassNode | OverpassWay;
export type OverpassResponse = { elements: OverpassElement[] };

/** A walkable way resolved to ordered lat/lng coordinates. */
export type RawWay = {
  id: number;
  kind?: EdgeKind;
  coords: { lat: number; lng: number }[];
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add pipeline/types.ts
git commit -m "feat: add pipeline OSM/Overpass types"
```

---

## Task 2: `pipeline/config.ts` — bbox, split granularity, walkable tags

**Files:**
- Create: `pipeline/config.ts`
- Test: `pipeline/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/config.test.ts
import { describe, it, expect } from "vitest";
import { BBOX, MAX_SEGMENT_M, WALKABLE } from "./config";

describe("pipeline config", () => {
  it("BBOX is [minLng, minLat, maxLng, maxLat] in Seattle, min < max", () => {
    const [minLng, minLat, maxLng, maxLat] = BBOX;
    expect(minLng).toBeLessThan(maxLng);
    expect(minLat).toBeLessThan(maxLat);
    expect(minLng).toBeLessThan(0); // western hemisphere
    expect(minLat).toBeGreaterThan(40); // northern, Seattle-ish
  });

  it("MAX_SEGMENT_M is in the 10-15m hilly range (§11.C)", () => {
    expect(MAX_SEGMENT_M).toBeGreaterThanOrEqual(10);
    expect(MAX_SEGMENT_M).toBeLessThanOrEqual(15);
  });

  it("WALKABLE maps common highway tags to EdgeKind", () => {
    expect(WALKABLE["footway"]).toBe("footway");
    expect(WALKABLE["residential"]).toBe("residential");
    expect(WALKABLE["motorway"]).toBeUndefined(); // excluded
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run pipeline/config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `pipeline/config.ts`**

```ts
// pipeline/config.ts — build-time configuration.
import type { EdgeKind } from "../features/routing/types";

/** [minLng, minLat, maxLng, maxLat] — downtown + Capitol Hill, Seattle (placeholder, §10). */
export const BBOX: [number, number, number, number] = [-122.34, 47.6, -122.31, 47.62];

/** Split long edges so no segment exceeds this (§11.C: 10-15m in hilly areas). */
export const MAX_SEGMENT_M = 12;

/** OSM `highway` values treated as walkable/rollable, mapped to our EdgeKind. */
export const WALKABLE: Record<string, EdgeKind> = {
  footway: "footway",
  sidewalk: "sidewalk",
  pedestrian: "footway",
  path: "path",
  steps: "path",
  living_street: "residential",
  residential: "residential",
  service: "residential",
};
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run pipeline/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/config.ts pipeline/config.test.ts
git commit -m "feat: add pipeline config (bbox, split granularity, walkable tags)"
```

---

## Task 3: `pipeline/overpass.ts` — query builder + fetch adapter

**Files:**
- Create: `pipeline/overpass.ts`
- Test: `pipeline/overpass.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/overpass.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildOverpassQuery, fetchOverpass } from "./overpass";
import type { OverpassResponse } from "./types";

const bbox: [number, number, number, number] = [-122.34, 47.6, -122.31, 47.62];

describe("buildOverpassQuery", () => {
  it("emits the bbox in Overpass order (south,west,north,east)", () => {
    const q = buildOverpassQuery(bbox);
    // minLat,minLng,maxLat,maxLng
    expect(q).toContain("47.6,-122.34,47.62,-122.31");
    expect(q).toContain('way["highway"]');
    expect(q).toContain("[out:json]");
  });
});

describe("fetchOverpass", () => {
  it("POSTs the query and returns parsed JSON", async () => {
    const body: OverpassResponse = { elements: [{ type: "node", id: 1, lat: 47.6, lon: -122.33 }] };
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const res = await fetchOverpass(bbox, "https://example/api", fakeFetch as unknown as typeof fetch);
    expect(res.elements).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledOnce();
    const call = fakeFetch.mock.calls[0];
    expect(call[0]).toBe("https://example/api");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("throws on a non-OK response", async () => {
    const fakeFetch = vi.fn(async () => new Response("boom", { status: 429 }));
    await expect(
      fetchOverpass(bbox, "https://example/api", fakeFetch as unknown as typeof fetch)
    ).rejects.toThrow(/429/);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run pipeline/overpass.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `pipeline/overpass.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run pipeline/overpass.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/overpass.ts pipeline/overpass.test.ts
git commit -m "feat: add Overpass query builder and fetch adapter"
```

---

## Task 4: `pipeline/osm.ts` — parse Overpass into walkable ways

**Files:**
- Create: `pipeline/osm.ts`
- Test: `pipeline/osm.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/osm.test.ts
import { describe, it, expect } from "vitest";
import { parseOsm } from "./osm";
import type { OverpassResponse } from "./types";

const res: OverpassResponse = {
  elements: [
    { type: "node", id: 1, lat: 47.60, lon: -122.33 },
    { type: "node", id: 2, lat: 47.601, lon: -122.33 },
    { type: "node", id: 3, lat: 47.602, lon: -122.33 },
    // walkable footway 1-2-3
    { type: "way", id: 100, nodes: [1, 2, 3], tags: { highway: "footway" } },
    // excluded motorway
    { type: "way", id: 101, nodes: [1, 2], tags: { highway: "motorway" } },
    // residential (walkable)
    { type: "way", id: 102, nodes: [2, 3], tags: { highway: "residential" } },
    // degenerate: single resolvable node -> dropped
    { type: "way", id: 103, nodes: [1, 999], tags: { highway: "footway" } },
  ],
};

describe("parseOsm", () => {
  it("keeps only walkable ways and resolves their node coords in order", () => {
    const ways = parseOsm(res);
    const ids = ways.map((w) => w.id).sort();
    expect(ids).toEqual([100, 102]); // motorway excluded, degenerate dropped
    const w = ways.find((x) => x.id === 100)!;
    expect(w.kind).toBe("footway");
    expect(w.coords).toEqual([
      { lat: 47.60, lng: -122.33 },
      { lat: 47.601, lng: -122.33 },
      { lat: 47.602, lng: -122.33 },
    ]);
  });

  it("maps residential to its EdgeKind", () => {
    const w = parseOsm(res).find((x) => x.id === 102)!;
    expect(w.kind).toBe("residential");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run pipeline/osm.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `pipeline/osm.ts`**

```ts
// pipeline/osm.ts — Overpass response -> walkable ways with resolved coordinates.
import type { OverpassResponse, RawWay } from "./types";
import { WALKABLE } from "./config";

export function parseOsm(res: OverpassResponse): RawWay[] {
  const coordsById = new Map<number, { lat: number; lng: number }>();
  for (const el of res.elements) {
    if (el.type === "node") coordsById.set(el.id, { lat: el.lat, lng: el.lon });
  }

  const ways: RawWay[] = [];
  for (const el of res.elements) {
    if (el.type !== "way") continue;
    const hw = el.tags?.highway;
    if (!hw || !(hw in WALKABLE)) continue;
    const coords: { lat: number; lng: number }[] = [];
    for (const nodeId of el.nodes) {
      const c = coordsById.get(nodeId);
      if (c) coords.push(c);
    }
    if (coords.length < 2) continue; // need a segment
    ways.push({ id: el.id, kind: WALKABLE[hw], coords });
  }
  return ways;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run pipeline/osm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/osm.ts pipeline/osm.test.ts
git commit -m "feat: add OSM parser (walkable ways with resolved coords)"
```

---

## Task 5: `pipeline/split.ts` — densify + node snapping (the graph crux)

This is the mesh-construction step (§14.3): split long edges so a short steep
pitch isn't averaged away, and **snap coincident vertices to one node id** or the
graph comes out disconnected.

**Files:**
- Create: `pipeline/split.ts`
- Test: `pipeline/split.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/split.test.ts
import { describe, it, expect } from "vitest";
import { splitWays } from "./split";
import type { RawWay } from "./types";
import { haversine } from "../lib/geo";
import { buildAdjacency } from "../features/routing/graph";

// ~111m north-south at this latitude per 0.001 deg lat.
const A = { lat: 47.6, lng: -122.33 };
const B = { lat: 47.601, lng: -122.33 }; // ~111m north of A

describe("splitWays", () => {
  it("densifies a long segment so no edge exceeds maxSegM", () => {
    const ways: RawWay[] = [{ id: 1, kind: "footway", coords: [A, B] }];
    const { nodes, edges } = splitWays(ways, 12);
    expect(edges.length).toBeGreaterThan(8); // ~111m / 12m
    for (const e of edges) {
      const [from, to] = e.geometry;
      expect(haversine({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] })).toBeLessThanOrEqual(12.001);
    }
    // endpoints preserved as nodes
    const coords = Object.values(nodes).map((n) => `${n.lat},${n.lng}`);
    expect(coords).toContain(`${A.lat},${A.lng}`);
    expect(coords).toContain(`${B.lat},${B.lng}`);
  });

  it("snaps a shared vertex so two ways connect through ONE node", () => {
    const C = { lat: 47.6, lng: -122.329 }; // east of A, shares A as a corner
    const ways: RawWay[] = [
      { id: 1, kind: "footway", coords: [A, B] },
      { id: 2, kind: "footway", coords: [A, C] }, // shares A
    ];
    const { nodes, edges } = splitWays(ways, 1000); // no densify (segments < 1000m)
    const adj = buildAdjacency(edges);
    // the snapped A node must be incident to one edge from each way (degree 2)
    const aKey = `${A.lat},${A.lng}`;
    const aId = Object.values(nodes).find((n) => `${n.lat},${n.lng}` === aKey)!.id;
    expect(adj[aId].length).toBe(2);
  });

  it("emits Node skeletons with elevationM 0 (filled later) and zeroed grade fields", () => {
    const { nodes, edges } = splitWays([{ id: 1, kind: "footway", coords: [A, B] }], 1000);
    expect(Object.values(nodes).every((n) => n.elevationM === 0)).toBe(true);
    expect(edges.every((e) => e.gradePct === 0 && e.lengthM === 0)).toBe(true);
    expect(edges[0].kind).toBe("footway");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run pipeline/split.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `pipeline/split.ts`**

```ts
// pipeline/split.ts — densify long edges + snap coincident vertices to shared node ids.
import type { Edge, Node } from "../features/routing/types";
import type { RawWay } from "./types";
import { haversine } from "../lib/geo";

type LatLng = { lat: number; lng: number };

/** Identical coordinates -> identical key, so shared OSM vertices become one node. */
function snapKey(p: LatLng): string {
  return `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
}

/** Insert points so no sub-segment of the polyline exceeds maxSegM (linear interpolation). */
function densify(coords: LatLng[], maxSegM: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    out.push(a);
    const d = haversine(a, b);
    if (d > maxSegM) {
      const steps = Math.ceil(d / maxSegM);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      }
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/**
 * Turn walkable ways into a snapped, densified node/edge skeleton. Elevation and
 * grade are left at 0 — `sampleElevations` then `computeGrades` fill them.
 */
export function splitWays(
  ways: RawWay[],
  maxSegM: number
): { nodes: Record<string, Node>; edges: Edge[] } {
  const nodes: Record<string, Node> = {};
  const keyToId = new Map<string, string>();
  const edges: Edge[] = [];
  let nodeCounter = 0;
  let edgeCounter = 0;

  function nodeId(p: LatLng): string {
    const key = snapKey(p);
    let id = keyToId.get(key);
    if (id === undefined) {
      id = `n${nodeCounter++}`;
      keyToId.set(key, id);
      nodes[id] = { id, lat: p.lat, lng: p.lng, elevationM: 0 };
    }
    return id;
  }

  for (const way of ways) {
    const dense = densify(way.coords, maxSegM);
    for (let i = 0; i + 1 < dense.length; i++) {
      const a = dense[i];
      const b = dense[i + 1];
      const fromNode = nodeId(a);
      const toNode = nodeId(b);
      if (fromNode === toNode) continue; // coincident after snapping
      edges.push({
        id: `e${edgeCounter++}`,
        fromNode,
        toNode,
        geometry: [
          [a.lat, a.lng],
          [b.lat, b.lng],
        ],
        lengthM: 0,
        riseM: 0,
        gradePct: 0,
        absGradePct: 0,
        kind: way.kind,
      });
    }
  }
  return { nodes, edges };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run pipeline/split.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/split.ts pipeline/split.test.ts
git commit -m "feat: add edge splitting + node snapping (mesh construction)"
```

---

## Task 6: `pipeline/elevation.ts` — provider interface + adapters

**Files:**
- Create: `pipeline/elevation.ts`
- Test: `pipeline/elevation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/elevation.test.ts
import { describe, it, expect, vi } from "vitest";
import { fixtureProvider, googleProvider, sampleElevations } from "./elevation";
import type { Node } from "../features/routing/types";

const nodes: Record<string, Node> = {
  a: { id: "a", lat: 47.6, lng: -122.33, elevationM: 0 },
  b: { id: "b", lat: 47.61, lng: -122.33, elevationM: 0 },
};

describe("fixtureProvider", () => {
  it("returns deterministic elevations from the given function, in order", async () => {
    const p = fixtureProvider((lat) => lat * 100);
    expect(await p.sample([{ lat: 1, lng: 0 }, { lat: 2, lng: 0 }])).toEqual([100, 200]);
  });
});

describe("sampleElevations", () => {
  it("fills elevationM on every node, preserving other fields", async () => {
    const out = await sampleElevations(nodes, fixtureProvider((lat) => Math.round(lat)));
    expect(out["a"].elevationM).toBe(48);
    expect(out["b"].elevationM).toBe(48);
    expect(out["a"].lat).toBe(47.6); // other fields preserved
  });
});

describe("googleProvider", () => {
  it("parses the Google Elevation response and batches requests", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      const n = (url.match(/%7C/g)?.length ?? 0) + 1; // count piped locations
      const results = Array.from({ length: n }, (_, i) => ({ elevation: 10 + i }));
      return new Response(JSON.stringify({ status: "OK", results }), { status: 200 });
    });
    const p = googleProvider("KEY", fakeFetch as unknown as typeof fetch);
    const elevs = await p.sample([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
    ]);
    expect(elevs).toEqual([10, 11]);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("throws when the API status is not OK", async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ status: "REQUEST_DENIED", results: [] }), { status: 200 }));
    const p = googleProvider("KEY", fakeFetch as unknown as typeof fetch);
    await expect(p.sample([{ lat: 1, lng: 1 }])).rejects.toThrow(/REQUEST_DENIED/);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run pipeline/elevation.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `pipeline/elevation.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run pipeline/elevation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/elevation.ts pipeline/elevation.test.ts
git commit -m "feat: add elevation provider interface + fixture/google adapters"
```

---

## Task 7: `pipeline/grade.ts` — compute per-edge grade

**Files:**
- Create: `pipeline/grade.ts`
- Test: `pipeline/grade.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// pipeline/grade.test.ts
import { describe, it, expect } from "vitest";
import { computeGrades } from "./grade";
import type { Edge, Node } from "../features/routing/types";
import { haversine } from "../lib/geo";

const A: Node = { id: "A", lat: 47.6, lng: -122.33, elevationM: 0 };
const B: Node = { id: "B", lat: 47.601, lng: -122.33, elevationM: 8 }; // climbs 8m A->B

const nodes: Record<string, Node> = { A, B };
const skeleton: Edge = {
  id: "e0",
  fromNode: "A",
  toNode: "B",
  geometry: [
    [A.lat, A.lng],
    [B.lat, B.lng],
  ],
  lengthM: 0,
  riseM: 0,
  gradePct: 0,
  absGradePct: 0,
  kind: "footway",
};

describe("computeGrades", () => {
  it("fills lengthM from geometry and signed grade from elevation", () => {
    const [e] = computeGrades(nodes, [skeleton]);
    const expectedLen = haversine(A, B);
    expect(e.lengthM).toBeCloseTo(expectedLen, 6);
    expect(e.riseM).toBe(8);
    expect(e.gradePct).toBeCloseTo((8 / expectedLen) * 100, 6);
    expect(e.absGradePct).toBe(Math.abs(e.gradePct));
    expect(e.kind).toBe("footway"); // preserved
  });

  it("grade is negated for the reverse edge (descent)", () => {
    const reverse: Edge = { ...skeleton, id: "e1", fromNode: "B", toNode: "A", geometry: [[B.lat, B.lng], [A.lat, A.lng]] };
    const [e] = computeGrades(nodes, [reverse]);
    expect(e.riseM).toBe(-8);
    expect(e.gradePct).toBeLessThan(0);
  });

  it("zero-length edge yields grade 0, no divide-by-zero", () => {
    const zero: Edge = { ...skeleton, id: "e2", geometry: [[A.lat, A.lng], [A.lat, A.lng]] };
    const [e] = computeGrades({ A, B: { ...B, elevationM: 5 } }, [zero]);
    expect(e.lengthM).toBe(0);
    expect(e.gradePct).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run pipeline/grade.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement — `pipeline/grade.ts`**

```ts
// pipeline/grade.ts — fill lengthM / riseM / gradePct / absGradePct per edge.
import type { Edge, Node } from "../features/routing/types";
import { haversine } from "../lib/geo";

/** Length along an edge's polyline geometry, in meters. */
function geometryLength(geometry: [number, number][]): number {
  let len = 0;
  for (let i = 0; i + 1 < geometry.length; i++) {
    len += haversine(
      { lat: geometry[i][0], lng: geometry[i][1] },
      { lat: geometry[i + 1][0], lng: geometry[i + 1][1] }
    );
  }
  return len;
}

export function computeGrades(nodes: Record<string, Node>, edges: Edge[]): Edge[] {
  return edges.map((e) => {
    const lengthM = geometryLength(e.geometry);
    const riseM = nodes[e.toNode].elevationM - nodes[e.fromNode].elevationM;
    const gradePct = lengthM > 0 ? (riseM / lengthM) * 100 : 0;
    return { ...e, lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) };
  });
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run pipeline/grade.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/grade.ts pipeline/grade.test.ts
git commit -m "feat: add per-edge grade computation"
```

---

## Task 8: `pipeline/build-graph.ts` + integration (routes via Plan 1)

**Files:**
- Create: `pipeline/fixtures.ts`
- Create: `pipeline/build-graph.ts`
- Test: `pipeline/build-graph.test.ts`

- [ ] **Step 1: Write the fixtures — `pipeline/fixtures.ts`**

```ts
// pipeline/fixtures.ts — a hand-built Overpass response + elevation fn for tests.
import type { OverpassResponse } from "./types";

/**
 * A small connected network: a footway 1-2-3 and a residential 3-4, sharing node 3.
 * Coordinates are a few hundred meters apart in Seattle.
 */
export function sampleOverpass(): OverpassResponse {
  return {
    elements: [
      { type: "node", id: 1, lat: 47.600, lon: -122.330 },
      { type: "node", id: 2, lat: 47.601, lon: -122.330 },
      { type: "node", id: 3, lat: 47.602, lon: -122.330 },
      { type: "node", id: 4, lat: 47.602, lon: -122.329 },
      { type: "way", id: 100, nodes: [1, 2, 3], tags: { highway: "footway" } },
      { type: "way", id: 101, nodes: [3, 4], tags: { highway: "residential" } },
      { type: "way", id: 102, nodes: [1, 2], tags: { highway: "motorway" } }, // excluded
    ],
  };
}

/** Deterministic elevation: a north-facing ramp so 1->2->3 climbs. */
export function sampleElevationFn(lat: number, _lng: number): number {
  return Math.round((lat - 47.6) * 100000) / 100; // ~1m per 0.00001 deg lat
}
```

- [ ] **Step 2: Write the failing test — `pipeline/build-graph.test.ts`**

```ts
// pipeline/build-graph.test.ts
import { describe, it, expect } from "vitest";
import { buildGraph } from "./build-graph";
import { fixtureProvider } from "./elevation";
import { sampleOverpass, sampleElevationFn } from "./fixtures";
import { dijkstra } from "../features/routing/astar";
import type { Graph } from "../features/routing/types";

const bbox: [number, number, number, number] = [-122.34, 47.6, -122.31, 47.62];

async function build(): Promise<Graph> {
  return buildGraph("test-city", bbox, sampleOverpass(), fixtureProvider(sampleElevationFn), 1000);
}

describe("buildGraph", () => {
  it("produces a Graph with snapped nodes, graded edges, and adjacency", async () => {
    const g = await build();
    expect(g.city).toBe("test-city");
    expect(Object.keys(g.nodes).length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    // every edge has real length and a defined adjacency entry on both ends
    for (const e of g.edges) {
      expect(e.lengthM).toBeGreaterThan(0);
      expect(g.adjacency[e.fromNode]).toContain(e.id);
      expect(g.adjacency[e.toNode]).toContain(e.id);
    }
    // the motorway way (102) was excluded -> no edge longer-than... just assert connectivity below
  });

  it("output is routable by the Plan 1 engine (the Phase 0 gate)", async () => {
    const g = await build();
    // pick two distinct nodes that should be connected (the network is connected)
    const ids = Object.keys(g.nodes);
    const r = dijkstra(g, ids[0], ids[ids.length - 1]);
    expect(r.path).not.toBeNull();
    expect(r.path!.lengthM).toBeGreaterThan(0);
  });

  it("edges climbing north have positive grade (sanity on a known slope)", async () => {
    const g = await build();
    // find an edge whose toNode is north of its fromNode
    const climbing = g.edges.find((e) => g.nodes[e.toNode].lat > g.nodes[e.fromNode].lat);
    expect(climbing).toBeDefined();
    expect(climbing!.gradePct).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run to verify FAIL**

Run: `npx vitest run pipeline/build-graph.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement — `pipeline/build-graph.ts`**

```ts
// pipeline/build-graph.ts — orchestrate the stages into a Graph and serialize it.
import { writeFileSync } from "node:fs";
import type { Graph } from "../features/routing/types";
import { buildAdjacency } from "../features/routing/graph";
import type { OverpassResponse } from "./types";
import { parseOsm } from "./osm";
import { splitWays } from "./split";
import { sampleElevations, type ElevationProvider } from "./elevation";
import { computeGrades } from "./grade";
import { MAX_SEGMENT_M } from "./config";

export async function buildGraph(
  city: string,
  bbox: [number, number, number, number],
  osm: OverpassResponse,
  elevation: ElevationProvider,
  maxSegM: number = MAX_SEGMENT_M
): Promise<Graph> {
  const ways = parseOsm(osm);
  const { nodes: skeletonNodes, edges: skeletonEdges } = splitWays(ways, maxSegM);
  const nodes = await sampleElevations(skeletonNodes, elevation);
  const edges = computeGrades(nodes, skeletonEdges);
  return { city, bbox, nodes, edges, adjacency: buildAdjacency(edges) };
}

/** Serialize a graph to JSON on disk (the static artifact the app reads). */
export function writeGraph(graph: Graph, path: string): void {
  writeFileSync(path, JSON.stringify(graph));
}
```

- [ ] **Step 5: Run to verify PASS**

Run: `npx vitest run pipeline/build-graph.test.ts`
Expected: PASS (3 tests). The routability test is the Phase 0 "done when" gate.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (Plan 1's 50 + pipeline's new ones); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add pipeline/fixtures.ts pipeline/build-graph.ts pipeline/build-graph.test.ts
git commit -m "feat: assemble grade-annotated graph + prove it routes (Phase 0 gate)"
```

---

## Task 9: `pipeline/run-build.ts` — CLI entry (gated on network/key)

The executable build. Not a test gate — it hits Overpass and (optionally) Google.
With no `GOOGLE_ELEVATION_KEY`, it uses a flat-elevation fixture so the structure
runs end-to-end offline-ish (still needs Overpass network).

**Files:**
- Create: `pipeline/run-build.ts`

- [ ] **Step 1: Implement — `pipeline/run-build.ts`**

```ts
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
```

- [ ] **Step 2: Typecheck (no live run in CI)**

Run: `npm run typecheck`
Expected: clean. Do NOT run `npm run build:graph` as part of the automated plan — it requires network (Overpass) and optionally a Google key. A human runs it manually to produce `data/graph.json`.

- [ ] **Step 3: Commit**

```bash
git add pipeline/run-build.ts
git commit -m "feat: add build:graph CLI entry (Overpass + elevation -> graph.json)"
```

---

## Manual validation (Phase 0 ground truth, §10)

Not automated (needs network + a key + human judgment), but the Phase 0 gate:

1. `GOOGLE_ELEVATION_KEY=... npm run build:graph` → `data/graph.json` exists.
2. Spot-check a known-steep block (e.g. Pine St on Capitol Hill) against AccessMap
   or a phone clinometer — the edge `absGradePct` should match within a few points.
3. Confirm the graph is connected enough to route across the bbox (load it and run
   `dijkstra` between two far corners; expect a non-null path).

Record the result; if grades are wrong, decision §11.A (swap fixture/Google →
USGS 3DEP/LIDAR) is the lever, not the pipeline structure.

---

## Done when

- `npm test` passes (Plan 1's 50 + all pipeline tests).
- `npm run typecheck` clean.
- `buildGraph` on the fixture OSM + fixture elevation yields a `Graph` that Plan 1's
  `dijkstra` routes across (the integration test) — the Phase 0 "graph.json exists
  and is consumable" gate, proven offline.
- No OSM/elevation library imported; network + secrets confined to `overpass.ts`,
  `elevation.ts` (googleProvider), and `run-build.ts`, all behind injectable seams.

Next plan (per `ROADMAP.md`): **Plan 3 — runtime map app** (MapLibre heatmap →
router + `userMax` slider → honesty/zones). Revisit the **Android vs web** platform
decision (§8) before starting it.

---

## Self-review notes (spec coverage)

- §5 build-time/runtime split → the whole pipeline is offline; output is a static artifact. §9 `pipeline/` modules → Tasks 3–8 (osm, split, elevation, grade, build-graph); `osm.ts` here = Overpass parse, `split.ts` = mesh construction.
- §11.A elevation → Task 6 provider seam (fixture now, Google wired, LIDAR is a future provider swap). §11.C split granularity → `MAX_SEGMENT_M=12` (Task 2/5). §11.E small bbox → Task 2 config. §11.F directed grade is derived at routing time (Plan 1), so the pipeline stores one signed `gradePct` per edge (Task 7).
- §14.3 node identity/snapping → Task 5 `snapKey` + test; edge splitting as graph-shaping → Task 5 `densify`. §10 Phase 0 ground truth → integration test (automated part) + manual validation section.
- Reuses Plan 1: `lib/geo` haversine (split/grade), `features/routing/types` + `graph.buildAdjacency` (build-graph), `astar.dijkstra` (integration gate).
