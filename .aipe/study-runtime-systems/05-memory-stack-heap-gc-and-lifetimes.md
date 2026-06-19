# Memory: stack, heap, GC, and lifetimes

*Allocation, stack and heap behavior, garbage collection, memory pressure.*
**Type:** Industry standard (managed-heap / tracing GC).

## Zoom out, then zoom in

flattr's memory model is "ordinary managed heap, nothing fancy" — but
there are two distinct memory stories worth separating. The **graph** is
long-lived: parsed once, held in the heap for the life of the process,
grown by merging tiles. The **per-search scratch** is short-lived: A*
allocates a few `Map`s and `Set`s, uses them, and lets GC reclaim them the
instant the search returns. Knowing which is which tells you where memory
pressure can build (the graph) and where it can't (the search).

```
  Zoom out — the two memory lifetimes, on the runtime map

  ┌─ RUN process · JS heap ──────────────────────────────────┐
  │  ★ LONG-LIVED: the merged Graph object ★                  │ ← we are here
  │     baseGraph + corridor + view tiles + stitch edges       │   (grows as you pan,
  │     never evicted                                          │    never shrinks)
  │                                                            │
  │  SHORT-LIVED: per-search Maps/Sets (g, came, closed)       │ ← and here
  │     allocated in search(), dead when it returns            │   (GC reclaims fast)
  └──────────────────────────────────────────────────────────┘

   no Buffer pools, no WeakMap caches, no off-heap memory,
   no manual GC tuning — `not yet exercised`
```

Zoom in: the question is *what lives in the heap, for how long, and where
does it grow unbounded?* The answer: the graph grows without eviction as
tiles merge in; everything else is allocate-use-drop with GC cleaning up.

## Structure pass

**Layers.** Memory nests by lifetime:

```
  Layered decomposition — "how long does this live?"

  ┌───────────────────────────────────────────────┐
  │ outer: module-load allocation (the base graph) │ → lives for the process
  └───────────────────────────────────────────────┘
      ┌─────────────────────────────────────────┐
      │ middle: state-held allocation (tiles)     │ → lives until... never
      └─────────────────────────────────────────┘    (no eviction)
          ┌─────────────────────────────────────┐
          │ inner: call-scoped allocation (astar) │ → lives for one call
          └─────────────────────────────────────┘    (GC'd on return)

  "how long does it live?" — process / forever / one call
  the "forever" in the middle layer is the one to watch
```

**Axis — lifetime.** Trace "when is this memory reclaimed?" The base graph
is never reclaimed (it's the whole point). Per-search scratch is reclaimed
on the next GC after the search returns — it has no references escaping the
function. The merged tiles are the interesting case: they're held in React
state, and *nothing ever removes them*, so they accumulate.

**Seam.** The load-bearing boundary is **stack ↔ heap**. The A* call
itself lives on the stack (the `search` frame, the `while` loop's locals);
the data structures it builds (`g`, `came`, `closed`, the `PQueue`'s
backing array) live on the heap. When `search` returns, the stack frame
pops and the only thing surviving is the returned `Path` — everything else
becomes garbage. That clean drop is why a single search has no lasting
memory cost.

## How it works

### Move 1 — the mental model

You know this from any React app: objects you allocate and stop
referencing get collected; objects you stash in long-lived state stick
around. The heap is a graph of live objects rooted at things like module
scope and React state; GC walks from the roots and frees whatever it can't
reach. flattr's memory behavior is entirely "what's still reachable from a
root?"

```
  Pattern — reachability from roots determines what survives

   roots:  module scope          React state         current call stack
            │                      │                    │
            ▼                      ▼                    ▼
        baseGraph             view/corridor tiles    search() locals
        (always live)         (live: held by state)  (g, came, closed)
                                                       │
                              when search() returns ───┘
                              these lose their root → garbage → GC frees

   reachable = survives; unreachable = freed on next GC
```

### Move 2 — walk the allocations

**The base graph is allocated once, at module load.** `loadGraph()`
returns the bundler-inlined JSON object — ~544 KB of it
(`mobile/assets/graph.json`). `prefixGraph` then *copies* it (rewriting
every id with a `base:` prefix), so right after launch you briefly hold
two copies before the original is collected. From then on, one graph
object is rooted in the `baseGraph` `useMemo` for the life of the app.

**Per-search scratch is allocate-use-drop.** Every call to `search`
freshly allocates: a `PQueue` (a growing array of `{item, priority}`), a
`g` Map, a `came` Map, a `closed` Set, and an `byId` Map index over all
edges. None of these escape the function — only the `Path` does. So the
instant `search` returns, all of it is unreachable and the next GC frees
it.

```
  Execution trace — heap during one directedAstar call

  step  heap allocation                       lifetime
  ────  ───────────────────────────────────  ───────────────────
  1     new PQueue (backing array grows)       dies on return
  2     g, came, closed, byId Maps/Set          dies on return
  3     reconstruct() builds nodes[]/edges[]    handed to summarize
  4     summarizePath builds the Path object    ESCAPES (returned)
  5     search returns                          steps 1-2 → garbage

  one search = one short-lived allocation spike, then back to baseline
```

**`indexEdges` rebuilds a full edge index every search.** A subtle one:
`search` calls `indexEdges(graph)` which allocates a `Map<string, Edge>`
over *every* edge in the graph, on every search. For a small graph that's
cheap; as the merged graph grows, this is a per-search O(E) allocation
that GC then has to reclaim. It's correct, just not amortized across
searches.

**The merged tiles grow without bound.** Here's the one place memory
pressure can actually build. Every viewport build and corridor build
produces a new prefixed `Graph` stashed in `view`/`corridor` state, and
`mergeGraphs` unions them into the live graph. But there's *no eviction*:
pan across a city and you keep merging in tiles, and the merged graph only
ever grows. The bounded part is that only the *latest* view and *latest*
corridor are kept (last-write-wins, `04-`) — so it's two regions, not N —
but each region can be large, and the base graph is never trimmed.

```
  Comparison — what's bounded vs what isn't

  per-search scratch:   ████ → freed       (bounded: dies on return)
  base graph:           ████████           (bounded: fixed ~544KB)
  view + corridor:      only LATEST kept    (bounded: 2 regions, not N)
  merged graph total:   base + view + corr  ← grows with region SIZE,
                                              no eviction of old coverage

  the risk isn't a leak of N tiles — it's one big merged graph
```

**There's no off-heap memory and no manual GC management.** No `Buffer`,
no `ArrayBuffer` pools, no `WeakMap`-based caches that would let GC drop
entries under pressure, no `global.gc()` calls. It's all plain V8 (build)
/ Hermes (app) heap, collected automatically. That's `not yet exercised`
territory — fine for this scale.

### Move 3 — the principle

The cheapest memory to reason about is **call-scoped memory** — allocate
inside a function, let it die when the function returns, never hold a
reference. flattr's search is a textbook case: heavy scratch that
evaporates on return. The memory you *do* have to watch is anything rooted
in long-lived state with no eviction policy — here, the merged graph. The
discipline that transfers: for every long-lived collection, answer "what
removes entries?" before you ship. flattr's answer for the tile cache is
"nothing yet," and that's the honest gap.

## Primary diagram

The full heap picture: roots, lifetimes, and the one unbounded path.

```
  flattr heap — roots, lifetimes, the unbounded path

  ROOTS                          HEAP OBJECTS              LIFETIME
  ─────                          ────────────             ────────
  module scope ────────────────► graph.json blob          load → GC'd
                                  after prefixGraph copy

  baseGraph useMemo ───────────► base: prefixed Graph      whole app

  view state ──────────┐
  corridor state ──────┼───────► merged Graph (union)      until replaced;
  (latest only)        │         + stitch edges            ★ grows by SIZE,
                       │                                      no eviction ★
  search() stack ──────┴───────► PQueue, g, came, closed   one call → garbage
                                 byId index (O(E)/search)

  ★ = the only place memory pressure builds as you use the app
```

## Implementation in codebase

**Use cases.** Memory matters in two moments: app launch (the base graph
parse + prefix copy) and extended panning/routing (merged graph growth).
The per-search allocations matter only as GC churn if searches run in a
tight loop (the bench does this — `bench/run.ts`).

The base graph copy at launch — two copies held momentarily:

```
  mobile/src/MapScreen.tsx  (lines 28-34) + features/map/tiles.ts (21-38)

  const baseGraph = useMemo(() => {
    return prefixGraph(loadGraph(), "base");   ← loadGraph returns the 544KB blob;
  }, []);                                       ║  prefixGraph COPIES every node/edge
        │                                       ║  with a "base:" id prefix
        └─ momentarily holds the original + the prefixed copy; the original
           loses its root after this returns and is collected. Steady state:
           one graph object, ~rooted for the app's life.
```

The per-search scratch — all local, all dies on return:

```
  features/routing/astar.ts  (lines 30-37)

  const open = new PQueue<string>();              ← heap: growing array
  const g = new Map<string, number>();            ← heap: best-known costs
  const came = new Map<string, {edge,prev}>();     ← heap: parent pointers
  const closed = new Set<string>();                ← heap: finalized nodes
  const byId = indexEdges(graph);                  ← heap: O(E) edge index, EVERY call
        │
        └─ none of these escape `search`. When it returns (astar.ts:53 or :77)
           the only survivor is the Path. The rest is unreachable → GC.
           byId is rebuilt per search — cheap now, O(E) churn as the graph grows.
```

The unbounded growth point — merge with no eviction:

```
  mobile/src/useTileGraph.ts  (lines 72-85) + features/map/tiles.ts (89-108)

  const graph = useMemo(() =>
    baseGraph ? stitchGraph(mergeGraphs([
      baseGraph,
      ...(corridor ? [corridor.graph] : []),     ← latest corridor only
      ...(view ? [view.graph] : []),             ← latest view only
    ])) : null,
  [baseGraph, corridor, view]);
        │
        └─ mergeGraphs Object.assigns all nodes/edges into one object. Bounded
           to base + 2 regions (last-write-wins), but no logic ever shrinks the
           base coverage or evicts stale regions — the merged graph only grows
           by region size. The honest gap: no LRU, no eviction. (audit 08-)
```

## Elaborate

Tracing garbage collection is what lets you allocate freely inside a
function without manual `free()` — the price is GC pauses and the
discipline of not accidentally rooting things you meant to drop. flattr
never fights the GC because its hot allocation (search scratch) is
textbook short-lived. The classic memory bug in this style of code is the
*unbounded cache* — a `Map` you keep adding to and never trim — and flattr
has the mild version: the merged graph grows with explored area. The
production fix is an eviction policy (LRU on tiles, a max merged-node
count, or trimming regions outside the current viewport). It's
`not yet exercised` because the bbox is tiny today. Read `07-` for how
bounded work and eviction connect, and
[`.aipe/study-performance-engineering/`](../study-performance-engineering/)
for measuring the GC churn the bench can surface.

## Interview defense

**Q: "Walk me through memory during one route search."**

A short spike that fully reclaims. `search` allocates a priority queue, a
`g`-cost Map, a `came` parent Map, a `closed` Set, and an O(E) edge index
— all local (`astar.ts:30-37`). Only the `Path` escapes via return. The
moment `search` returns, the scratch is unreachable and GC frees it on the
next cycle. No lasting cost per search.

```
  alloc scratch ──► search runs ──► return Path ──► scratch unreachable ──► GC
```

Anchor: *"Everything but the returned `Path` is call-scoped — it dies when
the function returns."*

**Q: "Where can memory grow unbounded?"**

The merged graph in `useTileGraph`. Every build adds a region, merged into
one live `Graph` object (`useTileGraph.ts:72-85`). Last-write-wins keeps
it to base + 2 regions, but nothing evicts old coverage, so it grows with
explored area. The fix is an eviction policy; it's a non-issue today only
because the bbox is deliberately small (`config.ts:10`).

```
  pan across city ──► merge more tiles ──► merged graph only grows
                      (no LRU, no eviction)
```

Anchor: *"The hot path is bounded; the tile cache has no eviction — that's
the one place to watch."*

## Validate

**Reconstruct.** Draw the heap roots and the three lifetimes (process /
forever-no-eviction / one-call). Name which allocations escape `search`
and which don't. (`astar.ts:30-37` — only the `Path` escapes.)

**Explain.** Why does running 10,000 searches in the bench not leak
memory? (Each search's scratch is call-scoped and reclaimed; nothing
accumulates across calls — `bench/run.ts` loops, but `search` roots
nothing globally.)

**Apply.** The merged graph hits 200K nodes after long use and the app
slows. Name an eviction policy and where it'd hook in. (LRU on regions
keyed by recency, or drop regions whose bbox is outside the current
viewport + margin — implemented around the `mergeGraphs` call,
`useTileGraph.ts:72-85`.)

**Defend.** Argue the per-search `indexEdges` rebuild
(`astar.ts:36`) is acceptable today and name when it isn't. (O(E) per
search is negligible at the current edge count; it becomes worth caching
once the merged graph is large and searches are frequent — then build the
index once per graph version, not per search.)

## See also

- `02-processes-threads-and-tasks.md` — the stack the search runs on
- `07-backpressure-bounded-work-and-cancellation.md` — eviction + bounds
- [`.aipe/study-dsa-foundations/`](../study-dsa-foundations/) — the Maps/Sets the search allocates
- [`.aipe/study-performance-engineering/`](../study-performance-engineering/) — GC churn measurement
