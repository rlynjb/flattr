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
    const fakeFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    const res = await fetchOverpass(bbox, "https://example/api", fakeFetch as unknown as typeof fetch);
    expect(res.elements).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledOnce();
    const call = fakeFetch.mock.calls[0];
    expect(call[0]).toBe("https://example/api");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("throws on a non-retryable response without retrying", async () => {
    const fakeFetch = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(
      fetchOverpass(bbox, "https://example/api", fakeFetch as unknown as typeof fetch, { delayMs: 0 })
    ).rejects.toThrow(/400/);
    expect(fakeFetch).toHaveBeenCalledOnce(); // 400 is not retryable
  });

  it("retries a transient 504 then succeeds", async () => {
    const body: OverpassResponse = { elements: [] };
    let n = 0;
    const fakeFetch = vi.fn(async () => {
      n++;
      return n === 1 ? new Response("busy", { status: 504 }) : new Response(JSON.stringify(body), { status: 200 });
    });
    const res = await fetchOverpass(bbox, "https://example/api", fakeFetch as unknown as typeof fetch, { delayMs: 0 });
    expect(res.elements).toEqual([]);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent 429", async () => {
    const fakeFetch = vi.fn(async () => new Response("rate", { status: 429 }));
    await expect(
      fetchOverpass(bbox, "https://example/api", fakeFetch as unknown as typeof fetch, { retries: 2, delayMs: 0 })
    ).rejects.toThrow(/429/);
    expect(fakeFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
