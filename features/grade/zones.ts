// features/grade/zones.ts — roll per-edge grade up into bbox grid cells (spec §4).
import type { Graph } from "../routing/types";

/** Linear-interpolation percentile. `p` in [0,1]. Throws on empty input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export type ZoneCell = { bbox: [number, number, number, number]; value: number };

/**
 * Tile graph.bbox into gridN x gridN equal cells; assign each edge to the cell
 * containing its geometry midpoint; cell.value = p85 of its edges' absGradePct.
 * Empty cells are omitted. cell.bbox is [minLng,minLat,maxLng,maxLat].
 */
export function computeZones(graph: Graph, gridN: number): ZoneCell[] {
  const [minLng, minLat, maxLng, maxLat] = graph.bbox;
  const cellW = (maxLng - minLng) / gridN;
  const cellH = (maxLat - minLat) / gridN;
  const buckets = new Map<string, number[]>(); // "col,row" -> absGradePcts

  const clamp = (v: number) => Math.min(gridN - 1, Math.max(0, v));

  for (const e of graph.edges) {
    const first = e.geometry[0];
    const last = e.geometry[e.geometry.length - 1];
    const midLat = (first[0] + last[0]) / 2;
    const midLng = (first[1] + last[1]) / 2;
    const col = clamp(Math.floor((midLng - minLng) / cellW));
    const row = clamp(Math.floor((midLat - minLat) / cellH));
    const key = `${col},${row}`;
    const arr = buckets.get(key);
    if (arr) arr.push(e.absGradePct);
    else buckets.set(key, [e.absGradePct]);
  }

  const cells: ZoneCell[] = [];
  for (const [key, grades] of buckets) {
    const [col, row] = key.split(",").map(Number);
    cells.push({
      bbox: [
        minLng + col * cellW,
        minLat + row * cellH,
        minLng + (col + 1) * cellW,
        minLat + (row + 1) * cellH,
      ],
      value: percentile(grades, 0.85),
    });
  }
  return cells;
}
