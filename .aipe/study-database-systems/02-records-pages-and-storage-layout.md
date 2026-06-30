# Records, pages, and storage layout

**Industry names:** record layout · page · row-store vs. heap · locality —
*type label: Industry standard (the concepts), Project-specific (the layout).*

## Zoom out, then zoom in

Where does a "record" physically sit in flattr, and what does it cost to
read it? A real database packs rows into fixed-size pages on disk and pays
I/O per page. flattr has no pages and no disk reads in the hot path — every
record is a property on an in-memory object. This file is about *what
replaces the page* when your whole table is a JS object.

```
  Zoom out — where records live

  ┌─ Storage layer ─────────────────────────────────────────────┐
  │                                                             │
  │  ★ graph.json on disk ★   → parsed once → ┌─ Graph object ─┐│ ← we are here
  │   544 KB, one contiguous   (one big read)  │ nodes  {…}    ││
  │   JSON document                            │ edges  […]    ││
  │                                            │ adjacency {…} ││
  │                                            └───────────────┘│
  │                                                             │
  │  ★ elevCache blob ★  → one AsyncStorage value, one rewrite  │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. In a database the unit of I/O is the **page** (typically 8 KB) —
you never read one row, you read the page it sits on, and locality (rows
you query together living on the same page) is everything. flattr collapses
this entirely: there's exactly one read of one document at startup, then
every record is a pointer-chase in RAM. The cost model isn't "pages
touched," it's "objects allocated at parse time." That's the lesson.

## The structure pass

**Layers.** Two storage formats, both serialized JSON: the graph document
(structured: an object of objects + an array) and the cache blob (flat:
string → number). On load, both become JS heap objects.

**Axis — cost of reading one record.** Hold that question down the layers:

```
  Axis: "what does reading ONE record cost?"

  ┌─ on disk (graph.json) ──────────┐  → 0 reads after startup; the
  │  544 KB contiguous JSON         │    whole file is read ONCE
  └─────────────────────────────────┘
      ┌─ in RAM (nodes Record) ─────┐  → O(1) hash lookup by id,
      │  nodes["n42"]               │    one pointer dereference
      └─────────────────────────────┘
          ┌─ in RAM (edges Array) ──┐  → O(N) — no index, must scan
          │  edges.find(e=>e.id===…)│    (see graph.ts:4)
          └─────────────────────────┘

  same "read a record" question, three different costs
```

**Seam.** The boundary is **disk format vs. in-memory layout**. On disk
it's one flat document with no random access. In memory `nodes` becomes a
hash map (random access by PK) but `edges` stays an array (no random
access). The seam is where the storage decision — "object keyed by id" vs.
"array" — determines the runtime cost. flattr made the right call for nodes
and the lazy call for edges.

## How it works

### Move 1 — the mental model

You know the difference between `users[id]` (a lookup table) and
`users.find(u => u.id === id)` (a linear search). That *is* the
records-and-layout story here. The graph picked a hash map for nodes and an
array for edges, and that single shape choice is the difference between O(1)
and O(N) per record.

```
  The layout — two shapes, two cost models

  nodes: Record<id, Node>            edges: Edge[]
  ┌─────────────────────┐           ┌──────────────────────────┐
  │ "n0" → {lat,lng,…}  │ O(1)      │ [0] {id:"e0", from,to,…} │
  │ "n1" → {lat,lng,…}  │ hash      │ [1] {id:"e1", …}         │ O(N)
  │ "n2" → {lat,lng,…}  │ lookup    │ [2] {id:"e2", …}         │ scan
  │  …                  │           │  …                       │ to find
  └─────────────────────┘           └──────────────────────────┘
   random access by PK               sequential access only
```

### Move 2 — the layouts, one at a time

**The node record — keyed, O(1).** A `Node` is four fields
(`features/routing/types.ts:1-6`): `id`, `lat`, `lng`, `elevationM`. They
live in `nodes: Record<string, Node>` (`types.ts:25`). This is a
**clustered primary-key store**: the key *is* the access path. `graph.nodes[id]`
is one hash lookup, exactly like a row fetched by primary key in a real
table — except there's no page I/O, just a property read.

```ts
// features/routing/types.ts:22-28 — the Graph "tables"
export type Graph = {
  nodes: Record<string, Node>;      // PK-indexed table: O(1) by id
  edges: Edge[];                    // heap table: no index, O(N) by id
  adjacency: Record<string, string[]>; // secondary index (see 03)
};
```

**The edge record — array, O(N) by id.** An `Edge` is heavier
(`types.ts:10-20`): id, two endpoints, a polyline `geometry`, length, signed
rise, signed grade, abs grade, kind. Edges live in a plain `Edge[]`. To find
one by id you scan:

```ts
// features/routing/graph.ts:3-7 — the unindexed edge lookup
export function edgeById(graph: Graph, edgeId: string): Edge {
  const edge = graph.edges.find((e) => e.id === edgeId); // ← O(N) linear scan
  if (!edge) throw new Error(`edgeById: no edge with id "${edgeId}"`);
  return edge;
}
```

This is a **heap-organized table**: rows in insertion order, no index, full
scan to find one. It's fine because the hot path (A*) doesn't use
`edgeById` — A* builds its *own* id→edge `Map` once per search
(`astar.ts:12-16`, `indexEdges`) precisely to avoid this scan. That's a
materialized index built at query time. More in `03`.

**The cache record — flat key/value.** The elevation cache is the simplest
layout: a string DEM-cell key → a float elevation
(`elevCache.ts:11`, `Map<string, number>`). On disk it's
`JSON.stringify(Object.fromEntries(entries))` — one flat object, no nesting,
no index. The "record" is one number. Reading one is `mem.get(key)`
(`elevCache.ts:31-33`), O(1) in memory; the disk copy is never read
record-by-record, only loaded whole at startup (`elevCache.ts:17-29`).

### Move 2.5 — the storage-version gap (current vs. future)

Here's the layout flaw worth naming. The cache blob carries a **schema
version in its key**: `"flattr.elevCache.v1"` (`elevCache.ts:7`). Bump the
value shape, bump to `.v2`, and old `.v1` reads simply miss — clean
migration. The graph artifact has **no such tag**:

```
  Comparison — versioned vs. unversioned storage

  CACHE (versioned)              GRAPH (unversioned)
  ┌─────────────────────────┐    ┌──────────────────────────┐
  │ key "...elevCache.v1"   │    │ import graph.json        │
  │ shape changes → ".v2"   │    │ as unknown as Graph      │
  │ old reads miss cleanly  │    │ shape changes → SILENT   │
  │ → safe migration        │    │   mismatch, no detection │
  └─────────────────────────┘    └──────────────────────────┘
```

If `pipeline/` adds or renames an `Edge` field and the bundled `graph.json`
is stale, `loadGraph()` casts it to `Graph` anyway (`loadGraph.ts:10`) and
the first code path that reads the missing field gets `undefined`. The fix
is a one-line `graph.json` `"schemaVersion"` field checked at load. Not
urgent — the pipeline and the app ship together today — but it's the gap
that bites the day they diverge. (Red flag #2; see `07`, `09`.)

### Move 3 — the principle

In a database, *layout is locality*: which rows share a page decides your
I/O. In flattr, layout is *access shape*: which collection (keyed object vs.
array) decides your CPU. The principle survives the move from disk to RAM —
**the storage decision and the query cost are the same decision.** Pick the
keyed object when you look up by that key; pick the array when you only ever
iterate.

## Primary diagram

```
  flattr's three record layouts

  ┌─ graph.json (disk, 544KB, read once) ───────────────────────┐
  │  one contiguous JSON document — no pages, no random access  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ parse at startup → 3 in-RAM shapes
              ┌───────────────┼────────────────────┐
              ▼               ▼                     ▼
  ┌─ nodes ──────────┐ ┌─ edges ─────────┐ ┌─ adjacency ───────┐
  │ Record<id,Node>  │ │ Edge[]          │ │ Record<id,edge[]> │
  │ PK store, O(1)   │ │ heap table,O(N) │ │ secondary idx,O(1)│
  │ 4 fields/record  │ │ 8 fields/record │ │ (see file 03)     │
  └──────────────────┘ └─────────────────┘ └───────────────────┘

  ┌─ elevCache blob (disk + RAM) ───────────────────────────────┐
  │  key "...v1" → flat {string: number} — O(1) get, no index   │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The deeper idea is the **row-store vs. column-store** axis, which flattr
doesn't reach but you should know it's adjacent. A `Node` is a *row* — all
four fields together, good when you read whole nodes (you always do). If you
ever wanted "min elevation across all nodes" repeatedly, a column layout
(one array of elevations) would scan faster by locality. flattr never needs
that, so rows are right. The page concept returns the instant the graph
doesn't fit in RAM and you mmap a SQLite file — then locality is back and
you care which records share a page again.

## Interview defense

**Q: graph.json is 544 KB. Walk me through what reading a node costs.**
Zero disk I/O after startup — the file is parsed once into a `Graph` object.
A node read is `graph.nodes[id]`, one hash lookup, O(1), because nodes are a
`Record<id, Node>` (a PK-clustered store). An edge read by id is different:
`edges` is a plain array, so `edgeById` is an O(N) scan
(`graph.ts:4`). The hot path avoids it by materializing its own id→edge Map
per search.

```
  node by id  → nodes[id]        O(1) hash
  edge by id  → edges.find(…)    O(N) scan ✗
```
*Anchor: nodes are keyed (O(1)), edges are an array (O(N)) — layout IS cost.*

**Q: What's the storage-versioning weakness?**
The cache blob is versioned (`"...v1"` key) so its schema can migrate
cleanly. The graph artifact isn't — `loadGraph` casts the JSON to `Graph`
with no check (`loadGraph.ts:10`). A stale graph after a pipeline shape
change fails silently. One `schemaVersion` field fixes it.
*Anchor: the cache has a version tag; the graph forgot one — silent
mismatch is the bug.*

## See also

- `03-btree-hash-and-secondary-indexes.md` — why `adjacency` is the index
  that makes A* fast.
- `07-wal-durability-and-recovery.md` — the cache blob's write path.
- `09-database-systems-red-flags-audit.md` — the schema-version gap, ranked.
