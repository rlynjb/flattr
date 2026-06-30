# Sorting, Searching & Selection

**Industry names:** comparison sort · binary search · quickselect /
partition-based selection · order statistics (percentile). **Type:** Industry
standard.

## Zoom out, then zoom in

flattr sorts in exactly one place — `zones.ts`, to read a percentile out of an
edge bucket — and it searches *linearly* everywhere (the `nearestNode` scan, the
heap's implicit ordering). It does **no binary search** and **no quickselect**,
and both absences are interesting. The percentile read in `zones.ts` full-sorts
an array to grab one order statistic, which is textbook quickselect territory.
And `nearestNode`'s linear scan is the place binary search *can't* help (it's
2-D) but a spatial structure could. This file is one real sort plus two
instructive gaps.

```
  Zoom out — sorting/selection in flattr: one real, two missing

  ┌─ Heatmap side path (grade/zones.ts) ──────────────────────┐
  │  computeZones → percentile(grades, 0.85)                  │ ★ real sort
  │     zones.ts:6   [...values].sort((a,b)=>a-b)             │
  └────────────────────────────────────────────────────────────┘

  not present:
    binary search    → no sorted-array bisection anywhere
    quickselect      → zones.ts full-sorts where partition-select would do
```

Zoom in: sorting is `O(n log n)`; selecting a *single* order statistic (the
p85, the median, the k-th smallest) is `O(n)` average with quickselect — you
don't need the whole array ordered to find one rank. flattr sorts the whole
thing. We'll teach why that's fine *here* and exactly where it wouldn't be.

## The structure pass

One real operation, two gaps. Trace the **"how much order do you actually
need"** axis.

```
  Axis: how much ordering does the task require?

  task                  needs           flattr does        ideal
  ───────────────────   ─────────────   ────────────────   ──────────────
  p85 of a bucket       ONE rank        full sort O(MlogM) quickselect O(M)
  nearest node          the min         linear scan O(N)   k-d tree O(logN)
  frontier order        the min, often  binary heap O(logn) ✓ correct
  lookup in sorted arr  one element     — (none exist)     binary search O(logn)
```

**The seam:** between "I need the data fully ordered" and "I need one element of
it." A full sort gives you *all* order statistics; quickselect gives you *one*.
flattr crosses that seam in `zones.ts` by full-sorting for a single percentile —
paying `O(M log M)` for an `O(M)` answer. At build-frequency that's a
non-issue; the seam only becomes load-bearing if percentile reads move hot.

## How it works

### Move 1 — the mental model

You've built all five comparison sorts in reincodes (selection, bubble,
insertion, merge, quick) with animated bar-swap visualizers — you *see* sorts
execute. The idea here is the inverse: **selection** is "sorting, but you stop
as soon as the one element you want is in place." A percentile is an order
statistic: the value at a specific rank. To get the p85 you only need the
element at rank `0.85·(n−1)` — you don't need the other 99% ordered.

```
  Sort vs select — full order vs one rank

  full sort:     [2,3,5,7,8,9,11,14]   all 8 in order, O(n log n)
                              ▲
  select p85:    only need ───┘ THIS element at rank 0.85·(n−1)
                 quickselect partitions toward it, O(n) average
                 — leaves the rest unordered, and that's fine
```

### Move 2 — the walkthrough

#### The one real sort — percentile in zones.ts

Here's the code, `zones.ts:5-14`:

```ts
// zones.ts:5-14 — linear-interpolation percentile via a full sort
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);   // FULL sort, O(M log M)
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);               // fractional rank
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];                   // exact rank
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);  // interpolate
}
```

Walk it:

- **`[...values].sort(...)`** — copies (so the caller's array isn't mutated)
  and sorts ascending. The `(a, b) => a - b` comparator is mandatory: JS's
  default `sort` is *lexicographic* (`"11" < "2"`), so numeric data needs the
  explicit numeric comparator. *Forget it and `[2, 11, 3].sort()` gives
  `[11, 2, 3]` — a real bug.*
- **`rank = p * (n − 1)`** — the fractional position of the p-th percentile.
  For p85 of 100 values that's `0.85 * 99 = 84.15`.
- **`lo`/`hi` + interpolate** — the rank usually lands between two elements, so
  linearly interpolate between them. `0.15` of the way from `sorted[84]` to
  `sorted[85]`.

```
  Execution trace — percentile([4,1,9,3,7], 0.85)

  sort:  [1, 3, 4, 7, 9]            ← O(5 log 5)
  rank = 0.85 * 4 = 3.4
  lo = 3, hi = 4   (rank lands between sorted[3]=7 and sorted[4]=9)
  result = 7 + (9 − 7) * (3.4 − 3)
         = 7 + 2 * 0.4 = 7.8
```

This feeds `computeZones` (`zones.ts:54`): each grid cell's value is the p85 of
its edges' `absGradePct` — "how steep is the steep end of this neighborhood,"
which is what the heatmap colors.

#### Why the full sort is fine here — and where it wouldn't be

The honest read: this is `O(M log M)` to extract one number you could get in
`O(M)` with quickselect. It's the right call anyway, for two reasons:

```
  When full-sort-for-one-percentile is fine vs not

  ┌─ FINE (flattr today) ──────────┐  ┌─ NOT FINE ─────────────────┐
  │ runs at BUILD time / map load  │  │ runs per-frame or per-pan   │
  │ M = edges in one grid cell     │  │ M = millions of edges       │
  │   (small — bucketed by zones)  │  │ percentile recomputed live  │
  │ → O(M log M) is microseconds   │  │ → quickselect O(M) matters  │
  └────────────────────────────────┘  └─────────────────────────────┘
```

`computeZones` runs when the heatmap is built, not in the routing hot path, and
each bucket holds only the edges whose midpoint fell in that grid cell — already
small. Full-sort is simpler, obviously correct, and fast enough. Quickselect
would be premature optimization. **The judgment is the lesson: full sort when M
is small and the call is cold; reach for quickselect only when you're reading
one rank out of a large array, repeatedly.**

#### Binary search — not yet exercised, and why

Binary search bisects a *sorted* array to find an element in `O(log n)`. flattr
has **none** — `grep` the routing and grade code and there's no `lo`/`hi`/`mid`
bisection loop anywhere (the `lo`/`hi` in `percentile` are rank floor/ceil, not
a search). Why it's absent:

```
  Binary search needs a sorted array + a 1-D key. flattr has neither.

  nearestNode:  2-D points (lat, lng)  → binary search can't bisect 2-D
                                          (k-d tree handles 2-D, file 04)
  routing:      graph traversal, not array lookup
  percentile:   computes a rank directly, no element-search needed
```

Binary search would show up the moment flattr keeps a *sorted 1-D array it
looks elements up in* — e.g. an elevation lookup table, or sorted edge lengths
for a histogram query. It doesn't today. `not yet exercised`.

#### Quickselect — not yet exercised, the direct upgrade path

Quickselect is the partition step of quicksort (which you've built) applied to
*one* target rank: pick a pivot, partition, recurse only into the side holding
your rank. `O(n)` average. It's the exact structure that would replace the
`zones.ts` full sort.

```
  Quickselect — partition toward the target rank, ignore the rest

  find rank 84 in M values:
    pick pivot → partition: [< pivot | pivot | ≥ pivot]
    pivot landed at index 60?  rank 84 is on the RIGHT
       → recurse only the right side  (drop the left, never sort it)
    repeat until pivot index === target rank
  average O(M), vs full sort O(M log M)
```

You already have the partition logic in your quicksort visualizer; quickselect
is that partition with a "recurse one side only" stop condition. It's the
single cleanest "you've built 90% of this already" upgrade in flattr. `not yet
exercised` — the practice map (`08`) ranks it.

### Move 3 — the principle

The amount of *order* you need decides the algorithm. Need everything ordered →
sort, `O(n log n)`. Need one rank → select, `O(n)`. Need one element from
already-sorted data → binary search, `O(log n)`. flattr only ever needs one
rank (`zones.ts`) and accepts the full sort because the input is small and
cold — a correct application of "don't optimize what isn't hot." The
generalizable move: before sorting, ask whether you need the *whole* order or
*one element of it* — and only pay for what you'll use. flattr pays a little
extra here on purpose, and that's defensible; the skill is knowing it's a
choice.

## Primary diagram

flattr's sort/search/select landscape in one frame.

```
  Sorting, searching, selection in flattr

  PRESENT
  ┌──────────────────────────────────────────────────────────┐
  │  percentile()  zones.ts:6   full sort O(M log M)          │
  │    → p85 of a grid cell's grades → heatmap color          │
  │    numeric comparator (a,b)=>a-b  (avoids lexicographic)  │
  │                                                            │
  │  PQueue ordering  pqueue.ts   "search by min" via heap    │
  │    (covered in file 03 — it's the frontier, not a sort)   │
  └──────────────────────────────────────────────────────────┘

  NOT YET EXERCISED
  ┌──────────────────────────────────────────────────────────┐
  │  quickselect  →  zones.ts percentile (one rank, O(M))     │ ← direct upgrade
  │  binary search → no sorted 1-D array to look up in        │
  │  nearest-node  →  k-d tree, not binary search (2-D)       │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Comparison sorts bottom out at `O(n log n)` (the decision-tree lower bound);
quickselect (Hoare, 1961 — same Hoare as quicksort) breaks below that for a
*single* order statistic because it never orders the parts it discards, hitting
`O(n)` average (`O(n)` worst-case with median-of-medians pivoting). Binary
search (the bisection idea is ancient; the off-by-one bugs are eternal) is the
canonical `O(log n)` lookup and the reason sorted data is worth maintaining.
flattr touches only the sort, and only at the cold edge of the system — which is
exactly the profile where reaching for the cleverer selection algorithm would be
the wrong instinct. The interview-grade insight is recognizing that
`percentile`'s full sort *could* be quickselect, and being able to say why it
isn't worth changing yet.

Read next: `04` (the k-d tree that handles the 2-D nearest-node case binary
search can't) and `05` (the optimality oracle, a differential "selection" of the
correct path).

## Interview defense

**Q: `percentile` full-sorts to read one value. Is that wasteful?**

Asymptotically yes — it's `O(M log M)` for an `O(M)` answer you could get with
quickselect. In context it's the right call: `computeZones` runs at heatmap
build time, not in the routing hot path, and each bucket is already small
because `zones.ts` pre-buckets edges by grid cell. Full sort is simpler and
obviously correct. I'd swap in quickselect only if percentile reads moved into a
per-frame or per-pan path over large buckets.

```
  cold + small M  → full sort O(M log M) is fine
  hot + large M   → quickselect O(M), partition toward the one rank
```

Anchor: "match the algorithm to how much order you need — one rank wants
select, not sort — but only optimize the hot path."

**Q: Why the explicit `(a, b) => a - b` comparator?**

JS's default `Array.sort` is lexicographic on stringified elements, so
`[2, 11, 3].sort()` returns `[11, 2, 3]` — wrong for numbers. The numeric
comparator at `zones.ts:6` forces ascending numeric order. Without it the
percentile would read off a string-sorted array and return garbage.

Anchor: "default JS sort is lexicographic — numeric data *always* needs the
comparator."

## See also

- `04-trees-tries-and-balanced-indexes.md` — k-d tree for the 2-D nearest case.
- `01-complexity-and-cost-models.md` — the `O(M log M)` vs `O(M)` cost classes.
- `05-graphs-and-traversals.md` — the A*==Dijkstra differential oracle.
- `08-dsa-foundations-practice-map.md` — quickselect and binary search as
  ranked gaps.
