// features/grade/classify.ts — grade magnitude -> band -> color (spec §7).
// 3a uses fixed thresholds; 3b injects userMax-derived bands through the same seam.
export type Band = "green" | "yellow" | "red" | "grey";

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
  grey: "#9aa0a6",
};

export function bandColor(band: Band): string {
  return COLORS[band];
}

/**
 * Classify a SIGNED directed grade against userMax (spec §7):
 * downhill/flat -> green (free); 0..0.5*max -> yellow; 0.5*max..max -> red; >max -> grey.
 */
export function classifyDirected(directedGradePct: number, userMax: number): Band {
  if (directedGradePct <= 0) return "green";
  if (directedGradePct > userMax) return "grey";
  if (directedGradePct <= 0.5 * userMax) return "yellow";
  return "red";
}

/** Heatmap abs-grade bands derived from userMax — "where red begins" is the user's number. */
export function bandsForUserMax(userMax: number): Bands {
  return { greenMax: 0.5 * userMax, yellowMax: userMax };
}

/** Preset max-grade choices (spec §7). */
export const USERMAX_PRESETS: { label: string; userMax: number }[] = [
  { label: "Kick scooter", userMax: 5 },
  { label: "Walking", userMax: 8 },
  { label: "Any", userMax: 15 },
];
