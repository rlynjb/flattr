# DSA foundations — practice map

**Industry name:** a ranked learning plan. **Type:** Project-specific. This is
the audit-and-plan file: it ranks what the repo *exercises* (drill these first —
they're load-bearing and you can prove you understand them) ahead of what it
*doesn't* (the gaps, sequenced by how soon `flattr` would actually need them).

---

## Zoom out, then zoom in

The other seven files each teach one foundation. This one steps back and asks the
through-line question: *which structures and algorithms explain `flattr`, and
which gaps should you deliberately practice — in what order?* The answer is
ranked by consequence: master the exercised core first (it's the interview story),
then close the gaps by leverage.

```
  Zoom out — the whole DSA surface, sorted by "do you own it?"

  ┌─ EXERCISED (you can defend it with file:line) ────────────────┐
  │  ★ binary heap / PQueue        03  ← the engine's heartbeat     │
  │  ★ graph + A* progression      05  ← THE centerpiece            │
  │  ★ hash maps / adjacency       02  ← the substrate              │
  │  ★ cost models / metrics       01  ← the measuring stick        │
  │    sort + select (percentile)  06  ← aggregation                │
  │    iterative recursion / fold  07  ← reconstruction, zones      │
  └─────────────────────────┬────────────────────────────────────────┘
                            │ then close the gaps by leverage:
  ┌─ NOT YET EXERCISED ─────▼────────────────────────────────────────┐
  │  1. spatial index (k-d tree)   04  ← highest leverage (nearest.ts)│
  │  2. union-find (DSU)           05  ← connectivity fast-fail       │
  │  3. binary search              06  ← cheap, foundational          │
  │  4. decrease-key heap          03  ← the heap upgrade path        │
  │  5. quickselect                06  ← percentile at scale          │
  │  6. trie                       04  ← address autocomplete         │
  │  7. backtracking / DP tables   07  ← k-alternatives, constraints  │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: the verdict. **The repo's DSA strength is graphs + heaps, and it's
genuinely strong** — a correct lazy-deletion heap, an admissible-heuristic A\*
with a proven-optimal correctness gate, a real directed-graph cost model, and a
bidirectional search with the subtle consistent-potential math right. The gaps
are all *scaling* and *adjacent-feature* structures, not holes in the core.

---

## The structure pass

**Layers.** The plan layers by *what proving it buys you*:

```
  One question — "what does mastering this prove?" — across the tiers

  ┌──────────────────────────────────────────────┐
  │ TIER 1: the exercised core                     │ → "I built a real router"
  │   heap, A* progression, admissibility          │   (the portfolio story)
  └────────────────────┬───────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ TIER 2: the scaling gaps                  │ → "I know what production needs"
       │   spatial index, union-find, decrease-key │   (the senior signal)
       └───────────────┬─────────────────────────┘
           ┌───────────▼───────────────────────┐
           │ TIER 3: the breadth gaps             │ → interview coverage
           │   binary search, quickselect, trie,  │   (round out the foundation)
           │   backtracking/DP                    │
           └─────────────────────────────────────┘
```

**Axis = leverage.** Hold "what's the payoff of practicing this?" constant. Tier
1 is already done — the payoff is *articulating* it (the Validate blocks and
Interview defenses across files 01–07). Tier 2 gaps each unlock a concrete
`flattr` capability at scale. Tier 3 gaps are breadth for interviews, lower
urgency because the repo doesn't pull on them yet. The seam between Tier 1 and
Tier 2 is the spec's own line (§15.1): "the DSA depth is real; the *scale* is
scoped" — naming that gap reads as senior.

---

## How it works

### Move 1 — the mental model

You know how a code review ranks findings: blockers first, then
should-fixes, then nice-to-haves. This plan is that, applied to your own DSA: own
the core, then close gaps by how soon the project hits them.

```
  The ranking rule

  exercised + load-bearing   → drill the EXPLANATION (you have the code)
  not exercised + high leverage → BUILD it (unlocks a real capability)
  not exercised + breadth      → STUDY it (interview coverage)

  consequence orders the list, not alphabetical or textbook order
```

### Move 2 — the plan, ranked

**Tier 1 — own the exercised core (drill the explanation, the code is done).**

```
  what                   file   the one thing to be able to say cold
  ───────────────────────────────────────────────────────────────────────
  A* = Dijkstra + h      05     "one search() fn, four (cost,heuristic) pairs"
                                 astar.ts:135-163
  admissibility proof    05     "penalty≥0 ⟹ cost≥length ⟹ haversine never
                                 overestimates ⟹ optimal" — astar.test.ts:38-45
  heap kernel            03     "siftUp/siftDown + the parent≤child invariant;
                                 empty-frontier is the termination" pqueue.ts
  lazy delete vs dec-key 03     "push stale, skip at pop (astar.ts:51); upgrade
                                 only if pops≫expanded says so" — types.ts:49
  BLOCKED finite         05/01  "1e9 not Infinity → 'no flat way' ≠ 'no way'"
                                 cost.ts:5, astar.test.ts:82-96
  bidirectional potential 05    "pf=(h_goal-h_start)/2 keeps both sides
                                 consistent; topF+topR≥mu stops" bidirectional.ts:30-52
```

These are not things to build — they're built and tested. The practice is
*reconstructing the argument from memory* (every file's Validate block is the
drill). If you can defend all six cold, the centerpiece is interview-ready.

**Tier 2 — the scaling gaps, ranked by leverage (build these).**

```
  1. SPATIAL INDEX (k-d tree)            file 04   → nearest.ts O(V)→O(logV)
     build when: graph grows past the MVP bbox (spec §11-E)
     done when: nearestNode passes its tests with a tree, V large, faster than scan
     proves: you know map software's actual nearest-neighbor structure

  2. UNION-FIND / DSU                    file 05   → connectivity fast-fail
     build when: you want to reject disconnected A/B before searching, or
                 validate the graph at build time (spec §14.3 node-snapping bug)
     done when: "same component?" answered in ~O(1) with path compression
     proves: you understand the disconnected-vs-steep distinction structurally

  3. DECREASE-KEY HEAP                   file 03   → PQueue upgrade
     build when: bench shows pops ≫ nodesExpanded (the staleness overhead bites)
     done when: a value→index map makes decreaseKey O(log n); same path results
     note: you ALREADY built this (reincodes/PriorityQueue.ts) — port it
```

**Tier 3 — breadth gaps (study, lower urgency).**

```
  4. BINARY SEARCH        file 06  the O(log n) sorted-array search; foundational,
                                   pairs with a one-time sort. Famously off-by-one.
  5. QUICKSELECT          file 06  k-th element in O(n) avg — percentile without
                                   the full sort, at large cell sizes (zones.ts)
  6. TRIE                 file 04  prefix matching for address autocomplete
                                   (mobile/src/AddressBar.tsx)
  7. BACKTRACKING / DP    file 07  k-alternative routes (penalty method, §14.5),
                                   constraint routing. alternatives.ts is named,
                                   not built.
```

### Move 3 — the principle

**Rank by consequence, not by textbook order.** The repo's core is strong and
done — practice *defending* it. The gaps aren't deficiencies; they're the scaling
and feature structures a v1 correctly defers. Naming each gap, where it lands, and
the trigger that makes it worth building is the senior move the spec asks for
(§15.1): the depth is real, the scope is deliberate, and you can say exactly what
you'd add next.

---

## Primary diagram

The complete ranked plan in one frame.

```
  flattr DSA practice map — exercised core, then gaps by leverage

  ┌─ TIER 1: OWN IT (built + tested, drill the explanation) ──────┐
  │  A* progression 05 · admissibility 05 · heap kernel 03         │
  │  lazy-delete 03 · BLOCKED-finite 05 · bidir potential 05       │
  │  → every file's Validate block IS the drill                    │
  └─────────────────────────┬──────────────────────────────────────┘
  ┌─ TIER 2: BUILD IT (scaling, high leverage) ────▼──────────────┐
  │  1 k-d tree → nearest.ts (04)                                  │
  │  2 union-find → connectivity (05)                              │
  │  3 decrease-key → PQueue (03) [already built in reincodes]     │
  └─────────────────────────┬──────────────────────────────────────┘
  ┌─ TIER 3: STUDY IT (breadth, lower urgency) ────▼──────────────┐
  │  4 binary search (06) · 5 quickselect (06)                     │
  │  6 trie (04) · 7 backtracking/DP (07)                          │
  └──────────────────────────────────────────────────────────────────┘
  read order for the guide: 01→02→03→05 (core) then 04,06,07 (gaps), end here
```

---

## Implementation in codebase — evidence for each verdict

**Use cases.** This file doesn't add new code; it audits. Each verdict's evidence:

```
  verdict                          evidence (file:line)
  ─────────────────────────────────────────────────────────────────────
  heap is correct + tested         pqueue.ts:42-48 (checkInvariant) +
                                   pqueue.test.ts:23-99 (oracle property tests)
  A* is proven optimal             astar.test.ts:38-45 (same cost as Dijkstra)
  one engine, four stages          astar.ts:22-78 (search) + 135-163 (wrappers)
  directed graph (A→B≠B→A)         graph.ts:17-19 (directedGrade) +
                                   astar.test.ts:74-80 (detour up, direct down)
  honest fallback works            cost.ts:5 (BLOCKED) +
                                   astar.test.ts:82-96 (steep flagged vs null)
  bidirectional is correct         bidirectional.ts:30-52 +
                                   bidirectional.test.ts:16-38
  nearest.ts is O(V) scan (gap)    nearest.ts:7-15 (no index)
  percentile full-sorts (note)     zones.ts:7 (sort, justified by small n)
  no trees / tries / DSU (gap)     absence — grep finds none
```

---

## Elaborate

The ranking discipline here mirrors how staff engineers triage: separate "this is
done and correct" from "this is the next thing to build" from "this is breadth."
The spec's portfolio framing (§15) is built on exactly this — the algorithm
*progression* (Dijkstra → A\* → directed → bidirectional → CH) is the story, and
the honest naming of the scale gap (§15.1: "don't say I built Google Maps") is
what reads as senior. Rein's `reincodes` portfolio already covers several Tier 2/3
gaps in isolation (PriorityQueue with decrease-key, connected-components via DFS,
all five sorts, BST traversals) — the move is *porting them into `flattr` where
they'd do real work*, which is the difference between "I implemented X" and "I
used X to solve a problem." Next: re-read **05** until you can reconstruct the
admissibility proof and the bidirectional stopping rule from memory; those two are
the highest-signal things in the whole repo.

---

## Interview defense

**Q: "What's the DSA depth here, honestly, and where's the gap?"**

Depth is real: a correct hand-rolled binary heap, an A\* with a *proven*
admissible heuristic (same cost as Dijkstra, `astar.test.ts:38-45`), a genuine
directed-graph cost model where A→B ≠ B→A, and bidirectional A\* with the
consistent-potential math right. The gap is *scale* — no spatial index (nearest.ts
is `O(V)`), no contraction hierarchies, no tiling for a full city. That's
deliberate (spec §15.1), and the first thing I'd add is a k-d tree for node
snapping when the graph outgrows the MVP bbox.

```
  STRONG: heap, A* progression, admissibility, directed cost, bidirectional
  SCOPED: spatial index, union-find, CH/ALT, tiling
  next move: k-d tree → nearest.ts (file 04), then union-find for connectivity
```

**Q: "If you had one week to improve this repo's DSA, what would you do?"**

Port the decrease-key PriorityQueue I already built (`reincodes/PriorityQueue.ts`)
in *only if* the bench shows `pops ≫ nodesExpanded` (`types.ts:49`) — measure
first. Then add union-find to fast-fail disconnected requests and validate the
graph at build time, catching the node-snapping mesh bug the spec warns about
(§14.3). Both are high-leverage and small.

---

## Validate

1. **Reconstruct:** List the six Tier-1 items and, for each, the one-line claim
   you'd make cold (the table in Move 2).
2. **Explain:** Why is "no spatial index" a *scoped decision* rather than a defect
   for the current MVP (spec §11-E, `nearest.ts:7-15`)?
3. **Apply:** Pick the single highest-leverage gap and justify the ranking — what
   `flattr` capability does it unlock, and what's the trigger to build it?
4. **Defend:** Argue the "depth is real, scale is scoped" framing (spec §15.1)
   using three pieces of `file:line` evidence from the table above.

---

## See also

- **00-overview.md** — the ranked findings this plan operationalizes.
- **05-graphs-and-traversals.md** — the centerpiece to drill first.
- **03-stacks-queues-deques-and-heaps.md** — the heap and its decrease-key upgrade.
- **04-trees-tries-and-balanced-indexes.md** — the spatial-index and trie gaps.
- `.aipe/study-performance-engineering/` — the bench that triggers Tier-2 builds.
