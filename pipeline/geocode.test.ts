import { describe, it, expect, vi } from "vitest";
import { geocode } from "./geocode";

describe("geocode", () => {
  it("parses the first Nominatim result into lat/lng/label", async () => {
    const fakeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify([{ lat: "47.6205", lon: "-122.3493", display_name: "Space Needle, Seattle" }]),
        { status: 200 }
      )
    );
    const r = await geocode("space needle", { fetchImpl: fakeFetch as unknown as typeof fetch });
    expect(r).toEqual({ lat: 47.6205, lng: -122.3493, label: "Space Needle, Seattle" });
    const url = fakeFetch.mock.calls[0][0] as string;
    expect(url).toContain("q=space+needle");
  });

  it("includes a viewbox bias when given a bbox", async () => {
    const fakeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify([{ lat: "1", lon: "2", display_name: "x" }]), { status: 200 })
    );
    await geocode("x", { viewbox: [-122.34, 47.6, -122.31, 47.62], fetchImpl: fakeFetch as unknown as typeof fetch });
    const url = fakeFetch.mock.calls[0][0] as string;
    expect(url).toContain("viewbox=");
    expect(url).toContain("bounded=0");
  });

  it("returns null when there are no results", async () => {
    const fakeFetch = vi.fn(async () => new Response("[]", { status: 200 }));
    expect(await geocode("nowhere", { fetchImpl: fakeFetch as unknown as typeof fetch })).toBeNull();
  });

  it("throws on a non-OK response", async () => {
    const fakeFetch = vi.fn(async () => new Response("rate", { status: 429 }));
    await expect(geocode("x", { fetchImpl: fakeFetch as unknown as typeof fetch })).rejects.toThrow(/429/);
  });
});
