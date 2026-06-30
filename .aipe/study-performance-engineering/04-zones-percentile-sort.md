# Zones percentile via full sort — O(n log n) where O(n) exists

> Industry name: **full-sort percentile**, replaceable by **quickselect /
> nth_element (O(n) selection)**. Type: Industry standard.

The coarse terrain overlay buckets edges into grid cells and colors each cell by
the 85th-percentile grade of its edges. To get p85 it sorts the whole cell array.
Sorting to pick one rank is O(n log n) where selection is O(n). This is the
lowest-priority finding in the audit — named for completeness, not urgency.

## Zoom out — where this concept lives

`computeZones` runs in the mobile render path, gated behind the "zones" view
toggle, calling `percentile` once per non-empty grid cell.

```
  Zoom out — percentile in the zones overlay

  ┌─ Mobile (MapScreen.tsx) ──────────────────────────────────┐
  │  zoneCells = useMemo(computeZones(displayGraph, 16),       │ ← only in zones view
  │              [displayGraph, view])  // GRID_N = 16         │
  └──────────────────────────┬─────────────────────────────────┘
                             │ calls
  ┌─ features/grade/zones.ts ─▼───────────────────────────────┐
  │  computeZones: bucket edges → per cell:                    │
  │  ★ percentile(grades, 0.85) — full sort, then index        │ ← we are here
  └────────────────────────────────────────────────────────────┘
```

Zoom in: you want the 85th-percentile value of an array. The repo sorts the array
ascending and reads the index at rank `0.85 * (n-1)`. That works and it's correct —
it's just doing O(n log n) of ordering when you only needed one element placed.

## Structure pass — the skeleton

**Axis traced: cost to extract one percentile.** Full ordering vs single
selection — the seam is the sort.

```
  One axis — "cost to get p85" — across the sort seam

  ┌─ percentile() ────────────────────────────────────────────┐
  │  [...values].sort()  → O(n log n)  ← orders ALL of it      │
  │  then index rank 0.85*(n-1)                               │
  └──────────────────────────┬─────────────────────────────────┘
        seam: replace sort with selection
  ┌─ quickselect ────────────▼────────────────────────────────┐
  │  partition around the rank → O(n) average                 │
  └────────────────────────────────────────────────────────────┘
```

The seam is "do you need everything ordered, or just one element at its final
rank?" The answer here is the latter, so the full sort is wasted ordering.

## How it works

### Move 1 — the mental model

To find the median (or any percentile) of an array, the obvious move is sort then
index. The faster move is quickselect: the partition step from quicksort, but you
only recurse into the side that contains your target rank — so on average you touch
each element a constant number of times, O(n), never fully ordering the array.

```
  The pattern — sort-then-index vs select-the-rank

  sort:    [3 1 4 1 5 9 2 6]  → sort → [1 1 2 3 4 5 6 9] → index    O(n log n)
  select:  partition around target rank, recurse ONE side only      O(n) avg
                                          ↑ never orders the rest
```

The part that "breaks" if you only care about the rank: nothing breaks
correctness-wise — sort is correct. What breaks is efficiency, and only at scale.
Per-cell arrays here are small, so the breakage is theoretical, which is why this is
LOW priority.

### Move 2 — the walkthrough

**The sort.** `percentile` copies, sorts ascending, and interpolates at the rank:

```ts
// features/grade/zones.ts:5-14 — full-sort percentile
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);   // ← O(n log n), orders everything
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);  // linear interp
}
```

The `[...values].sort()` also allocates a copy — fine and correct (don't mutate the
caller's array), but it's an allocation per call.

**Where it's called.** Once per non-empty cell, in `computeZones`:

```ts
// features/grade/zones.ts:44-56 — percentile per cell
for (const [key, grades] of buckets) {     // buckets = non-empty cells of a 16x16 grid
  // ...
  cells.push({ bbox: [...], value: percentile(grades, 0.85) });  // ← sort per cell
}
```

The grid is `GRID_N = 16` (`MapScreen.tsx:23`), so at most 256 cells, and each
cell's `grades` array holds only the edges whose midpoint fell in that cell. So
`n` per call is small — the edges of the display graph spread across up to 256
buckets. The total work is bounded and only runs in zones view, behind a `useMemo`
(`MapScreen.tsx:125-128`).

```
  Scale check — why this is LOW priority

  display graph edges ──spread──▶ ≤256 cells (16×16)
  per cell: sort a SMALL array → O(n log n) on small n
  runs: only in "zones" view, memoized on [displayGraph, view]
  → real cost is negligible today; named for completeness
```

### Move 3 — the principle

When you need one order statistic, selection (O(n)) beats sorting (O(n log n)) —
that's the textbook win, and it's real at scale. But the engineering judgment is
recognizing when the win doesn't matter: small per-cell arrays, gated behind a view
toggle, memoized. flattr's full sort is the right call here precisely *because* the
inputs are small — quickselect would add code and a from-scratch partition routine
to save microseconds nobody can feel. The finding is honest both ways: the
asymptotic improvement exists, and it isn't worth taking yet.

## Primary diagram

```
  Zones percentile — full recap

  ┌─ MapScreen.tsx:125-128 — only in zones view, memoized ────┐
  │  computeZones(displayGraph, GRID_N=16)                    │
  └──────────────────────────┬─────────────────────────────────┘
                             │ per non-empty cell
  ┌─ zones.ts percentile() ──▼────────────────────────────────┐
  │  [...grades].sort()  → O(n log n)  ← orders whole array    │
  │  index/interpolate at rank 0.85*(n-1)                     │
  │                                                            │
  │  n is SMALL (edges / ≤256 cells) → cost negligible today  │
  │  FIX (if n grows): quickselect → O(n), no full ordering   │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Quickselect (Hoare, 1961) is quicksort's partition without the second recursion:
to find the k-th element, partition, then recurse only into the side containing k.
Average O(n), worst O(n²) (mitigated by median-of-medians or random pivots).
`std::nth_element` in C++ and `numpy.partition` are the library versions. The
percentile interpolation flattr uses (linear between the two bracketing ranks) is
the standard "linear" method — quickselect would need to find both bracketing
elements, slightly more than a single-rank select but still O(n). Not worth it until
the per-cell arrays get large, which would require either a much finer grid or a far
denser graph. See `study-dsa-foundations` for quickselect as an algorithm.

## Interview defense

**Q: You sort to get one percentile — isn't that wasteful?**

Asymptotically, yes — sorting is O(n log n) to extract a single order statistic that
quickselect gets in O(n). But here the inputs are tiny: the display graph's edges
spread across up to 256 grid cells, so each `percentile` call sorts a small array,
and the whole thing only runs in the zones view behind a memo. The wasted ordering
is microseconds. I'd reach for quickselect if the per-cell arrays grew large — a much
finer grid or a far denser graph — not at this scale.

```
  small n: sort vs select → both instant → sort wins on simplicity
  large n: sort O(n log n) vs select O(n) → select wins
  flattr is in the small-n regime
```

Anchor: *"selection beats sort for one rank — but only once n is big enough to
feel it; here it isn't."*

## See also

- `03-linear-nearest-node-scan.md` — the higher-priority latent CPU cliff.
- `audit.md` lens 4 (CPU), R5 (this finding, lowest priority).
- `study-dsa-foundations` — quickselect / nth-element as algorithms.
