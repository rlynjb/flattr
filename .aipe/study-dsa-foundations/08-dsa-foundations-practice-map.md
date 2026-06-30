# DSA Foundations — Practice Map

**Industry names:** the ranked learning plan — exercised concepts first, missing
foundations second. **Type:** Project-specific.

## Zoom out, then zoom in

This is the audit file. It ranks two things: what flattr *already exercises*
(so you can defend it cold in an interview, anchored to real files) and what it
*doesn't* (so you practice the highest-leverage gaps in order). The ranking
axis is **consequence** — for exercised concepts, how load-bearing it is to the
router; for gaps, how much flattr would actually gain from building it.

```
  Zoom out — the practice map sits above the whole guide

  ┌─ EXERCISED (defend these) ────────────────────────────────┐
  │  graph search · heap · cost model · hash structures ·     │
  │  iterative reconstruction · percentile sort               │
  └────────────────────────────┬──────────────────────────────┘
                               │ ranked by load-bearing weight
  ┌─ GAPS (practice these) ────▼──────────────────────────────┐
  │  k-d tree · quickselect · decrease-key · union-find ·     │
  │  binary search · trie · DP                                │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the through-line of this whole study guide — *which reusable
structures explain flattr, and which gaps should you deliberately practice.*
This file answers both, ranked, with the "you've already built X" anchor pulled
from your reincodes portfolio wherever it applies.

## The structure pass

Two tiers, one axis: **consequence**. Exercised concepts ranked by how much the
router depends on them; gaps ranked by leverage (how much flattr would gain ×
how close you already are to building it).

```
  Axis: consequence — what's load-bearing, what's high-leverage to add

  EXERCISED          load-bearing weight    your reincodes anchor
  ───────────────    ───────────────────    ──────────────────────
  graph search       ★★★ the spine          Graph2.ts (Dijkstra)
  binary heap        ★★★ frontier engine    BinaryHeap.ts, PriorityQueue.ts
  cost model         ★★★ correctness        (new — the BLOCKED trick)
  hash structures    ★★  bookkeeping        Graph.ts (adj list)
  reconstruction     ★★  iterative walk     BST iterative delete
  percentile sort    ★   cold side-path     Sorting/ (all 5 sorts)

  GAP                leverage               your reincodes anchor
  ───────────────    ───────────────────    ──────────────────────
  k-d tree           ★★★ felt (nearest)     — (closest: zones grid)
  quickselect        ★★  direct upgrade     quicksort partition (have it!)
  decrease-key       ★★  alt to lazy-del    PriorityQueue.updatePriority (have it!)
  union-find         ★   would enable        — (new)
  binary search      ★   no 1-D sorted arr  — (new)
  trie               ★   autocomplete       — (new)
  dynamic prog.      —   doesn't fit        recursion+memo (have the shape)
```

**The seam:** the line between tier 1 and tier 2 is the line between "can
defend with a file path" and "have to say 'I'd build it like this.'" Both are
interview-valuable; the first proves you shipped it, the second proves you know
when to reach for it.

## How it works

### Move 1 — the mental model

Think of this like a code review of your own DSA coverage: a column of "ship it,
here's the file" and a column of "here's the ticket I'd open next, ranked." The
shape:

```
  The practice map — two ranked columns

  DEFEND (anchored to files)        PRACTICE (ranked by leverage)
  ┌────────────────────────┐        ┌────────────────────────────┐
  │ search() astar.ts:22   │        │ 1. k-d tree → nearest.ts:8 │
  │ PQueue   pqueue.ts      │        │ 2. quickselect → zones.ts  │
  │ cost.ts  penalty/BLOCKED│   →    │ 3. decrease-key heap        │
  │ adjacency graph.ts      │        │ 4. union-find               │
  │ reconstruct astar.ts:86 │        │ 5. binary search            │
  │ percentile zones.ts     │        │ 6. trie · 7. DP             │
  └────────────────────────┘        └────────────────────────────┘
```

### Move 2 — the walkthrough

#### Tier 1 — exercised, ranked by load-bearing weight (defend these)

**1. Graph search — `search()` (`astar.ts:22-78`).** ★★★ The spine. One
parametric loop = Dijkstra + A* + grade-A* + directed-A*. You've built Dijkstra
in `Graph2.ts`; flattr generalizes it with pluggable cost/heuristic. *Defense
anchor:* "four algorithms, one loop, pinned optimal by an A*==Dijkstra
differential test." → `05`.

**2. Binary min-heap — `PQueue` (`pqueue.ts`).** ★★★ The frontier engine.
Array-as-tree, siftUp/siftDown, lazy deletion, NaN guard, invariant oracle.
You've built this twice (`BinaryHeap.ts`, `PriorityQueue.ts`). *Defense anchor:*
"lazy deletion instead of decrease-key — generic heap, traded heap size for not
coupling it to its items." → `03`.

**3. Cost model — `penalty` + `BLOCKED` (`cost.ts`).** ★★★ A correctness
invariant, not just a formula. `BLOCKED = 1e9` (finite) keeps "no flat route"
distinct from "no route." *Defense anchor:* "encode rejected as
expensive-reachable, impossible as unreachable." → `01`.

**4. Hash structures — adjacency + g/came/closed (`graph.ts`, `astar.ts`).**
★★ The bookkeeping. Undirected adjacency with direction derived at traversal
(`otherEnd`, `directedGrade`). You've built adjacency lists in `Graph.ts`.
*Defense anchor:* "edges stored once, direction is a function of arrival
endpoint." → `02`.

**5. Reconstruction — `reconstruct` (`astar.ts:86`).** ★★ Iterative back-walk,
emits the *exact relaxed edge* (parallel-edge correctness). You chose iteration
over recursion in your BST delete too. *Defense anchor:* "linear recursion is a
loop — and store the edge, not the node pair." → `07`.

**6. Percentile sort — `percentile` (`zones.ts`).** ★ A cold side-path. Full
sort for one order statistic. You've built all five sorts. *Defense anchor:*
"full sort because the call is cold and M is small — quickselect would be
premature." → `06`.

#### Tier 2 — gaps, ranked by leverage (practice these)

```
  Gap ranking — leverage = flattr-gain × closeness-to-done

  rank  gap              flattr gain          you already have
  ────  ──────────────   ──────────────────   ────────────────────────
   1    k-d tree         nearest.ts O(N)→logN  zones grid bucketing
   2    quickselect      zones full-sort→O(M)  quicksort PARTITION
   3    decrease-key     alt to lazy-deletion  PriorityQueue.updatePriority
   4    union-find       graph connectivity    —
   5    binary search    (no 1-D sorted array) —
   6    trie             address autocomplete  —
   7    dynamic prog.    (doesn't fit router)  recursion+memo shape
```

**1. k-d tree / spatial grid index.** ★★★ leverage — the one *felt* gap.
`nearestNode` (`nearest.ts:8`) scans every node O(N) on every tap. A k-d tree
(or a grid index — and `zones.ts` already tiles the bbox into a grid, so you're
*halfway there*) makes it O(log N). **Build this first.** It's the only gap
where flattr has a measurable cost today. → `04`.

**2. Quickselect.** ★★ leverage — the direct upgrade. `zones.ts`'s `percentile`
full-sorts for one rank; quickselect is that in O(M). You *already wrote the
partition* in your quicksort visualizer — quickselect is that partition with a
"recurse one side only" stop. **Highest closeness-to-done of any gap.** → `06`.

**3. Decrease-key (indexed) heap.** ★★ leverage. flattr uses lazy deletion;
the alternative keeps the heap small with a `value→index` map. *You already
built this* — `PriorityQueue.ts`'s `updatePriority`. The practice is wiring it
*into* `search()` and benchmarking it against lazy deletion (the `bench/`
harness exists for exactly this). → `03`.

**4. Union-find / DSU.** ★ leverage. No connectivity-under-union in flattr.
Where it'd help: precomputing connected components so `nearestNode` /
`search()` can fail fast on a disconnected start/goal pair instead of draining
the whole frontier to return `null`. New structure for you — worth building once
for the classic Kruskal/connectivity vocabulary.

**5. Binary search.** ★ leverage. No sorted 1-D array to bisect (covered in
`06`). Would appear with an elevation lookup table or sorted-histogram query.
New, but small — build it to nail the off-by-one boundary conditions, the part
interviews probe. → `06`.

**6. Trie.** ★ leverage. No prefix structure. Would power address autocomplete
over `pipeline/geocode.ts` street names. New structure; build it if/when flattr
grows a type-ahead UI. → `04`.

**7. Dynamic programming.** — leverage for *this* router (it genuinely doesn't
fit — non-negative edges make greedy correct, `07` explains). But it's the
biggest gap in your *general* DSA coverage per me.md ("less depth on DP beyond
recursion-with-memoization"). Practice it *off* flattr: Bellman-Ford (so you can
articulate the negative-edge boundary), then a classic tabulation (edit
distance, knapsack). → `07`.

### Move 2.5 — current state vs future state

flattr's DSA is in a deliberate "ship the spine, defer the indexes" state.
What's true now vs what the gaps would change:

```
  Phase A (now)                    Phase B (if scale demands)
  ───────────────────────────      ───────────────────────────────
  nearest: O(N) scan               k-d tree / grid: O(log N)
  percentile: full sort O(MlogM)   quickselect: O(M)
  heap: lazy deletion              decrease-key heap (smaller heap)
  fail-slow on disconnected        union-find: fail-fast

  what DOESN'T have to change: search() itself. The spine is correct
  and complete. Every gap is an INDEX or a CONSTANT-FACTOR win bolted
  onto the side — none touches the core loop.
```

That's the reassuring read: the centerpiece is done. The practice map is all
*peripheral* optimization and *general-skill* breadth, not core rework.

### Move 3 — the principle

A practice map ranks by consequence, not by syllabus order. The exercised tier
is your interview defense — every item anchored to a file you can open. The gap
tier is your study queue — ranked by `flattr-gain × how-close-you-already-are`,
which surfaces quickselect and decrease-key as near-free wins (you built 90% of
each already) and k-d tree as the one real measurable gap. The generalizable
move: when planning what to learn next, weight by leverage, not by what's
"missing" — a gap flattr doesn't feel (binary search) ranks below one it does
(k-d tree), regardless of textbook prominence.

## Primary diagram

The full map: defend on the left, practice on the right, ranked.

```
  flattr DSA practice map — defend (left) · practice (right)

  ┌─ TIER 1: EXERCISED (anchored, defend cold) ──────────────┐
  │  ★★★ search()      astar.ts:22    Graph2.ts (Dijkstra)   │
  │  ★★★ PQueue        pqueue.ts      BinaryHeap/PriorityQ   │
  │  ★★★ cost+BLOCKED  cost.ts        (new: the 1e9 trick)   │
  │  ★★  hash/adjacency graph.ts      Graph.ts               │
  │  ★★  reconstruct   astar.ts:86    BST iterative delete   │
  │  ★   percentile    zones.ts       Sorting/ (all 5)       │
  └──────────────────────────────────────────────────────────┘
  ┌─ TIER 2: GAPS (ranked by leverage, practice in order) ───┐
  │  1 ★★★ k-d tree     → nearest.ts:8   (felt: O(N)→O(logN))│
  │  2 ★★  quickselect  → zones.ts       (have partition!)   │
  │  3 ★★  decrease-key → search()       (have updatePriority!)│
  │  4 ★   union-find   → fail-fast disconnected             │
  │  5 ★   binary search→ no 1-D sorted array yet            │
  │  6 ★   trie         → address autocomplete               │
  │  7 —   DP           → off-flattr (Bellman-Ford, knapsack)│
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The ranking philosophy here is leverage-weighted, the same instinct behind a
good tech-debt triage: don't sort the backlog alphabetically, sort it by impact
× effort. Two gaps stand out because you're *almost done* with them —
quickselect is your existing quicksort partition with a different stop
condition, and the decrease-key heap is your existing `PriorityQueue.ts`
`updatePriority` wired into `search()`. Those are the cheapest wins. The k-d
tree is the one gap with a *measured* cost in flattr (the O(N) scan), so it
ranks first despite being new. DP ranks last for flattr specifically but is
your largest *general* breadth gap — so it's flagged for off-flattr practice.
The map is honest in both directions: what you can defend, and what's worth your
next study hours.

Read the rest of the guide for the deep walks: `05` is the centerpiece, `03`
and `01` its prerequisites, `04`/`06`/`07` where the gaps live.

## Interview defense

**Q: What would you improve about this codebase's DSA, and what would you leave
alone?**

Leave the spine alone — `search()` is one correct parametric loop covering four
algorithms, pinned by a differential optimality test. The improvements are all
peripheral indexes: first a k-d tree or grid index for `nearestNode`, which is
the one O(N)-per-tap scan with a real cost (`nearest.ts:8`); then quickselect
for the `zones.ts` percentile, which is just my existing quicksort partition
with a one-side recurse. Neither touches the core loop.

```
  leave: search() (correct, complete)
  add:   k-d tree (felt cost) → quickselect (near-free) → decrease-key (benchmark it)
```

Anchor: "the spine is done — every gap is an index or a constant-factor win
bolted on the side, ranked by leverage not by what's textbook-missing."

**Q: Which of these gaps have you basically already built?**

Two. Quickselect is my quicksort partition (in my reincodes Sorting visualizers)
with a "recurse only the side holding the target rank" stop — same partition,
different termination. And the decrease-key heap is my `PriorityQueue.ts`
`updatePriority` with its `value→index` map; flattr chose lazy deletion instead,
so the practice is wiring mine into `search()` and benchmarking the two with the
existing `bench/` harness.

Anchor: "quickselect = my partition + one-side recurse; decrease-key = my
`updatePriority` — both are 90% built already."

## See also

- `00-overview.md` — the ranked findings this map expands.
- `05-graphs-and-traversals.md` — the spine (tier-1 rank 1).
- `04-trees-tries-and-balanced-indexes.md` — k-d tree (gap rank 1).
- `06-sorting-searching-and-selection.md` — quickselect (gap rank 2).
- `03-stacks-queues-deques-and-heaps.md` — decrease-key (gap rank 3).
- `07-recursion-backtracking-and-dynamic-programming.md` — DP (gap rank 7).
