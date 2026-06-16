// features/grade/classify.ts — grade magnitude -> band -> color (spec §7).
// 3a uses fixed thresholds; 3b injects userMax-derived bands through the same seam.
export type Band = "green" | "yellow" | "red";

export type Bands = { greenMax: number; yellowMax: number };

/** Fixed placeholder thresholds (percent), pedestrian-ish (§10 Phase 1). */
export const DEFAULT_BANDS: Bands = { greenMax: 4, yellowMax: 8 };

/** Classify a steepness (abs grade %) into a color band. */
export function classifyAbs(absGradePct: number, bands: Bands = DEFAULT_BANDS): Band {
  const g = Math.abs(absGradePct);
  if (g <= bands.greenMax) return "green";
  if (g <= bands.yellowMax) return "yellow";
  return "red";
}

const COLORS: Record<Band, string> = {
  green: "#2e9e3f",
  yellow: "#e8b500",
  red: "#d23b2e",
};

export function bandColor(band: Band): string {
  return COLORS[band];
}
