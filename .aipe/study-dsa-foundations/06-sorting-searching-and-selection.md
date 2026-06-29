# Sorting, Searching & Selection

**Industry names:** comparison sort, binary search, quickselect, order
statistics, percentile / quantile, linear scan. **Type:** Industry
standard.

---

## Zoom out — where this concept lives

flattr sorts in exactly one place — the grade heatmap's percentile
calculation — and it does it the expensive way: a full sort to find one
order statistic. Everywhere else it scans linearly. So this file has a
clear shape: one real sort to walk, and two pointed gaps (binary search,
quickselect) named where they'd belong.

```
  Zoom out — sorting/searching across flattr

  ┌─ Aggregate layer (build-time) ──────────────────────────────┐
  │  zones.ts  percentile()  → full sort, index out p85    ★   │ ← we are here
  └──────────────────────────────────────────────────────────────┘
  ┌─ Search/snap layer (runtime) ───────────────────────────────┐
  │  nearest.ts  linear scan (no binary search — unsorted data) │
  │  astar.ts    heap-ordered, not sorted (file 03)             │
  └──────────────────────────────────────────────────────────────┘
  ┌─ not yet exercised ─────────────────────────────────────────┐
  │  binary search   → would need sorted arrays (none kept)     │
  │  quickselect     → would replace zones.ts full sort         │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The one sort is `percentile()` in `zones.ts`: sort the
grades, interpolate at rank `p·(n-1)`. Correct and readable. Then the two
selection/search techniques the repo doesn't reach for, and exactly when
each would pay off.

---

## Structure pass — one axis across ordering operations

The axis is **how much order do you actually need, and how much do you
pay for?**

```
  Axis: "how much ordering does the task need vs what it buys?"

  full sort      O(n log n)  → total order   zones.ts: needs only ONE value
  selection      O(n) avg    → kth element   what p85 actually needs
  binary search  O(log n)    → needs sorted input first
  linear scan    O(n)        → no order needed  nearest.ts, fine for unsorted
```

The seam: `zones.ts` buys a *total order* (`O(n log n)`) when it only
needs *one order statistic* — the 85th percentile. That's the gap between
sorting and selection, and it's the cleanest "you paid for more order than
you needed" example in the repo.

---

## How it works

### Move 1 — the mental model

Sorting and selection are different questions that get confused. "Sort
these grades" gives you all of them in order. "What's the 85th percentile
grade" needs only *one* of them — the value at a specific rank. You can
answer the second without doing the first, and selection is the algorithm
that does.

```
  Sort vs select — same data, different question

  grades: [4, 1, 9, 2, 7, 3]

  full sort → [1, 2, 3, 4, 7, 9]   ← all ordered (O(n log n))
                       ▲
  selection → just find the rank-k element, O(n) avg
              (partition around pivots, recurse into one side only)
```

flattr asks the *selection* question ("p85") but uses the *sort* answer.
For a build-time heatmap over a handful of edges per cell, that's a fine
call — but knowing it's a sort-where-select-would-do is the literacy.

### Move 2 — the one sort, then the two gaps

#### `percentile()` — full sort + linear interpolation

The grade heatmap rolls each grid cell's edges up to a single number: the
85th percentile of their `absGradePct`. Here's how it's computed:

```ts
// features/grade/zones.ts:5-14
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);   // ← FULL O(n log n) sort
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);               // fractional rank
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];                   // exact integer rank
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo); // interpolate
}
```

Execution trace — `percentile([4,1,9,2,7,3], 0.85)`:

```
  percentile trace (p=0.85, n=6)

  sort:   [1, 2, 3, 4, 7, 9]                      O(n log n)
  rank:   0.85 * (6-1) = 4.25                     fractional position
  lo=4, hi=5  (lo != hi → interpolate)
  result: sorted[4] + (sorted[5]-sorted[4])*(4.25-4)
        = 7 + (9 - 7)*0.25
        = 7.5                                     the p85 grade
```

The interpolation matters: a percentile rarely lands on an exact array
index (`4.25` here), so it linearly blends the two straddling values. This
is the standard "linear interpolation between closest ranks" percentile
definition. It's correct. The `.sort((a,b)=>a-b)` is the part to flag —
it's `O(n log n)` to extract one value.

```
  Comparison — full sort (actual) vs quickselect (the lean version)

  ┌─ zones.ts now: full sort ───────┐  ┌─ quickselect: select rank k ────┐
  │ sort ALL grades  O(n log n)     │  │ partition around pivot           │
  │ then index [4] and [5]          │  │ recurse into the side with rank k│
  │ produces total order, uses 2    │  │ O(n) average, O(n²) worst        │
  │ values of it                    │  │ finds the straddling values only │
  └─────────────────────────────────┘  └──────────────────────────────────┘
```

**Is it worth fixing?** Honestly, no — not here. `zones.ts` runs at
*build time* over a small number of edges per cell, and the sort is dwarfed
by the OSM/elevation pipeline around it. The readability of `.sort()` beats
a hand-rolled quickselect for a non-hot path. But it's the textbook
"sort-to-select" pattern, and recognizing it is the point — if this ran in
a runtime hot loop over thousands of values, quickselect would be the move.

#### not yet exercised — binary search

No binary search anywhere in the repo. Binary search needs **sorted input**
that stays sorted, and flattr keeps no such structure: `graph.nodes` is a
hash map (unordered), `graph.edges` is an insertion-ordered array, and
`percentile` sorts a throwaway copy it never reuses.

```
  Where binary search WOULD belong (if data were kept sorted)

  nearest.ts    if nodes were sorted by one coordinate, binary-search
                the lng band, then scan a narrow strip → faster than O(N)
                (but a grid/k-d index is the better fix — file 04)

  percentile    the sort is already done; the index lookup IS the
                "binary search result" — you compute the rank directly
```

The honest verdict: binary search isn't missing because of an oversight —
it's missing because **nothing in the repo maintains sorted order to
search over.** It becomes relevant the moment you keep a sorted index
(e.g., nodes sorted by latitude for a strip-based nearest-neighbor).

#### not yet exercised — quickselect

Quickselect is the selection algorithm `zones.ts` *should* use if the
percentile ever moved to a hot path. It's quicksort that only recurses
into the side containing the target rank:

```
  Quickselect — the partition skeleton (NOT in repo)

  select(arr, k):
    pivot = pick one
    partition arr → [< pivot] [pivot] [> pivot]
    if k in left:   recurse left      ── only ONE side, not both
    if k == pivot:  return pivot
    if k in right:  recurse right
  → O(n) average (each step halves the work), O(n²) worst-case
```

You've already built the partition logic — it's the heart of quicksort in
your reincodes sorting visualizers (`utils/notes/Sorting/`). Quickselect is
quicksort with one recursive call deleted. That's the "you've already built
X" anchor: you have the partition; selection is half of the sort you
animated.

### Move 3 — the principle

Match the algorithm to the *question*, not the data. "Give me the 85th
percentile" is a selection question; answering it with a full sort works
but pays `O(n log n)` for an `O(n)` job. The discipline is to notice when
you're computing a total order and only using a sliver of it — sometimes
the sort is fine (build-time, small n, readability wins, like `zones.ts`),
and sometimes it's the bottleneck (hot path, large n). Knowing which is
which is the skill; the algorithms (sort, quickselect, binary search) are
just the tools you pick *after* you've named the question.

---

## Primary diagram

The one sort and the two gaps, with the rank math, in one frame.

```
  Sorting / searching / selection in flattr

  ┌─ zones.ts percentile() — the one real sort ─────────────────┐
  │  sorted = values.sort((a,b)=>a-b)        O(n log n)         │
  │  rank   = p * (n-1)                       fractional         │
  │  result = interpolate(sorted[lo], sorted[hi], rank-lo)      │
  │  → returns ONE order statistic from a TOTAL order   ★ slack │
  └──────────────────────────────────────────────────────────────┘
  ┌─ not yet exercised ─────────────────────────────────────────┐
  │  quickselect   → would give the p85 in O(n) avg (partition) │
  │  binary search → needs a sorted index the repo doesn't keep │
  │  (linear scans in nearest.ts/astar.ts are over unordered    │
  │   data — correct; the fix there is indexing, not searching) │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Quickselect is Hoare's (1961), the selection sibling of his quicksort —
same partition, one fewer recursion. Median-of-medians (Blum et al., 1973)
makes it `O(n)` worst-case. The "linear interpolation between closest
ranks" percentile in `zones.ts` is one of the nine standard quantile
definitions (it's NumPy's default, `linear`). You've built all five
elementary sorts plus the partition logic in reincodes
(`utils/notes/Sorting/`) with animated visualizers — so quickselect is the
shortest hop from what you've already done: take quicksort, recurse one
way. Binary search is the other half of the "search a sorted thing" coin,
and the reason it's absent is genuinely structural — flattr keeps nothing
sorted to search. Read file 04 for the spatial index that fixes
`nearest.ts` more directly than binary search would, file 08 for the
ranked practice plan.

---

## Interview defense

**Q: `zones.ts` sorts to get one percentile. Is that the right call?**

```
  full sort O(n log n) → total order → use 2 values  (actual)
  quickselect O(n) avg → just rank k → use 2 values  (leaner)
```

*Model answer:* "It's sort-to-select — `O(n log n)` for what's really an
`O(n)` selection problem, since p85 only needs the values straddling
rank `0.85·(n-1)`. Quickselect would do it in linear average time. But
here it's the right call: `zones.ts` runs at build time over a small
number of edges per cell, dwarfed by the elevation pipeline, and `.sort()`
is far more readable than a hand-rolled quickselect. I'd only switch if it
moved to a runtime hot path over large arrays."

*Anchor:* it's the textbook sort-to-select pattern; fine at build time,
wrong in a hot loop.

**Q: Why no binary search anywhere?**

*Model answer:* "Binary search needs maintained sorted order, and the repo
keeps none — nodes are in a hash map, edges in an insertion-ordered array,
and `percentile` sorts a throwaway copy. The nearest-node lookup that
*looks* like it wants binary search is better served by a spatial index
(grid or k-d tree), because the data is 2D — binary search is 1D. So
binary search isn't an oversight; there's just no sorted structure for it
to run on yet."

*Anchor:* binary search is absent because nothing is kept sorted; the 2D
lookup wants a spatial index, not binary search.

---

## See also

- `04-trees-tries-and-balanced-indexes.md` — the spatial index that fixes
  `nearest.ts` (the better answer than binary search).
- `01-complexity-and-cost-models.md` — the `O(n log n)` vs `O(n)` framing.
- `08-dsa-foundations-practice-map.md` — quickselect as a practice build.
- sibling **performance-engineering** — when build-time vs hot-path
  matters.
