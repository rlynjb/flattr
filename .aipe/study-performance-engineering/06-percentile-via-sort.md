# Percentile via Full Sort — the O(n) quickselect upgrade

**Industry name(s):** order statistic / selection; full-sort percentile vs
quickselect (Hoare's selection, `nth_element`). **Type:** Industry standard
(selection algorithm).

## Zoom out, then zoom in

The Zones overlay paints each grid cell by the p85 of its edges' grades. To read
one percentile, flattr sorts the entire array. That's O(n log n) to extract a
single value where O(n) selection would do. The arrays are small, so this isn't a
fire — it's the cleanest "do less work for the same answer" example in the repo.

```
  Zoom out — where the sort sits

  ┌─ UI (JS thread) ──────────────────────────────────────────┐
  │  MapScreen.tsx: zoneCells = computeZones(displayGraph, 16) │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ features/grade/zones.ts ─▼───────────────────────────────┐
  │  computeZones → per cell → ★ percentile(grades, 0.85) ★    │ ← we are here
  │  percentile: [...values].sort()  ← full sort for one value │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"what's the 85th-percentile grade in this cell?"* You
don't need the array sorted — you need one element at one rank. Sorting computes
the rank of *every* element to read *one*.

## Structure pass

**Layers.** Two nested costs:

```
  computeZones (bucket edges → cells)  →  percentile (one value per cell)
  O(E) bucketing                          O(c log c) per cell, c = edges in cell
```

**Axis: cost — "how much work to produce one cell's value?"**

```
  One question across the two approaches
  "ops to read p85 of c values?"

  full sort:    O(c log c)   computes ALL ranks, uses one   [now]
  quickselect:  O(c) avg     computes ONE rank              [fix]
```

**Seam.** The boundary is the `percentile` function (`zones.ts:5-14`). Everything
above it (bucketing edges into cells) is unchanged by the fix; only what happens
*inside* `percentile` changes. Clean, isolated swap.

## How it works

### Move 1 — the mental model

Finding the k-th smallest doesn't require a sorted list — it's the same idea as
quicksort's partition, but you only recurse into the *one* side that contains your
rank. You throw away half the work each step on average. Sorting is "order
everything"; selection is "find the one at position k."

```
  Selection vs sort — to read rank k

  SORT:        [....................]  fully ordered, read index k
               O(n log n), all ranks known

  QUICKSELECT: partition around pivot p
               [< p | p | > p]
                       │
               k in left? recurse left only   ← discard the other half
               k in right? recurse right only
               O(n) average, ONE rank known
```

### Move 2 — the walkthrough

**What flattr does now.** The percentile copies and fully sorts:

```ts
// features/grade/zones.ts:5-14  — full sort to read one rank
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);  // ← O(n log n) + a copy alloc
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);              // fractional rank for p
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);  // linear interp between neighbors
}
```

Two costs: the `[...values]` copy (O(n) allocation) and the `.sort()` (O(n log n)).
It then reads at most two elements (`lo`, `hi`) for the linear interpolation. So
~99% of the sort's output is discarded.

**Why it's small in practice.** `computeZones` (`zones.ts:23-58`) buckets edges
into a 16×16 grid (`GRID_N = 16`, `MapScreen.tsx:23`). With ~1879 base edges
spread over up to 256 cells, each cell's array is *tens* of grades, not thousands.
`tens × log(tens)` is nothing. And it runs only when the Zones view is active
(`MapScreen.tsx:125-128` gates the `useMemo` on `view === "zones"`). So the
absolute cost is low — this is flagged as waste, not a bottleneck.

```
  Execution trace — cost per cell, base graph

  cells (16x16)        up to 256, many empty (omitted, zones.ts:44)
  edges per cell c     ~tens (1879 edges / occupied cells)
  full sort per cell   O(c log c) ≈ tens of ops   → negligible TODAY
  total                bounded by O(E) bucketing, not the sorts
```

**The fix — quickselect.** Replace the sort with selection of the one (or two, for
interpolation) ranks. For interpolation between `lo` and `hi`, select rank `lo`,
then the min of the right partition gives `hi` — or just select both. The function
signature and the interpolation math stay identical; only the "get the element at
rank r" line changes from `sorted[r]` to `quickselect(values, r)`.

```ts
// the shape of the swap (pseudocode)
// percentile(values, p):
//   rank = p * (values.length - 1)
//   lo = floor(rank); hi = ceil(rank)
//   a = quickselect(values, lo)        // O(n) avg, partitions in place
//   b = (lo == hi) ? a : quickselect(values, hi)
//   return a + (b - a) * (rank - lo)
```

You've built the partition logic already — quicksort is in reincodes'
`utils/notes/Sorting/`. Quickselect is quicksort that recurses into one side only.

### Move 2.5 — current state vs future state

```
  Phase A (now): full sort          Phase B: quickselect
  ───────────────────────────       ──────────────────────
  [...values].sort()  O(c log c)    quickselect(values, k)  O(c) avg
  copy alloc + sort all             partition in place, one side
  fine: c = tens, gated on view     trigger: GRID_N drops (bigger cells)
                                    or zones recompute shows on a profile
  what doesn't change: percentile() signature, interp math, computeZones
```

The honest trigger: at `GRID_N = 16` over a base graph, cells are tiny and this
never matters. It becomes worth doing if cells get large — fewer/coarser cells, or
a much denser merged graph — pushing `c` into the thousands, *and* the zones
recompute (which is in a `useMemo` on the JS thread) shows up on a device profile.

### Move 3 — the principle

If you only need one element at one rank, don't compute the rank of every element.
Selection (O(n)) beats sorting (O(n log n)) for order statistics — that's the
generalizable swap. The meta-lesson here is judgment: flattr correctly *didn't*
pre-optimize this (the arrays are tiny, the sort is one readable line), and the
right call is to name it as the known O(n) upgrade gated on a measurement, not to
hand-roll quickselect for tens of elements today.

## Primary diagram

```
  Zones percentile — now vs fix

  ┌─ computeZones (zones.ts:23) ──────────────────────────────┐
  │  for each edge: bucket into cell by midpoint  (O(E))      │
  │  for each cell: value = percentile(grades, 0.85)          │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ NOW: percentile ─────────▼─────────┐  ┌─ FIX: quickselect ───────┐
  │  [...values].sort()   O(c log c)    │  │  quickselect(values, k)   │
  │  read sorted[lo], sorted[hi]        │  │  partition, recurse one   │
  │  ~99% of sort output discarded      │  │  side  O(c) avg           │
  └──────────────────────────────────────┘  └───────────────────────────┘
   trigger: c into the thousands (coarser GRID_N / denser graph) + profile hit
```

## Elaborate

Quickselect (Hoare, 1961) is the selection counterpart to quicksort; C++'s
`std::nth_element` and NumPy's `partition` are production versions. For a *single*
percentile, selection is the textbook answer; for *many* percentiles over the same
array, one sort amortizes better — so the right choice depends on how many ranks
you read per array. flattr reads two adjacent ranks per cell (for interpolation),
so selection still wins. This is the kind of micro-optimization a profiler would
rank near the bottom — correctly, which is why it sits at red-flag #4 in the audit,
flagged as the clean upgrade rather than a current problem.

## Interview defense

**Q: You sort a whole array to read one percentile — wasteful?**

> Yes, technically: it's O(n log n) to read one rank where quickselect is O(n).
> But the arrays are tens of grades per grid cell and the whole thing is gated on
> the Zones view being open, so the absolute cost is negligible — I left it as one
> readable line on purpose. The fix is a drop-in: swap `sorted[k]` for
> `quickselect(values, k)`, same signature, same interpolation. I'd do it when
> cells get large enough to show on a profile.

```
  read one rank → sort O(n log n)  [now]   →  quickselect O(n)  [if c grows]
```

Anchor: *selection beats sort for order statistics — but tiny n means leave it
until measured.*

**Q: When would the sort actually hurt?**

> When `c` (edges per cell) goes into the thousands — a coarser grid or a much
> denser merged graph — and the zones `useMemo` (which runs on the JS thread)
> shows on a device profile. The trigger is a number, not a hunch.

```
  c = tens → fine     c = thousands + JS-thread profile hit → quickselect
```

Anchor: *the upgrade is gated on a measured cell size, not pre-emptive.*

## See also

- `04-linear-nearest-node.md` — the other "naive now, named fix later" call.
- `08-render-thread-search-and-debounce.md` — zones recompute also runs on the JS thread.
- `audit.md` lens 4 (CPU), lens 8 (red flag #4).
- Cross-guide: `study-dsa-foundations` (quickselect from your quicksort).
