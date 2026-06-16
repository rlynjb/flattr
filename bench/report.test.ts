import { describe, it, expect } from "vitest";
import { formatTable, type BenchRow } from "./report";

describe("formatTable", () => {
  it("renders a row per algorithm with aligned columns", () => {
    const rows: BenchRow[] = [
      { algorithm: "dijkstra", nodesExpanded: 4812, pushes: 9000, pops: 8000, ms: 12.3, cost: 1000 },
      { algorithm: "astar", nodesExpanded: 1107, pushes: 2200, pops: 2000, ms: 3.1, cost: 1000 },
    ];
    const out = formatTable("Pike->Broadway", rows);
    expect(out).toContain("Pike->Broadway");
    expect(out).toContain("dijkstra");
    expect(out).toContain("astar");
    expect(out).toContain("4812");
    expect(out).toContain("1000");
  });
});
