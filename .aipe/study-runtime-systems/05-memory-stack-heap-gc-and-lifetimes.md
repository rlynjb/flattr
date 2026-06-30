# Memory, Stack, Heap, GC, and Lifetimes — what grows and what's freed

**Industry name:** memory model / allocation / garbage collection — *Industry standard*.

## Zoom out, then zoom in

JavaScript hides memory behind a GC, so the question isn't "did you free it" — it's **"what
keeps a reference alive, and does anything grow without bound?"** flattr has exactly one
unbounded grower. Here's where memory lives.

```
  Zoom out — where flattr's memory sits

  ┌─ Stack (per call) ───────────────────────────────────────────┐
  │  A* locals: open queue ptr, g/came/closed Maps, loop vars     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ references into ↓
  ┌─ Heap (GC-managed) ──────────────────────────────────────────┐
  │  ★ baseGraph + merged tiles ─ NEVER EVICTED ─ grows on pan ★  │ ← we are here
  │  search Maps (g/came/closed) — freed after each A* returns    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ spills to ↓
  ┌─ Persistent store (disk) ────▼───────────────────────────────┐
  │  elevCache → AsyncStorage (bounded: FIFO cap 50k)            │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: trace the **lifetime axis** — how long does each allocation live? Most of flattr's
memory is short-lived (A\*'s working set dies when the search returns). One thing is
session-lived and *growing*: the merged graph. That's the memory story.

## Structure pass — layers, one axis, the seams

**The layers** are stack → heap → persistent store. **The axis: "how long does this live,
and what frees it?"**

```
  Axis: "lifetime — when is this freed?"  — traced down

  ┌─ stack frame (A* call) ──────────────────────┐
  │  loop vars, references to the Maps            │  → freed when search() returns
  └────────────────────────────────────────────────┘    (automatic, scope exit)
      ┌─ heap: A* working Maps ──────────────────┐
      │  g, came, closed, open                    │  → unreachable after return → GC'd
      └────────────────────────────────────────────┘    (short-lived)
          ┌─ heap: merged graph ─────────────────┐
          │  baseGraph + every loaded tile        │  → NEVER freed during session ★
          └────────────────────────────────────────┘    (the unbounded grower)
              ┌─ disk: elevCache ────────────────┐
              │  AsyncStorage JSON                │  → FIFO-capped at 50k entries
              └────────────────────────────────────┘    (bounded, persistent)
```

The answer flips sharply at the merged-graph layer: everything above it is freed promptly,
that one layer is never freed. **The seam is the `useMemo` that builds the merged graph** —
each rebuild produces a *new* object, but the inputs (`view`, `corridor`) accumulate. Hand
off to How it works.

## How it works

### Move 1 — the mental model

You know the React mental model already: state you `setState` into stays alive until you
clear it; derived `useMemo` values get recomputed and the old one becomes garbage. flattr's
memory is that, with one twist — the *inputs* to the memo (`view`, `corridor` regions) are
never cleared, so the merged graph the memo produces keeps getting *bigger*. The strategy
(or rather, the current non-strategy): **lean entirely on GC for short-lived work; hold the
graph in memory for the whole session with no eviction.**

```
  Memory kernel — two lifetimes

   SHORT-LIVED (GC reclaims promptly)        SESSION-LIVED (held until app closes)
   ┌──────────────────────────┐             ┌──────────────────────────────────┐
   │ A* run: open/g/came/closed│             │ baseGraph + corridor + view tiles │
   │ → return → unreachable    │             │ → merged useMemo grows on each pan │
   │ → GC'd                    │             │ → never evicted ★                 │
   └──────────────────────────┘             └──────────────────────────────────┘
```

### Move 2 — the parts, one at a time

**Part 1 — A\*'s stack and working set (short-lived, well-behaved).** Each `search()` call
allocates four collections on the heap and references them from the stack frame:

```ts
// features/routing/astar.ts:30-37 — per-call working set, all freed when search returns
const open = new PQueue<string>();          // binary heap, O(nodes touched)
const g = new Map<string, number>();        // best cost per node
const came = new Map<string, {edge, prev}>(); // came-from for reconstruction
const closed = new Set<string>();           // settled nodes
const byId = indexEdges(graph);             // id→edge index, rebuilt every call
```

```
  A* memory lifetime — allocate, use, drop

  directedAstar() called
    └─ allocate open/g/came/closed/byId  ──┐
       while loop relaxes edges            │ all referenced only from this frame
    └─ return SearchResult ────────────────┘
         frame pops → collections unreachable → GC reclaims
```

The stack depth is bounded and small: A\*'s `while` loop is *iterative*, not recursive
(`astar.ts:48`), so there's no deep call stack to blow. The one recursive-ish piece,
`reconstruct` (`astar.ts:86-103`), is also a plain loop — no stack-overflow risk even on a
long path. What's the one inefficiency? `byId = indexEdges(graph)` rebuilds the entire
edge index on *every* search (`astar.ts:35`, called from `MapScreen.tsx:155` inside a memo
keyed on `userMax` too) — so dragging the grade slider re-indexes every edge each tick. It's
fine at city scale; it's the first thing to hoist if A\* got hot. *Inference: this is a
per-call allocation, observable in the code, not a measured hotspot.*

**Part 2 — the merged graph (session-lived, unbounded).** This is the finding. The routing
graph is a `useMemo` that merges base + corridor + view (`useTileGraph.ts:132-145`). Every
pan that loads a new viewport sets a new `view` region; the memo rebuilds, merging it in.
Nothing ever *removes* a region:

```ts
// mobile/src/useTileGraph.ts:132-145 — merged graph grows; no eviction of old tiles
const graph = useMemo(() =>
  baseGraph
    ? stitchGraph(mergeGraphs([
        baseGraph,
        ...(corridor ? [corridor.graph] : []),  // ← one corridor (overwritten, bounded)
        ...(view ? [view.graph] : []),           // ← one view (overwritten, bounded)
      ]))
    : null,
  [baseGraph, corridor, view]);
```

```
  Merged-graph memory over a session — monotonic growth via the cache, not the slots

  Actually: `view` and `corridor` are SINGLE slots (overwritten each load).
  The unbounded grower is the elevation cache + repeated tile FETCHES that
  feed ever-larger merged objects as the user roams a wider area over time.

  t0: base                          small
  t1: base + view(area A)           +A
  t2: base + view(area B)           swaps A→B  (slot overwritten, A GC'd)
       but elevCache mem Map: A's cells + B's cells ── accumulates ──► up to 50k
```

The nuance worth stating precisely: `view` and `corridor` are *single* regions, each
overwritten on the next load — so the merged graph at any instant is bounded by ONE base +
ONE corridor + ONE view. The genuinely monotonic in-memory grower is the **elevation cache
`Map`** (`elevCache.ts:11`), which accumulates a cell per sampled area and only sheds
entries when it crosses 50k (`elevCache.ts:48-52`). So the "never evicted" red flag is real
but precise: *the merged graph object is bounded per-instant but the cache that backs
repeated builds grows toward its 50k cap.* What breaks at the boundary? Over a very long
session roaming a large area, the cache approaches 50k cells (~hundreds of KB of numbers) —
capped, then FIFO-trimmed. Not a leak; a bounded high-water mark.

**Part 3 — the elevation cache's explicit lifetime management (the bounded grower).** This
is the one place flattr manages memory by hand instead of trusting GC:

```ts
// mobile/src/elevCache.ts:46-53 — FIFO cap: oldest entries drop first when over MAX_ENTRIES
if (entries.length > MAX_ENTRIES) {           // MAX_ENTRIES = 50000
  entries = entries.slice(entries.length - MAX_ENTRIES);  // keep newest 50k
  mem.clear();
  for (const [k, v] of entries) mem.set(k, v);   // ← rebuild Map in insertion order
}
```

`Map` preserves insertion order, so "keep the last N entries" is a FIFO eviction — oldest
sampled cells drop first. What breaks without the cap? The cache `Map` grows for the whole
session with no ceiling. The cap turns an unbounded grower into a bounded one. (Lifecycle
detail — debounced persistence — lives in `06`.)

**Part 4 — GC you don't control.** Hermes (app) and V8 (pipeline) both run generational
GC on a native thread (`02`). flattr tunes nothing — no `--max-old-space-size`, no manual
`global.gc()`, no `WeakMap`/`WeakRef` to hint lifetimes (grep: none). It relies entirely on
reachability: drop the last reference and the object becomes collectable. This is correct
for everything *except* the cache, which is why the cache is the one place with a manual cap.

### Move 3 — the principle

In a GC'd runtime, memory discipline reduces to **reachability management**: short-lived
work (A\*'s Maps) is freed automatically the instant its scope exits, so you never think
about it; long-lived caches need a manual ceiling because GC can't free something you're
still pointing at. flattr gets this exactly right — it leans on GC everywhere it can and
puts a hard FIFO cap on the one structure that would otherwise grow forever. The senior
move is knowing *which* allocations GC handles for free (the per-call working set) and which
need an explicit policy (the persistent cache), and not over-engineering the former.

## Primary diagram

The full memory picture — stack, heap lifetimes, the manual cap, the disk spill.

```
  flattr memory model — lifetimes from stack to disk

  ┌─ STACK (A* call frame) ──────────────────────────────────────┐
  │  iterative while loop (no deep recursion) → bounded depth     │
  │  references → open/g/came/closed/byId                         │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼ on return: frame pops, refs drop
  ┌─ HEAP (GC-managed) ──────────────────────────────────────────┐
  │  SHORT-LIVED: A* Maps → unreachable after return → GC'd       │
  │  SESSION:     merged graph (bounded per-instant: 1 base/      │
  │               1 corridor/1 view; old slots GC'd on overwrite) │
  │  GROWING:     elevCache mem Map ──► capped FIFO at 50k ★      │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼ debounced persist (06)
  ┌─ DISK (AsyncStorage) ────────────────────────────────────────┐
  │  flattr.elevCache.v1 → JSON, same 50k ceiling                │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

flattr's memory model is the standard **managed-runtime** story: a generational garbage
collector reclaims unreachable objects, so the only leaks possible are *reachability* leaks
— something you keep pointing at. The classic JS reachability leak is a growing `Map`/array
that's never trimmed, which is exactly the shape of `elevCache.mem` — and flattr defuses it
with the textbook fix, an LRU/FIFO cap (here FIFO via `Map` insertion order). The merged-graph
"never evicted" concern is the in-memory analog of a cache with no TTL; the reason it's
acceptable is that the per-instant slots are bounded and the backing cache *is* capped. If
flattr ever needed true tile eviction (roaming a whole region), the move is an LRU over loaded
tiles keyed by bbox — the same `PriorityQueue`/`Map` machinery already in the repo
(`pqueue.ts`). For the disk side of the cache lifecycle, see `06`; for the pump that triggers
each build, see `04`.

## Interview defense

**Q: "Does this app leak memory as you use it?"**

The only session-lived structure that grows is the elevation cache, and it's capped at 50k
entries with FIFO eviction (`elevCache.ts:48-52`). Everything else is short-lived: A\*'s
working set (open queue, g/came/closed Maps) is freed by GC the moment each search returns,
and the merged graph holds only one base + one corridor + one view region at a time, with
old regions GC'd on overwrite. No reachability leak.

```
  A* Maps → return → GC'd.   cache Map → grows → FIFO-capped at 50k.
```

*Anchor:* "GC handles the short-lived working set; the one persistent cache gets a manual
FIFO cap — that split is the whole memory design."

**Q: "Any stack-depth risk in the routing?"**

No. A\* is an iterative `while` loop, not recursion (`astar.ts:48`), and path
reconstruction is also a plain loop (`astar.ts:86-103`). Stack depth is constant regardless
of graph size — no stack-overflow on a long path.

```
  while (!open.isEmpty()) {...}   ← bounded frame, not recursive descent
```

*Anchor:* "Iterative search means stack depth is O(1) in the path length — the working set
is on the heap, not the stack."

## See also

- `06-filesystem-streams-and-resource-lifecycle.md` — the elevCache's disk persistence + cap.
- `04-shared-state-races-and-synchronization.md` — the refs that hold the graph alive.
- `02-processes-threads-and-tasks.md` — the native GC thread you don't control.
- `study-dsa-foundations` (sibling) — the PQueue/Map structures A* allocates.
