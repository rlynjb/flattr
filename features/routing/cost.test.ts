import { describe, it, expect } from "vitest";
import {
  BLOCKED,
  penalty,
  distanceCost,
  gradeCostAbs,
  gradeCostDirected,
  DEFAULT_K1,
  DEFAULT_K2,
} from "./cost";
import type { Edge } from "./types";

const max = 5;

function edgeAt(gradePct: number): Edge {
  return {
    id: "e",
    fromNode: "A",
    toNode: "B",
    geometry: [
      [0, 0],
      [0, 1],
    ],
    lengthM: 100,
    riseM: gradePct,
    gradePct,
    absGradePct: Math.abs(gradePct),
  };
}

describe("penalty", () => {
  it("is 0 for downhill or flat", () => {
    expect(penalty(0, max)).toBe(0);
    expect(penalty(-3, max)).toBe(0);
  });

  it("is linear in the moderate band (g <= 0.5*max)", () => {
    expect(penalty(2, max)).toBeCloseTo(DEFAULT_K1 * 2, 10);
  });

  it("is continuous at the moderate/steep boundary (0.5*max)", () => {
    const half = 0.5 * max;
    const linearAtBoundary = DEFAULT_K1 * half;
    expect(penalty(half, max)).toBeCloseTo(linearAtBoundary, 10);
  });

  it("is quadratic in the steep band and larger than the linear extrapolation", () => {
    const g = 4;
    const half = 0.5 * max;
    const expected = DEFAULT_K2 * (g - half) ** 2 + DEFAULT_K1 * half;
    expect(penalty(g, max)).toBeCloseTo(expected, 10);
    expect(penalty(g, max)).toBeGreaterThan(DEFAULT_K1 * g);
  });

  it("returns BLOCKED above max", () => {
    expect(penalty(5.01, max)).toBe(BLOCKED);
    expect(penalty(20, max)).toBe(BLOCKED);
  });
});

describe("cost functions", () => {
  it("distanceCost ignores grade and returns lengthM", () => {
    expect(distanceCost(edgeAt(12), "A", max)).toBe(100);
  });

  it("gradeCostAbs penalizes by steepness regardless of direction", () => {
    const up = gradeCostAbs(edgeAt(4), "A", max);
    const down = gradeCostAbs(edgeAt(-4), "A", max);
    expect(up).toBe(down);
    expect(up).toBeGreaterThan(100);
  });

  it("gradeCostDirected is free downhill, penalized uphill", () => {
    const e = edgeAt(4);
    const uphill = gradeCostDirected(e, "A", max);
    const downhill = gradeCostDirected(e, "B", max);
    expect(downhill).toBe(100);
    expect(uphill).toBeGreaterThan(100);
  });

  it("gradeCostDirected blocks a too-steep climb but stays finite", () => {
    const e = edgeAt(9);
    const c = gradeCostDirected(e, "A", max);
    expect(c).toBeGreaterThan(BLOCKED);
    expect(Number.isFinite(c)).toBe(true);
  });
});

it("exports the default tuning constants", () => {
  expect(DEFAULT_K1).toBeGreaterThan(0);
  expect(DEFAULT_K2).toBeGreaterThan(0);
});
