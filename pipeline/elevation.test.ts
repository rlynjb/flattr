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

import { openMeteoProvider } from "./elevation";

describe("openMeteoProvider", () => {
  it("parses the Open-Meteo elevation array and batches by 100", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      const lats = new URL(url).searchParams.get("latitude")!.split(",");
      const elevation = lats.map((_, i) => 100 + i);
      return new Response(JSON.stringify({ elevation }), { status: 200 });
    });
    const p = openMeteoProvider(fakeFetch as unknown as typeof fetch, { delayMs: 0 });
    const pts = Array.from({ length: 150 }, (_, i) => ({ lat: 47 + i * 0.001, lng: -122 }));
    const elevs = await p.sample(pts);
    expect(elevs).toHaveLength(150);
    expect(fakeFetch).toHaveBeenCalledTimes(2); // 100 + 50
    expect(elevs[0]).toBe(100);
  });

  it("throws on a non-OK response", async () => {
    const fakeFetch = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const p = openMeteoProvider(fakeFetch as unknown as typeof fetch, { delayMs: 0, retries: 0 });
    await expect(p.sample([{ lat: 47, lng: -122 }])).rejects.toThrow(/429/);
  });
});

describe("sampleElevations dedup", () => {
  it("queries one representative point per cell and maps it back to all nodes there", async () => {
    const nodes = {
      a: { id: "a", lat: 47.6000, lng: -122.33, elevationM: 0 },
      b: { id: "b", lat: 47.6003, lng: -122.33, elevationM: 0 }, // same ~90m cell as a
      c: { id: "c", lat: 47.6100, lng: -122.33, elevationM: 0 }, // different cell
    };
    const calls: number[] = [];
    const provider = {
      async sample(pts: { lat: number; lng: number }[]) {
        calls.push(pts.length);
        return pts.map((_, i) => 1000 + i);
      },
    };
    const out = await sampleElevations(nodes, provider, { dedupePrecision: 0.0008 });
    expect(calls[0]).toBe(2); // a&b collapse to one cell, c is another -> 2 unique points
    expect(out.a.elevationM).toBe(out.b.elevationM); // same cell -> same elevation
    expect(out.c.elevationM).not.toBe(out.a.elevationM);
  });
});
