import { describe, it, expect } from "vitest";
import { haversine } from "./geo";

describe("haversine", () => {
  it("returns 0 for the same point", () => {
    expect(haversine({ lat: 47.61, lng: -122.33 }, { lat: 47.61, lng: -122.33 })).toBe(0);
  });

  it("matches a known distance within 0.5%", () => {
    // ~1 deg of latitude ~= 111.19 km
    const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("is symmetric", () => {
    const a = { lat: 47.61, lng: -122.33 };
    const b = { lat: 47.62, lng: -122.34 };
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 6);
  });
});
