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
