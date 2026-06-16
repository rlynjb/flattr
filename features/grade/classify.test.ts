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
