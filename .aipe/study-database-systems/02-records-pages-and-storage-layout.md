# Records, pages, and storage layout

**Industry name(s):** record layout / row format / heap file / page · **Type:**
Industry standard (the concepts) applied to a Project-specific layout (JSON
object + array)

## Zoom out, then zoom in

Before the mechanics: a database spends enormous effort deciding how a single
row sits in bytes on a page, because that layout decides read cost. flattr has
the same question — how does one `Node` or `Edge` sit in the store? — but the
answer is "as a JSON object," which trades the DB's tight binary packing for
human-readable text.

```
  Zoom out — record layout sits inside the storage layer

  ┌─ Build layer ───────────────────────────────────────────┐
  │  computeGrades() produces Edge objects                   │
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Storage layer ───────────▼──────────────────────────────┐
  │  graph.json                                              │
  │    ★ HOW each Node/Edge is laid out in bytes ★  ← here   │
  │    nodes: { "n0": {id,lat,lng,elevationM}, ... }         │
  │    edges: [ {id,fromNode,toNode,geometry,...}, ... ]     │
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Runtime layer ───────────▼──────────────────────────────┐
  │  property access: graph.nodes["n0"].elevationM           │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"what is one record, how is it packed, and what does
that packing cost on read?"* The verdict — flattr uses JSON text as its page
format, which is the simplest possible choice and pays for it in size (544 KB
for what binary would do in ~150 KB) but wins on zero serialization code and
human-debuggable data.

## The structure pass

**Layers.** Two record types stacked on a container: the `Graph` envelope
(`city`, `bbox`, and the two collections), the `Node` record, and the `Edge`
record. The container holds the records; the records hold the fields.

**The axis: cost — what does it cost to read one field?** Hold that question
constant across the record types:

```
  Axis = "cost to read one field of one record"

  ┌─ Graph envelope ──────────────────────────────┐
  │  graph.bbox        → direct property, O(1)     │
  └───────────────────────────┬────────────────────┘
  ┌─ Node record (keyed map) ─▼────────────────────┐
  │  graph.nodes["n0"].lat  → hash + property, O(1) │
  └───────────────────────────┬────────────────────┘
  ┌─ Edge record (array elem) ▼────────────────────┐
  │  graph.edges.find(e=>e.id===x) → SCAN, O(E)     │  ← cost flips here
  └───────────────────────────────────────────────────┘
```

**Seams.** The load-bearing seam is *between how `nodes` is stored and how
`edges` is stored*. Same data model, two different physical layouts: `nodes` is
a **keyed map** (hash-indexed by id — O(1) record fetch), `edges` is a **plain
array** (heap file — O(E) to find one by id). That asymmetry is the whole reason
`adjacency` and `indexEdges()` exist (file `03`): they're indexes bolted onto
the array to give it the map's O(1) lookup.

## How it works

### Move 1 — the mental model

You know a DB table as rows-in-pages: fixed-ish-size records packed into
fixed-size blocks, an offset to find a field. flattr's "page" is a JSON object
and its "record" is a JSON object literal. Same idea — a record is a bundle of
named fields — but the addressing is by JSON key, not byte offset.

```
  The pattern — two physical layouts for records

  nodes: KEYED MAP (hash index built in)        edges: ARRAY (heap file)
  ┌───────┬──────────────────────────┐          ┌───┬──────────────────────┐
  │ "n0"  │ {id,lat,lng,elevationM}   │          │ 0 │ {id,fromNode,toNode,..}│
  │ "n1"  │ {id,lat,lng,elevationM}   │          │ 1 │ {id,fromNode,toNode,..}│
  │ "n2"  │ {id,lat,lng,elevationM}   │          │ 2 │ {id,fromNode,toNode,..}│
  └───────┴──────────────────────────┘          └───┴──────────────────────┘
   lookup by key: O(1)                            lookup by id: scan O(E)
```

### Move 2 — the moving parts

#### A `Node` is a fixed-shape record, stored value-by-key

Every `Node` has exactly four fields: `id`, `lat`, `lng`, `elevationM` — all
scalars, no nesting. This is the closest thing flattr has to a classic
fixed-width row. Because `nodes` is `Record<string, Node>`, the record is
addressed by its own `id` as the map key, so the id is stored *twice* (once as
the key, once inside the record). That redundancy is the cost of using the id as
both the primary key and the lookup handle.

What breaks if you drop the redundancy: code that iterates `Object.values(nodes)`
(like `nearestNode`) needs `n.id` on the record; code that does `nodes[id]`
needs the key. Both paths exist, so both copies are load-bearing.

#### An `Edge` is a variable-size record — geometry is the heavy field

```
  Edge record — fixed scalars + one variable-length field

  ┌──────────────────────────────────────────────────────────┐
  │ id        "e123"           ← scalar                        │
  │ fromNode  "n0"             ← foreign key into nodes        │
  │ toNode    "n5"             ← foreign key into nodes        │
  │ lengthM   42.3             ← scalar                        │
  │ riseM     1.2              ← scalar (signed)               │
  │ gradePct  2.8              ← scalar (signed, from→to)      │
  │ absGradePct 2.8            ← scalar (denormalized: |grade|)│
  │ kind?     "residential"    ← optional scalar               │
  │ geometry  [[lat,lng],...]  ← VARIABLE-LENGTH array  ◄──────┼── the heavy
  └──────────────────────────────────────────────────────────┘    field
```

The `geometry` polyline is what makes edges variable-size and is most of the 544
KB. Everything else is a fixed scalar. Note `absGradePct` is **denormalized** —
it's just `|gradePct|`, precomputed at build so the heatmap doesn't recompute an
abs() per edge per render. That's a classic storage-vs-compute trade: spend
bytes to save runtime work (data-modeling guide covers the schema rationale).

#### The "page format" is JSON text, not binary

A real DB packs records into binary pages with offsets and length prefixes.
flattr's page format is UTF-8 JSON. The cost: bytes (numbers like
`47.6181234` cost ~9 chars instead of 8 binary bytes, keys are repeated on every
record), and a one-time parse at load. The win: zero serialization code, and you
can open the store in any text editor to debug it.

```
  Layers-and-hops — record bytes to in-memory field

  ┌─ Storage (disk/bundle) ─┐  hop 1: bundler reads JSON text  ┌─ Runtime ──┐
  │ {"id":"n0","lat":47.6,  │ ────────────────────────────────►│ {id:"n0",  │
  │  "lng":-122.3,...}       │  hop 2: JSON.parse → JS object   │  lat:47.6} │
  └─────────────────────────┘  (numbers → IEEE doubles)        └─────┬──────┘
                                                                      │ hop 3
                                                            property access O(1)
                                                                      ▼
                                                                 n.elevationM
```

### Move 3 — the principle

**Physical layout is where logical access patterns get their cost.** The same
`Edge` data could be a map (O(1) by id) or an array (O(E) by id); flattr chose
array, then *separately* built indexes to recover fast lookup. The general
lesson: a record's storage layout and its index are two different decisions, and
when the layout doesn't serve an access pattern, you add an index rather than
reshape the records. That's exactly what file `03` is about.

## Primary diagram

The full storage layout, both record types and the envelope.

```
  graph.json — full storage layout

  ┌─ Graph envelope ─────────────────────────────────────────────────┐
  │  city: "seattle-mvp"                                              │
  │  bbox: [-122.3284, 47.6181, -122.3214, 47.6241]  ← partition key │
  │                                                                   │
  │  nodes: Record<id,Node>  ── KEYED MAP (O(1) by id) ──────────┐    │
  │    "n0" → {id, lat, lng, elevationM}        ← fixed record   │    │
  │    "n1" → {id, lat, lng, elevationM}                         │    │
  │    ... 1621 records                                          │    │
  │                                                              ┘    │
  │  edges: Edge[]  ── ARRAY / heap file (O(E) by id) ───────────┐    │
  │    [0] {id, fromNode, toNode, geometry[], lengthM, riseM,    │    │
  │         gradePct, absGradePct, kind?}   ← variable record    │    │
  │    ... 1879 records (geometry is the heavy field)            │    │
  │                                                              ┘    │
  │  adjacency: Record<id,id[]>  ── the index over edges (file 03)    │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The record layout decides the cost of every read in the app. A*
expanding a node reads `graph.nodes[next]` (the keyed-map win, O(1)); the
heatmap maps over `graph.edges` building GeoJSON (a full scan of the heap file,
which is fine because the heatmap *wants* every edge anyway).

**The record schemas — `features/routing/types.ts` (lines 1-28):**

```
  export type Node = {            ← the fixed-shape record
    id: string;                   ← PK, also used as the map key (stored twice)
    lat: number;  lng: number;    ← scalars
    elevationM: number;           ← scalar
  };

  export type Edge = {            ← the variable-shape record
    id: string;
    fromNode: string;             ← FK into nodes (no enforcement; see below)
    toNode: string;               ← FK into nodes
    geometry: [number,number][];  ← variable-length: the heavy field
    lengthM: number; riseM: number;
    gradePct: number;             ← signed from→to
    absGradePct: number;          ← DENORMALIZED |gradePct|, precomputed at build
    kind?: EdgeKind;              ← optional
  };
       │
       └─ FKs (fromNode/toNode) are plain strings. Nothing enforces that they
          point at a real node — the build pipeline is trusted to produce valid
          references. In a real DB this would be a FK constraint; here it's an
          unchecked invariant (a red-flag-audit item, file 09).
```

**The layout asymmetry, made concrete — `features/routing/graph.ts` (lines 3-7):**

```
  export function edgeById(graph: Graph, edgeId: string): Edge {
    const edge = graph.edges.find((e) => e.id === edgeId);  ← O(E) SCAN of the
    if (!edge) throw new Error(...);                          heap file, every call
    return edge;
  }
       │
       └─ this is the direct consequence of storing edges as an array: finding
          one edge by id is a linear scan. nearestNode pays this implicitly;
          A* refuses to and builds indexEdges() instead (file 03). Without the
          array layout this function wouldn't need to exist — a keyed map would
          give edgeById O(1) for free.
```

**The artifact, measured (`mobile/assets/graph.json`):** 544313 bytes, 1621
node records, 1879 edge records, one bbox. The `geometry` arrays dominate the
size — they're the variable-length field across ~1879 records.

## Elaborate

The records-and-pages vocabulary comes from disk-based DBs, where the unit of
I/O is a fixed-size page (commonly 4–16 KB) and the art is packing rows so the
fewest pages get read per query. flattr sidesteps all of that: the entire store
is one "page" loaded in a single read, so there's no page-packing decision, no
fill factor, no row-vs-column choice to make. The record-layout lessons that
*do* transfer are: (1) fixed vs variable-length fields (geometry is the variable
one), (2) denormalization as a storage-for-compute trade (`absGradePct`), and
(3) layout choosing access cost (map vs array → file `03`).

If flattr grew past memory limits — say a whole-city graph at 50 MB — the page
question would come back hard: you'd want a format you can read in chunks
(SQLite, or a tiled binary), not a 50 MB JSON you must parse whole. The tiling
in `features/map/tiles.ts` is the first step toward that (file `01` and the
system-design guide).

What to read next: `03`, where the array layout's cost gets fixed by indexes.

## Interview defense

**Q: "How is a single record stored, and what does the layout cost you?"**

> Two record types. A `Node` is a fixed four-scalar record stored in a keyed map
> by its id — O(1) to fetch one. An `Edge` is variable-size — its `geometry`
> polyline is the heavy field — and it's stored in a plain array, so finding one
> by id is an O(E) scan. That array layout is exactly why `adjacency` and
> `indexEdges()` exist: they're indexes that buy back O(1) lookup the array
> doesn't give. The page format is JSON text, which costs size and a parse but
> needs zero serialization code.

```
  nodes: map → O(1) by id        edges: array → O(E) by id → so we add an index
```

Anchor: *layout chooses access cost; when it's wrong, you add an index, not
reshape the records.*

**Q: "Why is `absGradePct` stored when it's just `|gradePct|`?"**

> Denormalization — a storage-for-compute trade. The overview heatmap colors
> every edge by steepness on every render; precomputing the abs at build means
> the render never does `Math.abs` across 1879 edges. We spend a few bytes per
> record to save runtime work. It's safe because the store is immutable, so the
> derived field can't drift from its source.

```
  build: absGradePct = |gradePct|  ──►  render reads it directly (no recompute)
```

Anchor: *immutable store makes denormalization safe — the copy can't drift.*

## Validate

1. **Reconstruct:** draw the `Graph` envelope with both collections, marking
   which is a keyed map and which is an array, and which field is variable-length.
2. **Explain:** why is `edgeById` (`features/routing/graph.ts:3-7`) O(E) while
   `graph.nodes[id]` is O(1)? Tie it to the storage layout, not the algorithm.
3. **Apply:** the heatmap reads every edge (`features/map/geojson.ts:21`). Is the
   array layout a problem here? (No — a full scan is exactly what "color every
   edge" wants; the array is the right layout for that access pattern.)
4. **Defend:** someone wants to drop `absGradePct` to shrink the file. What's
   your argument for keeping it, grounded in `types.ts:18` and the immutability
   of the store?

## See also

- `01-database-systems-map.md` — the store these records live in
- `03-btree-hash-and-secondary-indexes.md` — the indexes that fix the array's
  O(E) lookup
- `.aipe/study-data-modeling/` — *why* the schema has these fields and the
  signed/abs grade split (the shape; this file owns the layout/cost)
