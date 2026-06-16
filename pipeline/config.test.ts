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
