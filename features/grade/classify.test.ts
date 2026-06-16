import { describe, it, expect } from "vitest";
import { classifyAbs, bandColor, DEFAULT_BANDS, type Band } from "./classify";

describe("classifyAbs (fixed bands, §10 Phase 1)", () => {
  it("green at or below the green ceiling", () => {
    expect(classifyAbs(0)).toBe("green");
    expect(classifyAbs(4)).toBe("green"); // boundary inclusive
  });
  it("yellow between green and yellow ceilings", () => {
    expect(classifyAbs(4.01)).toBe("yellow");
    expect(classifyAbs(8)).toBe("yellow"); // boundary inclusive
  });
  it("red above the yellow ceiling", () => {
    expect(classifyAbs(8.01)).toBe("red");
    expect(classifyAbs(25)).toBe("red");
  });
  it("accepts injected bands (the seam 3b uses for userMax)", () => {
    const bands = { greenMax: 2, yellowMax: 5 };
    expect(classifyAbs(3, bands)).toBe("yellow");
    expect(classifyAbs(6, bands)).toBe("red");
  });
  it("treats negative input as its magnitude (defensive; abs is non-negative)", () => {
    expect(classifyAbs(-10)).toBe("red");
  });
});

describe("bandColor", () => {
  it("maps each band to a distinct hex color", () => {
    const colors = (["green", "yellow", "red"] as Band[]).map(bandColor);
    expect(new Set(colors).size).toBe(3);
    expect(bandColor("green")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
  it("exposes default band thresholds", () => {
    expect(DEFAULT_BANDS.greenMax).toBe(4);
    expect(DEFAULT_BANDS.yellowMax).toBe(8);
  });
});

import { classifyDirected, bandsForUserMax, USERMAX_PRESETS } from "./classify";

describe("classifyDirected (signed directed grade, §7)", () => {
  const max = 8;
  it("downhill or flat is green (free), even when steep downhill", () => {
    expect(classifyDirected(0, max)).toBe("green");
    expect(classifyDirected(-20, max)).toBe("green");
  });
  it("moderate uphill (0 .. 0.5*max) is yellow", () => {
    expect(classifyDirected(0.01, max)).toBe("yellow");
    expect(classifyDirected(4, max)).toBe("yellow"); // 0.5*max boundary
  });
  it("steep uphill (0.5*max .. max) is red", () => {
    expect(classifyDirected(4.01, max)).toBe("red");
    expect(classifyDirected(8, max)).toBe("red"); // max boundary
  });
  it("above max is grey (too steep / blocked)", () => {
    expect(classifyDirected(8.01, max)).toBe("grey");
  });
});

describe("bandsForUserMax", () => {
  it("derives heatmap abs-grade bands from userMax (green<=0.5*max, yellow<=max)", () => {
    expect(bandsForUserMax(8)).toEqual({ greenMax: 4, yellowMax: 8 });
  });
});

describe("USERMAX_PRESETS", () => {
  it("includes the spec §7 presets with their userMax values", () => {
    const byLabel = Object.fromEntries(USERMAX_PRESETS.map((p) => [p.label, p.userMax]));
    expect(byLabel["Kick scooter"]).toBe(5);
    expect(byLabel["Walking"]).toBe(8);
    expect(byLabel["Any"]).toBe(15);
    expect(USERMAX_PRESETS.length).toBeGreaterThanOrEqual(3);
  });
});

describe("grey band color", () => {
  it("has a distinct grey color", () => {
    expect(bandColor("grey")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
