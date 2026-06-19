# Sorting, searching & selection

**Industry names:** comparison sort · binary search · linear search · order
statistics / selection · quickselect · percentile / quantile. **Type:**
Industry standard. The repo sorts (in `percentile`) and linearly searches (in
`nearestNode`); binary search and quickselect are `not yet exercised` and are
the documented upgrades.

---

## Zoom out, then zoom in

Two places in `flattr` need to find or order things outside the graph search:
snapping a tapped coordinate to the nearest node, and rolling per-cell grades up
to a representative value for the heatmap. The first is a *search* (find the
min-distance node); the second is *sort + select* (the p85 of a cell's grades).

```
  Zoom out — where sorting/searching live

  ┌─ Input layer ──────────────────────────────────────────────────┐
  │  nearestNode(point) → linear search O(V)   ← ★ SEARCH            │
  │  features/routing/nearest.ts:5-18             (binary search gap)│
  └─────────────────────────┬────────────────────────────────────────┘
  ┌─ Aggregation layer ─────▼────────────────────────────────────────┐
  │  percentile(values, 0.85) → sort O(n log n) + interpolate         │
  │  features/grade/zones.ts:5-14              ← ★ SORT + SELECT       │
  │                                               (quickselect gap)   │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *do you need everything in order, or just one element?*
`percentile` sorts the whole array to read one rank — correct, but it does more
work than the question requires. `nearestNode` scans every node — correct for a
small graph, but a sorted structure plus binary search would prune it. Both are
right *today* and have a named cheaper form for *later*.

---

## The structure pass

**Layers.** Three operations stack by *how much order they need*:

```
  One question — "how much ordering work?" — across the operations

  ┌──────────────────────────────────────────────┐
  │ FULL SORT     → all n elements in order         │  O(n log n)  percentile (zones.ts)
  └────────────────────┬───────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ SELECTION     → just the k-th element      │  O(n) avg   quickselect (GAP)
       └───────────────┬─────────────────────────┘
           ┌───────────▼───────────────────────┐
           │ SEARCH        → just "is it / where"  │  O(log n) sorted / O(n) unsorted
           └─────────────────────────────────────┘   nearestNode = O(n) (no sort)
```

**Axis = work vs question.** Hold "how much do I actually need to know?"
constant. To find the median you need *selection*, not a full sort — but
`percentile` does a full sort anyway because it's simpler and `n` (edges per
grid cell) is small. To find the nearest node you need a *search*, and on
unsorted data that's linear; sort the coordinates once and it's `O(log n)`. The
seam in both cases: *is the data sorted?* If yes, search/select gets cheap; if no,
you either sort (amortize over many queries) or scan (one-off).

---

## How it works

### Move 1 — the mental model

You've called `.sort()` and `.indexOf()`. The lesson here is that those are the
*expensive* defaults, and the cheaper specialized versions — binary search,
quickselect — exist for when you don't need the full ordering they imply.

```
  The work/question ladder

  question                cheapest tool          cost
  ─────────────────────────────────────────────────────────
  "everything in order"   comparison sort        O(n log n)
  "the k-th element"      quickselect            O(n) average
  "where is x?" (sorted)  binary search          O(log n)
  "where is x?" (unsorted)linear scan            O(n)
  "the min" (one-off)     linear scan            O(n)   ← nearestNode does this

  doing MORE than the question needs is the waste this file teaches you to spot
```

### Move 2 — the moving parts

**Linear search — `nearestNode`.** `nearest.ts:7-15` walks every node, computes
haversine distance, tracks the running minimum. It's the find-the-min pattern:
`O(V)`, one pass, no preprocessing. Correct and *right* for a one-off query over a
small graph. The boundary where it breaks: a city-sized graph run twice per route
request — then you want a spatial structure (**04**) or sorted coordinates +
binary search.

```
  Linear min-search (nearest.ts:7-15)

  bestDist = ∞
  for each node:                         ← O(V), every node
     d = haversine(point, node)
     if d < bestDist: bestDist=d; best=node   ← keep the running winner
  return best

  no sort, no index — pays O(V) but pays it only once, zero setup
```

**Full comparison sort — inside `percentile`.** `zones.ts:7` does `[...values].sort((a,b)=>a-b)`
— a defensive *copy* then an ascending numeric sort. The copy matters: it
avoids mutating the caller's array (the cell's grade list). It's `O(n log n)`;
JS engines use an introsort/Timsort hybrid under the hood.

**Linear-interpolation selection — the rest of `percentile`.** Once sorted,
finding the p85 is index arithmetic (`zones.ts:8-13`): the rank `p*(n-1)` usually
lands *between* two indices, so it linearly interpolates between them. The
edge-case guards are the lesson — single element returns itself
(`zones.ts:10`), exact-integer rank skips interpolation (`zones.ts:12`). The test
`zones.test.ts:14` pins p85 of 1..10 = 8.65.

```
  percentile([1..10], 0.85)  (zones.ts:8-13)

  sorted = [1,2,3,4,5,6,7,8,9,10]   n=10
  rank   = 0.85*(10-1) = 7.65       ← lands between index 7 and 8
  lo=7 (val 8)  hi=8 (val 9)
  result = 8 + (9-8)*(7.65-7) = 8 + 0.65 = 8.65   ✓ (zones.test.ts:14)

  the interpolation IS the "linear-interpolation percentile" — without it you'd
  snap to 8 or 9 and lose precision on small samples
```

**Why this could be `O(n)` instead of `O(n log n)` — the selection gap.**
`percentile` only ever reads *one or two* elements of the sorted array (the
ranks around `p`). Sorting all `n` to read 2 is overkill. **Quickselect**
(partition like quicksort, but recurse into only the side containing your rank)
finds the k-th element in `O(n)` average without sorting the rest. The repo
doesn't use it because cell grade-lists are tiny — the `O(n log n)` sort is
faster in practice than quickselect's overhead at small `n`. That's the honest
call: the asymptotic win is real but doesn't pay off at this scale.

### Move 3 — the principle

**Don't sort to answer a question that selection or search can answer.** A full
sort is the reflexive default and usually more work than the question requires.
`flattr` sorts in `percentile` (justified — small `n`, simpler code) and scans in
`nearestNode` (justified — one-off, small graph). Knowing *why each is justified
at this scale* and *what the cheaper form is at larger scale* is the whole lesson.

---

## Primary diagram

The two operations, what they cost now, and their named cheaper forms.

```
  flattr's sort/search sites and their upgrade paths

  ┌─ nearestNode (nearest.ts:5-18) ────────────────────────────────┐
  │  linear scan O(V)  ──[V grows]──►  k-d tree O(log V)   (see 04)  │
  │                    ──[sorted axis]►  binary search O(log V)      │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ percentile (zones.ts:5-14) ───────────────────────────────────┐
  │  sort O(n log n) ──[large n]──►  quickselect O(n) avg            │
  │  + linear interpolation (the SELECT step, kept either way)       │
  └──────────────────────────────────────────────────────────────────┘
  both correct NOW (small inputs); the arrows are the documented upgrades
```

---

## Implementation in codebase

**Use cases.** Sorting happens once per grid cell when building the heatmap
(`zones.ts` → the choropleth in spec §7). Linear search happens twice per route
request (snap start, snap goal — `nearest.ts`). Neither is in a tight inner loop,
which is why the simpler forms are the right call.

```
  features/grade/zones.ts  (lines 5-14)  — percentile

  if (values.length === 0) throw new Error("percentile: empty input");
  const sorted = [...values].sort((a, b) => a - b);   ← COPY then sort O(n log n)
  if (sorted.length === 1) return sorted[0];          ← single-element guard
  const rank = p * (sorted.length - 1);               ← fractional rank
  const lo = Math.floor(rank); const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];                   ← exact-index guard
  return sorted[lo] + (sorted[hi]-sorted[lo])*(rank-lo);  ← interpolate
       │
       └─ the spread copy [...values] is load-bearing: .sort() mutates in place,
          and the caller (computeZones, zones.ts:53) passes the cell's live grade
          array. Without the copy, computing one cell's percentile would scramble
          the data. The throw on empty is why computeZones omits empty cells
          (zones.ts:44-57) — never calls percentile on []. (zones.test.ts:17-19)
```

```
  features/routing/nearest.ts  (lines 7-15)  — linear min-search

  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {  ← O(V) scan
    const d = haversine(point, {lat:n.lat, lng:n.lng});
    if (d < bestDist) { bestDist = d; bestId = id; }   ← running minimum
  }
       │
       └─ the find-the-min idiom: init to Infinity, keep the running winner.
          O(V) with zero setup beats a sorted index for a one-shot query on a
          small graph. The throw on no nodes (nearest.ts:16) mirrors percentile's
          empty guard. (nearest.test.ts:17-28)
```

---

## Elaborate

Comparison sorting has a proven `O(n log n)` lower bound (you can't beat it with
comparisons alone), which is why "just sort it" tops out there. Binary search
(documented by Knuth as famously hard to implement correctly — off-by-one bugs)
is `O(log n)` but *requires sorted input*, so it pairs with a one-time sort
amortized over many queries. Selection — finding the k-th element without sorting
— was solved by Hoare's quickselect (1961, `O(n)` average) and the
median-of-medians guarantee (Blum et al., 1973, `O(n)` worst case); percentiles
and medians are its canonical use. `flattr`'s `percentile` reaches for the
simpler full-sort because its inputs are small; the principle (don't over-order)
still holds. The spatial-search upgrade for `nearestNode` is **04** (k-d tree);
the connection to the graph is **05** (the snapped nodes are the search's
endpoints). Rein's `reincodes/utils/notes/Sorting/` already implements selection,
bubble, insertion, merge, quick, and heap sort from scratch — this repo is where
sorting shows up *applied*, in service of a percentile.

---

## Interview defense

**Q: "`percentile` sorts the whole array to read one rank. Wasteful?"**

Asymptotically, yes — quickselect finds the k-th element in `O(n)` average
without sorting the rest. But the inputs are tiny (grades per grid cell), where
the full sort's simplicity and small constant beat quickselect's overhead. The
right call at this scale; the upgrade is named for when cells get large.

```
  read 2 elements ← sort all n?   O(n log n)   ← what zones.ts does
  read 2 elements ← quickselect   O(n) avg     ← the upgrade at large n
  anchor: zones.ts:7 (sort) — justified by small n, not asymptotics
```

**Q: "Why is `nearestNode` a linear scan and not binary search?"**

Binary search needs sorted data; node coordinates are 2-D and unsorted. Sorting
costs `O(V log V)` up front, amortized only over many queries. For a one-off snap
on a small bbox graph, the `O(V)` scan with zero setup wins. When the graph grows,
a spatial index (k-d tree, **04**) — not 1-D binary search — is the real fix.

**Q: "Why the `[...values]` copy in `percentile`?"**

`.sort()` mutates in place, and the caller passes the cell's live grade array
(`zones.ts:53`). Sorting it in place would corrupt the source data for any later
read. The copy is the boundary that keeps `percentile` a pure function.

---

## Validate

1. **Reconstruct:** Write the find-the-min idiom from `nearest.ts:7-15` from
   memory; state its complexity in terms of `V`.
2. **Explain:** Why does `percentile` copy with `[...values]` before sorting
   (`zones.ts:7`)? What corrupts without it?
3. **Apply:** Compute `percentile([1,2,3,4], 0.5)` by hand using the interpolation
   in `zones.ts:8-13`. Check against `zones.test.ts:11-13`.
4. **Defend:** Argue when `percentile`'s full sort should become quickselect, and
   when `nearestNode`'s scan should become a spatial index — citing input size as
   the deciding factor.

---

## See also

- **04-trees-tries-and-balanced-indexes.md** — the spatial-index upgrade for `nearestNode`.
- **05-graphs-and-traversals.md** — the snapped nodes are the search endpoints.
- **01-complexity-and-cost-models.md** — `O(n log n)` vs `O(n)` vs `O(log n)`.
- **03-stacks-queues-deques-and-heaps.md** — a heap also answers "k smallest."
