# Records, pages, and storage layout

**Industry name(s):** physical storage layout / row vs columnar / page-oriented
storage / locality · **Type:** Industry standard.

## Zoom out, then zoom in

This is the layer *underneath* every index and query — how the bytes are
actually arranged on the medium, because that arrangement decides what's cheap
to read and what's expensive to write.

```
  Zoom out — physical storage sits at the bottom

  ┌─ Query layer ───────────────────────────────┐
  │  astar.search() / nearestNode()             │
  └────────────────────────┬─────────────────────┘
  ┌─ Index layer ──────────▼─────────────────────┐
  │  nodes (PK map) · adjacency (2ndary index)   │
  └────────────────────────┬─────────────────────┘
  ┌─ Storage layout ───────▼─────────────────────┐
  │  ★ how records sit in memory / on disk ★     │ ← we are here
  │  graph.json bytes · the Graph object in RAM  │
  └───────────────────────────────────────────────┘
```

Zoom in. A real database doesn't store rows one-at-a-time; it packs them into
**fixed-size pages** (Postgres: 8 KB) and the page is the unit of I/O — you read
a whole page to get one row, you write a whole page to change one row. That
single fact drives row-vs-columnar layout, fill factor, and why an `UPDATE` can
be more expensive than you'd think. flattr has no pages — but it makes the same
*kind* of decision (JSON blob vs in-memory objects, whole-blob rewrite vs
in-place mutation), so it's the perfect place to learn the cost model.

## The structure pass

**Layers** (by storage medium, from cold to hot):
1. **On disk, serialized** — `graph.json` as bytes; AsyncStorage's blob.
2. **In RAM, parsed** — the `Graph` object; the elevCache `Map`.

**Axis traced — "what's the unit of I/O, and what does writing one record
cost?"**

```
  axis — "cost to change ONE record" — across the layers

  ┌─ Postgres (reference) ──────────┐
  │  unit = 8KB page                 │  change 1 row → rewrite 1 page (+ WAL)
  └───────────────┬──────────────────┘
       seam ══════╪══════  (flattr has no page concept)
  ┌─ graph.json (flattr) ───────────┐
  │  unit = whole file               │  change 1 node → rebuild ENTIRE artifact
  └───────────────┬──────────────────┘
       seam ══════╪══════  (different store, different unit)
  ┌─ elevCache (flattr) ────────────┐
  │  unit = whole AsyncStorage blob  │  add 1 key → re-serialize WHOLE map
  └───────────────────────────────────┘
```

The axis-answer is the lesson: flattr's write unit is *the entire dataset*, both
for the graph (rebuild via pipeline) and the cache (whole-`Map` re-serialize at
`elevCache.ts:53`). That's the opposite of page-oriented storage's "touch one
page." It's cheap to *reason about* (no torn pages, no partial writes) and
expensive to *scale* (you can't write 1 of 50,000 entries without rewriting all
50,000). The seam is at the page-vs-blob boundary.

## How it works

### Move 1 — the mental model

You know how a React re-render works: change one piece of state and React
*conceptually* re-derives the whole tree, then diffs. Page storage is the
opposite instinct — change one row and the engine touches *only* the 8 KB page
that row lives on, leaving the other million pages alone. The whole art of
physical layout is making the "touch only what changed" granularity small enough
that writes stay cheap and the records you read together sit *near* each other so
one page read serves many rows.

```
  the pattern — page as the unit of I/O (the reference model)

  table on disk, as 8KB pages:
  ┌─ page 0 ─────┐ ┌─ page 1 ─────┐ ┌─ page 2 ─────┐
  │ row0 row1    │ │ row4 row5    │ │ row8 row9    │
  │ row2 row3    │ │ row6 row7    │ │ row10 row11  │
  └──────────────┘ └──────────────┘ └──────────────┘
        ▲ read this whole page to get row1
        ▲ rewrite this whole page to change row1
   rows that are read together SHOULD live on the same page (locality)
```

flattr replaces "page" with "whole artifact," which is page storage taken to its
limit: page size = file size, one page total.

### Move 2 — flattr's three layout decisions

**Decision 1 — JSON-of-objects, not rows-of-columns.** `graph.json` stores each
node as a self-describing object: `{"id":"n0","lat":47.6231,"lng":-122.327,
"elevationM":53}`. The field names repeat 1621 times. A columnar store would keep
one array of all lats, one of all lngs — better compression, better scan
locality. flattr pays the repetition cost for human-readability and a zero-code
load path (`JSON.parse`, done by the bundler).

```
  row-of-objects (flattr) vs columnar — same data, different layout

  flattr (nodes):                      columnar equivalent:
  { "n0": {lat:47.62, lng:-122.3,…},   lats:  [47.62, 47.62, 47.62, …]
    "n1": {lat:47.62, lng:-122.3,…},   lngs:  [-122.3,-122.3,-122.3,…]
    "n2": {lat:47.62, lng:-122.3,…} }  elevs: [53, 53, 53, …]
       ▲ field names stored 1621×           ▲ field name stored once;
       ▲ one node = one contiguous object   ▲ "all elevations" is one scan
```

For flattr's access pattern — "give me node n0's lat/lng" — row layout wins
(everything about n0 is together). If the heatmap needed "the elevation of every
node, nothing else," columnar would win. The grade heatmap actually reads
*per-edge* `absGradePct` (`features/grade/classify.ts`), so the relevant locality
question is about edges, not nodes — see Decision 3.

**Decision 2 — edges as an array, nodes as a map.** Look at the types
(`features/routing/types.ts:25-27`):

```ts
nodes: Record<string, Node>;   // line 25: keyed → direct address by id
edges: Edge[];                 // line 26: array → positional, scanned to find by id
adjacency: Record<string, string[]>; // line 27: keyed → direct address by node id
```

This is a *physical layout* choice with a query consequence. `nodes` and
`adjacency` get O(1) lookup because they're keyed; `edges` is a flat array, so
"find the edge with id X" is O(E) — which is exactly why `astar.ts:11-16` builds
a *second* in-memory index (`Map<id,Edge>`) every search rather than scanning the
array. The array layout is fine for "iterate all edges" (the heatmap) and bad for
"fetch edge by id" (routing), so routing builds an index over it. That tension
*is* the storage-layout lesson, and `03` picks it up.

**Decision 3 — the whole-blob write unit (elevCache).** When a new elevation is
cached, the entire map is re-serialized:

```ts
// mobile/src/elevCache.ts:47-53 — the whole-blob rewrite
let entries = [...mem.entries()];                       // line 47: snapshot ALL entries
if (entries.length > MAX_ENTRIES) {                     // line 48: cap at 50k
  entries = entries.slice(entries.length - MAX_ENTRIES);// line 49: drop OLDEST (FIFO eviction)
  mem.clear(); for (const [k, v] of entries) mem.set(k, v); // rebuild map in order
}
await AsyncStorage.setItem(STORAGE_KEY,                 // line 53: write the ENTIRE blob
  JSON.stringify(Object.fromEntries(entries)));
```

Line 53 is the cost model in one line: adding *one* elevation value means
serializing and writing *all* of them. At 50,000 entries (the cap, line 9) that's
a meaningful blob. The **debounce** (`PERSIST_DEBOUNCE_MS = 4000`, line 8) is the
mitigation — batch many `putElev` calls into one rewrite every 4 seconds, instead
of rewriting on every cache miss. That's flattr's version of *write coalescing*,
the same instinct a page-storage engine uses when it batches dirty pages before
flushing.

Line 49 is also a real eviction policy: **FIFO** (oldest-inserted dropped first),
relying on `Map`'s insertion-order guarantee. It's not LRU — a frequently-read
old cell still gets evicted before a never-read new one. For DEM cells (which
never change and are equally likely to be revisited) FIFO is a defensible call.

### Move 2.5 — current vs future (the page boundary you'd cross)

```
  Phase A (now): blob storage          Phase B (real engine): page storage

  graph.json: one file, rebuilt whole  Postgres tables: 8KB pages
  elevCache:  one blob, rewritten whole pgvector index: paged
  write unit = dataset                 write unit = page (one row → one page)
  no torn writes possible              torn-page protection needed → WAL (07)
  no fill-factor / vacuum              fill factor, autovacuum, bloat appear
```

What *doesn't* change when you cross: the *logical* schema (`Node`, `Edge`). What
*does*: the write unit shrinks from "everything" to "a page," which is what makes
real concurrent writes affordable — and which drags in WAL, vacuum, and isolation
(the entire back half of this guide). flattr stays on Phase A as long as the
graph is read-only and the cache is single-writer.

### Move 3 — the principle

Storage layout is the decision of *what travels together* — both spatially (which
records sit adjacent, so one read serves many) and temporally (what's the
smallest thing you can write). flattr chose the simplest possible answer (the
whole dataset is the unit) and bought simplicity with it. Every more serious
engine spends enormous effort shrinking that unit to a page so writes stay cheap
at scale. Knowing *why* the unit matters is what lets you read an EXPLAIN that
says "Seq Scan, 8000 pages" and know what it's costing you.

## Primary diagram

```
  flattr storage layout — the full picture

  ┌─ ON DISK / SERIALIZED ───────────────────────────────────────┐
  │  graph.json                          AsyncStorage blob         │
  │  {city,bbox,nodes{},edges[],adj{}}   {"cell":elev, …}          │
  │  write unit = WHOLE FILE             write unit = WHOLE BLOB    │
  │  (rebuilt by pipeline)               (rewritten on debounce)   │
  └───────────────┬───────────────────────────────┬───────────────┘
       JSON.parse │ (by Metro bundler)   JSON.parse│ loadElevCache
  ┌───────────────▼───────────────────────────────▼───────────────┐
  │  IN RAM / PARSED                                               │
  │  Graph object:                       Map<string,number>:       │
  │    nodes  Record  → O(1) by id        getElev O(1)             │
  │    edges  Array   → O(E) by id        putElev O(1) + dirty flag│
  │    adjacency Record→ O(1) by node id  debounced 4s → blob      │
  │  read together: a node + its lat/lng + elev = one object       │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The row-vs-columnar split is the dividing line between OLTP stores (Postgres,
MySQL — row-oriented, optimized for "fetch/update one entity") and analytics
stores (Parquet, ClickHouse, BigQuery — columnar, optimized for "aggregate one
column across millions of rows"). flattr's `nodes` is row-shaped and its access
is OLTP-shaped (point lookups by id), so the layout matches the workload — which
is the whole game. The `study-data-modeling` guide owns *whether the schema shape
matches access*; this guide owns *what that shape costs at the byte level*.

The whole-blob write is also why the elevCache can't lose a *partial* write the
way a paged store can suffer a torn page — `setItem` either lands the whole blob
or doesn't. It trades torn-write risk for "rewrite everything every time," and
the debounce makes that trade affordable. `07` finishes that durability story.

## Interview defense

**Q: "What's the write unit in flattr's storage, and why does it matter?"**

> The whole dataset, in both stores. Changing one node means rebuilding the
> entire `graph.json`; caching one elevation means re-serializing the entire
> `Map` to AsyncStorage (`elevCache.ts:53`). It matters because that's the
> opposite of page storage's "touch one 8KB page" — it's dead simple and torn-
> write-proof, but it can't scale writes, so flattr mitigates with a 4-second
> debounce that coalesces many cache puts into one blob write.

```
  one put ──debounce 4s──► one whole-blob rewrite (coalesced)
  vs page store: one update ──► one 8KB page write
```

Anchor: *flattr's write unit is the entire dataset; the debounce is its write-
coalescing, the page would be its replacement.*

**Q: "Why is `edges` an array but `nodes` a map?"**

> Different access patterns. Nodes are looked up by id constantly (routing,
> nearest), so a keyed `Record` gives O(1). Edges are iterated whole (the
> heatmap) more than fetched by id, so an array is fine — and when routing *does*
> need edge-by-id, `astar.ts:11` builds a transient `Map<id,Edge>` index over the
> array per search rather than paying O(E) per lookup.

Anchor: *layout follows access — keyed for point lookups, array for scans, index
built on demand when a scan-shaped store needs point access.*

## See also

- `03-btree-hash-and-secondary-indexes.md` — the index built over the edge array
- `04-query-planning-and-execution.md` — scans vs index access in flattr's reads
- `07-wal-durability-and-recovery.md` — torn writes and the whole-blob trade
- `../study-data-modeling/` — whether the schema shape matches access
- `../study-performance-engineering/` — measuring the blob-rewrite cost
