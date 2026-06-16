import type { CostFn } from "./types";
import { directedGrade } from "./graph";

/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;

// Tunable. k1 scales the moderate band; k2 the quadratic steep band.
export const DEFAULT_K1 = 0.4;
export const DEFAULT_K2 = 1.0;

/**
 * Penalty multiplier for a SIGNED directed grade `g` (percent) against `max` (percent).
 * downhill/flat -> 0 | moderate uphill -> linear | steep uphill -> quadratic | over max -> BLOCKED.
 * Continuous at the 0.5*max boundary by construction.
 */
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;
  if (g > max) return BLOCKED;
  const half = 0.5 * max;
  if (g <= half) return k1 * g;
  return k2 * (g - half) ** 2 + k1 * half;
}

/** Pure distance — Dijkstra/A* baseline. */
export const distanceCost: CostFn = (edge) => edge.lengthM;

/** Undirected steepness penalty — symmetric, A->B == B->A. */
export const gradeCostAbs: CostFn = (edge, _fromNodeId, userMax) =>
  edge.lengthM * (1 + penalty(edge.absGradePct, userMax));

/** Directional penalty — free downhill, penalized uphill. */
export const gradeCostDirected: CostFn = (edge, fromNodeId, userMax) =>
  edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
