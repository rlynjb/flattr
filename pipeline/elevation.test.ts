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
