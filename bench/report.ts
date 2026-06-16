// Format benchmark rows into a comparison table.
export type BenchRow = {
  algorithm: string;
  nodesExpanded: number;
  pushes: number;
  pops: number;
  ms: number;
  cost: number;
};

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function formatTable(title: string, rows: BenchRow[]): string {
  const header =
    pad("algorithm", 16) +
    padLeft("expanded", 10) +
    padLeft("pushes", 9) +
    padLeft("pops", 9) +
    padLeft("ms", 9) +
    padLeft("cost", 12);
  const lines = rows.map(
    (r) =>
      pad(r.algorithm, 16) +
      padLeft(String(r.nodesExpanded), 10) +
      padLeft(String(r.pushes), 9) +
      padLeft(String(r.pops), 9) +
      padLeft(r.ms.toFixed(2), 9) +
      padLeft(r.cost.toFixed(2), 12)
  );
  return [title, header, ...lines].join("\n");
}
