# Memory, Stack, Heap, GC & Lifetimes

**Industry name(s):** heap allocation · garbage collection · object lifetime &
retention · unbounded in-memory cache. **Type:** Industry standard.

## Zoom out, then zoom in

Both runtimes are garbage-collected (V8 at build time, Hermes on the phone), so
flattr never frees memory by hand. The interesting memory story isn't
*allocation* — it's *retention*: what gets held alive, for how long, and what
never gets let go. Two structures dominate the run-time heap and neither evicts:
the merged routing graph and the elevation cache.

```
  Zoom out — what lives on the run-time JS heap, and for how long

  ┌─ JS heap (Hermes, GC'd) ────────────────────────────────────┐
  │                                                             │
  │  baseGraph (544 KB) ──── alive for the whole session        │
  │  merged graph = base ⊕ corridor ⊕ view ──── rebuilt per pan │ ← we are
  │   grows as tiles merge in; old merges become garbage        │   here
  │  elevCache `mem` Map ──── grows to MAX_ENTRIES (50k), then  │
  │   trims oldest; persisted to disk                          │
  │  A* working set (open heap, g/came/closed Maps) ──── lives  │
  │   only during one search, then GC'd                        │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **what's retained vs short-lived, and where does memory
pressure come from?** A*'s working set is short-lived (allocated per search,
collected after). The graph and the cache are the long-lived structures, and the
graph in particular has *no eviction* — that's the load-bearing fact.

## Structure pass

**Layers.** Three lifetimes: (1) per-search — A*'s `Map`s and `PQueue`, born and
buried inside one `directedAstar` call; (2) per-session, rebuilt — the merged
graph, regenerated each region change; (3) per-session, accumulating — the
elevCache Map and the bundled `baseGraph`, only ever growing (cache has a cap;
graph does not).

**Axis traced — "when is this memory reclaimed (lifecycle)?"**

```
  One axis — "when is it freed?" — across the heap's structures

  A* open/g/came/closed   → end of the search (no refs after return) → GC'd fast
  merged graph (old)      → next pan rebuilds → old one unreferenced → GC'd
  elevCache mem Map       → entries NEVER expire; trimmed only at 50k cap
  baseGraph               → never (held by useMemo for app lifetime)
  view/corridor regions   → replaced on new build; never explicitly evicted ★
```

**Seam — the `useMemo` dependency arrays.** `graph` and `displayGraph`
(`useTileGraph.ts:132-162`) depend on `[baseGraph, corridor, view]`. Each new
region object makes React drop the old merged graph and build a new one. The seam
is where retention flips: upstream, regions accumulate into ever-growing
`view`/`corridor`; at the `useMemo`, the *previous merged result* becomes garbage.
Old merges are collected; the *inputs* (the regions) are not.

## How it works

### Move 1 — the mental model

You know the GC contract from any JS app: an object lives exactly as long as
something references it, then it's collected on the next sweep. So "managing
memory" in flattr is really "managing references" — who points at what, and when
they stop. The merged graph is the textbook case: each pan builds a new graph
object, the old one loses its last reference, and it's gone. The cache is the
counter-case: nothing ever drops a reference, so it only grows.

```
  Pattern — retention by reference, two fates

   short-lived (A* working set)        long-lived (cache, base graph)
   ┌─────────────────────────┐         ┌──────────────────────────┐
   │ alloc inside search()   │         │ alloc once / accumulate  │
   │ ──► no refs after return│         │ ──► held by module/useMemo│
   │ ──► GC'd next sweep     │         │ ──► alive for the session │
   └─────────────────────────┘         └──────────────────────────┘
        cheap, self-cleaning                 must be bounded by hand
```

### Move 2 — the walkthrough

**Part 1 — A\*'s working set is per-search and self-cleaning.** Every search
allocates fresh structures and holds nothing after returning:

```ts
// features/routing/astar.ts:30-37
const open = new PQueue<string>();           // heap array — grows with frontier
const g = new Map<string, number>();         // best-cost per node
const came = new Map<string, {edge,prev}>(); // back-pointers for reconstruct
const closed = new Set<string>();            // settled nodes
const byId = indexEdges(graph);              // id→edge index, rebuilt EACH call
```

These are local to `search`. When it returns, nothing references them, so they're
collected. The footprint scales with `nodesExpanded`, which the haversine
heuristic keeps small. The one avoidable churn: `byId` (`indexEdges`,
`astar.ts:12-16`) rebuilds a full `Map` over every edge on *every* call — pure
re-allocation each route. Cheap now, but it's allocation you could hoist if A*
ever ran hot. **Inference:** no profiling in the repo confirms this matters yet.

**Part 2 — the merged graph is rebuilt per pan; old copies are garbage.** This is
the biggest churn source:

```ts
// mobile/src/useTileGraph.ts:132-145
const graph = useMemo(
  () => baseGraph
    ? stitchGraph(mergeGraphs([baseGraph, ...corridor, ...view])) // new object each time
    : null,
  [baseGraph, corridor, view]   // ← any change → full rebuild
);
```

`mergeGraphs` (`tiles.ts:89-108`) `Object.assign`s every node/edge into fresh
collections; `stitchGraph` copies the edge array and adjacency again. So each pan
allocates a brand-new full graph (potentially larger than the 544 KB base) and
lets the previous one become garbage. The GC handles it, but the peak — old graph
+ new graph briefly co-resident during the rebuild — is the real-world memory
spike, on a phone.

**Part 3 — the elevCache is the only structure with explicit bounding.** It's the
one place flattr manages a lifetime by hand, because it's the one structure that
would otherwise grow without limit:

```ts
// mobile/src/elevCache.ts:9, 47-52
const MAX_ENTRIES = 50000; // safety cap; oldest entries drop first
...
let entries = [...mem.entries()];
if (entries.length > MAX_ENTRIES) {
  entries = entries.slice(entries.length - MAX_ENTRIES); // keep newest 50k
  mem.clear();
  for (const [k, v] of entries) mem.set(k, v);           // rebuild trimmed Map
}
```

This is a crude FIFO eviction riding on `Map`'s insertion-order guarantee — the
oldest keys are at the front, so `slice` from the end keeps the newest. Each
entry is a string key + a number, so 50k entries is small (low single-digit MB).
The boundary condition: it trims *only at persist time* (`persistNow`), so the
in-memory Map can briefly exceed 50k between persists. Acceptable given the entry
size.

**Part 4 — the regions themselves never evict (the gap).** Contrast Part 3 with
the `view`/`corridor` state: there's no cap, no LRU, no "drop tiles I panned away
from an hour ago." Pan across a city and every viewport's graph stays merged in
forever (until the next region *replaces* the single `view` slot — but a wide
session accumulates corridor data). The merged graph only grows over a long
session.

```
  Comparison — what's bounded vs what isn't

  elevCache         │ merged graph / regions
  ─────────────────┼──────────────────────────
  MAX_ENTRIES cap   │ NO cap
  FIFO trim         │ NO eviction
  persisted to disk │ in-memory only, lost on close
  bounded growth    │ grows with session breadth ★ red flag
```

### Move 3 — the principle

In a GC'd runtime, the bug is never "I forgot to free" — it's "I never stopped
referencing." Short-lived working sets (A*) take care of themselves; the danger
is the structure that quietly accumulates because nothing drops its reference.
flattr bounds the one cache that would explode (elevation) and leaves the one that
*could* explode over a long session (the merged graph) unbounded — a defensible
bet that sessions are short, with no measurement backing it.

## Primary diagram

```
  Run-time heap — every structure by lifetime and bound

  ┌─ JS heap (Hermes, GC) ──────────────────────────────────────┐
  │  PER-SEARCH (auto-freed)                                    │
  │   PQueue + g/came/closed Maps + byId index ── GC'd on return│
  │  PER-PAN (rebuilt, old → garbage)                          │
  │   merged graph = stitch(merge(base, corridor, view))       │
  │   peak = old + new co-resident during rebuild ◄─ spike     │
  │  PER-SESSION, BOUNDED                                       │
  │   elevCache mem Map ── MAX_ENTRIES 50k, FIFO trim, on disk  │
  │  PER-SESSION, UNBOUNDED ◄─ the gap                          │
  │   baseGraph (fixed 544 KB) + accumulating region graphs     │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The split here — auto-managed working sets vs hand-bounded caches — is universal
across GC'd systems. The elevCache's "Map-as-LRU-ish via insertion order" trick is
a known JS idiom (delete + re-set to bump recency; here just slice-the-tail FIFO).
The unbounded merged graph is the same class of issue as an in-memory cache with
no TTL in a long-running server — fine until the process lives long enough to feel
it. On a phone, "process lifetime" is a long-running map session, which makes the
absence of region eviction the one memory item worth a measurement.

## Interview defense

**Q: This is garbage-collected. So memory isn't a concern?**

GC removes manual `free`, not retention bugs. The question is what stays
referenced. A*'s working set self-frees — it's local and unreferenced after
return. The risk is the structures that accumulate: the elevCache (bounded at 50k,
`elevCache.ts:9`) and the merged graph (unbounded — no eviction on
`view`/`corridor`).

```
  where the memory actually goes

  A* working set  → freed per search        (safe)
  elevCache       → capped at 50k + on disk  (bounded by hand)
  merged graph    → grows with session, no cap ◄─ the one to watch
```

Anchor: *"The merged-graph `useMemo` (`useTileGraph.ts:132`) rebuilds a full new
graph object on every pan and the old becomes garbage — so steady-state is fine,
but peak memory is old + new co-resident during the rebuild, on a phone."*

**Q: Why bound the elevation cache but not the graph?**

The cache is the one structure with no natural lifetime — DEM values are valid
forever, so nothing would ever evict them without an explicit cap. The graph
*does* get partly recycled (old merges become garbage each pan), so it doesn't
grow as obviously — but the region *inputs* don't evict, which is the unmeasured
gap. Anchor: `MAX_ENTRIES = 50000` with FIFO trim via Map insertion order.

## See also

- `03-event-loop-and-async-io.md` — the merge `useMemo` is also a CPU block.
- `06-filesystem-streams-and-resource-lifecycle.md` — the cache's disk persistence.
- `07-backpressure-bounded-work-and-cancellation.md` — unbounded growth as overload.
- `.aipe/study-database-systems/` — the cache as a persistent KV store.
