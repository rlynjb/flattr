# The datastore map

**Industry names:** storage topology · query path · durability boundary —
*type label: Industry standard (the lens), Project-specific (the map).*

## Zoom out, then zoom in

Before any single mechanism, here's the whole storage picture. flattr has
exactly two places data lives, and they could not be more different: a big
immutable read-only artifact, and a tiny mutable cache. Find both on the
map, then we drill in.

```
  Zoom out — flattr's two storage surfaces

  ┌─ UI layer (mobile/src) ─────────────────────────────────────┐
  │  MapScreen.tsx   →   GradeSlider   →   AddressBar           │
  └───────────┬─────────────────────────────────┬───────────────┘
              │ loadGraph() once                 │ tap start/end
              ▼                                   ▼
  ┌─ In-memory store (RAM, process lifetime) ───────────────────┐
  │  ★ graph.json → Graph object ★   nodes · adjacency · edges  │ ← we are here
  │  read-only after startup; routing reads it millions of times│
  └───────────┬─────────────────────────────────────────────────┘
              │ build-time only
              ▼
  ┌─ Persistent store (disk, survives restart) ─────────────────┐
  │  ★ AsyncStorage key "flattr.elevCache.v1" ★  one JSON blob  │ ← and here
  │  the ONLY thing flattr writes at runtime                    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. A database normally answers one question: *given a query, find the
rows fast and don't lose writes.* flattr splits that question in two. The
graph answers "find fast" with hand-built in-memory indexes and never
writes. The cache answers "don't lose writes" with a best-effort blob and
never queries. Neither surface needs the full machine — and seeing *why*
is the whole point of this file.

## The structure pass

Three layers, one axis, one seam.

**Layers.** UI (reads + taps) → in-memory graph (immutable index) →
persistent cache (mutable blob). The pipeline (`pipeline/*`) is a fourth
layer but it runs at *build time*, not runtime — it's the process that
*produces* graph.json, not a query path.

**Axis — who owns mutable state?** Trace it down the stack:

```
  One axis: "who owns mutable state?" — traced down

  ┌─────────────────────────────────────┐
  │ UI layer                            │  → owns ephemeral React state
  └─────────────────────────────────────┘     (startPt, endPt, userMax)
      ┌─────────────────────────────────┐
      │ in-memory graph                 │  → owns NOTHING mutable
      └─────────────────────────────────┘     (frozen after load)
          ┌─────────────────────────────┐
          │ persistent cache            │  → owns the only durable mutable
          └─────────────────────────────┘     state in the app

  the answer flips twice — that's where the seams are
```

**Seam.** The load-bearing boundary is between the immutable graph and the
mutable cache. On the graph side: no writes, so no transactions, no locks,
no recovery. On the cache side: writes happen, so durability suddenly
matters — and that's the only place in flattr where a database mechanism
(durable write) actually shows up. Every other mechanism in this guide is
taught against its *absence* on the graph side.

## How it works

### Move 1 — the mental model

You already know the shape: it's a `fetch()` that loads JSON once, parsed
into an object you read for the rest of the session. The twist is that this
object *is* the database — it has a primary-key index (`nodes`), a
secondary index (`adjacency`), and a heap-fronted query engine (A*) reading
them. flattr reimplemented the read half of a database in plain JS objects
because the dataset is small and static enough to get away with it.

```
  The map as a query-path picture

  TAP (start/end)                ROUTE REQUEST
       │                              │
       ▼                              ▼
  ┌──────────────┐              ┌──────────────────┐
  │ nearestNode  │              │ search() / A*    │
  │ O(N) scan    │              │ heap + relax     │
  │ no index ✗   │              │ uses 2 indexes ✓ │
  └──────┬───────┘              └────────┬─────────┘
         │ reads nodes                   │ reads adjacency + nodes
         ▼                               ▼
  ┌───────────────────────────────────────────────┐
  │           in-memory Graph object               │
  └───────────────────────────────────────────────┘
```

### Move 2 — the surfaces, one at a time

**The graph artifact (the read store).** `graph.json` is 544 KB on disk,
~1750 nodes, bundled into the app binary. At startup `loadGraph()`
(`mobile/src/loadGraph.ts:9-11`) hands the parsed JSON straight back as a
`Graph` with a type assertion:

```ts
// mobile/src/loadGraph.ts:6-11
import graph from "../assets/graph.json";   // bundler parses JSON at build
export function loadGraph(): Graph {
  return graph as unknown as Graph;          // ← no validation; trust the cast
}
```

The `as unknown as Graph` is the whole durability/schema story for the read
store: there is none. The bundler parsed valid JSON, and we *assert* it
matches the `Graph` type. If the pipeline ever changed the Edge shape and
the bundled file went stale, nothing here would catch it. Hold that
thought — it's red flag #2, covered in `02` and `07`.

```
  Layers-and-hops — loading the read store

  ┌─ Build time ─┐  hop 1: bundle graph.json   ┌─ App binary ─┐
  │ pipeline/*   │ ──────────────────────────► │ assets/      │
  └──────────────┘                              └──────┬───────┘
                                          hop 2 │ import (parse)
                                                ▼
                                      ┌─ Runtime (RAM) ──────┐
                                      │ Graph object         │
                                      │ read-only forever    │
                                      └──────────────────────┘
```

**The elevation cache (the write store).** The only runtime writer is
`elevCache.ts`. It's an in-memory `Map<string, number>` mirrored to one
AsyncStorage key (`elevCache.ts:7`, `STORAGE_KEY = "flattr.elevCache.v1"`).
Writes are buffered and flushed on a 4-second debounce
(`elevCache.ts:38-40`). This is the surface where durability, batching, and
versioning live — taught in detail in `07`.

```
  Layers-and-hops — the write store

  ┌─ Runtime ────┐  hop 1: putElev(key,val)   ┌─ in-mem Map ─┐
  │ useTileGraph │ ─────────────────────────► │ mem          │
  └──────────────┘                             └──────┬───────┘
                        hop 2: 4s debounce timer fires │
                                                       ▼
                                          ┌─ Disk (AsyncStorage) ─┐
                                          │ key "...v1" = blob    │
                                          └───────────────────────┘
```

### Move 3 — the principle

A database is a bundle of mechanisms you buy together: indexing,
durability, concurrency, recovery. flattr shows you can *unbundle* them.
The read store buys indexing and skips durability (it's immutable). The
write store buys durability and skips indexing (it's a flat blob). When you
later pick Postgres, you're paying for all of them at once — and this map
is how you'll know which ones you're actually using.

## Primary diagram

```
  flattr's complete storage map

  ┌─ UI (mobile/src/MapScreen.tsx) ─────────────────────────────┐
  │  startPt · endPt · userMax  (ephemeral React state)         │
  └──────┬────────────────────────────────────┬─────────────────┘
         │ nearestNode(graph, pt)              │ build viewport/corridor
         ▼                                      ▼
  ┌─ READ STORE — in-memory, immutable ──┐  ┌─ WRITE STORE — AsyncStorage ─┐
  │ graph.json (544KB) → Graph object    │  │ elevCache.ts                 │
  │  nodes:     Record<id,Node>  PK idx  │  │  mem: Map<string,number>     │
  │  adjacency: id → edgeId[]   2nd idx  │  │  → key "flattr.elevCache.v1" │
  │  edges:     Edge[]          no idx   │  │  debounced whole-blob write  │
  │                                       │  │                              │
  │  query engine: astar.ts search()     │  │  durability: best-effort     │
  │  scan: nearest.ts O(N) ✗ no index    │  │  no txn, no lock, no WAL      │
  └───────────────────────────────────────┘  └──────────────────────────────┘
     reads only; no txn/lock/MVCC/WAL          writes only; no query/index
```

## Elaborate

This two-surface split is the *embedded analytical store vs. operational
cache* pattern, just hand-rolled. SQLite-in-WASM, DuckDB, or a bundled
Parquet file would formalize the read store; AsyncStorage is the standard
RN operational cache. flattr's choice — plain JS objects for both — is the
right call at this size: a 544 KB graph parses in a few ms and the cache is
a few thousand floats. The moment either crosses ~tens of MB, the cost
model in `02` flips and you'd reach for a real embedded engine.

## Interview defense

**Q: flattr has no database. What's the storage architecture?**
Two surfaces. An immutable in-memory read store (graph.json parsed once,
with a primary-key index on nodes and a hand-built secondary index on
adjacency), and a mutable persistent write store (one AsyncStorage blob for
the elevation cache). They're unbundled: the read store has indexing but no
durability story because it never writes; the write store has durability
but no indexing because it never queries.

```
  read store: index, no durability  │  write store: durability, no index
  (immutable → nothing to recover)  │  (flat blob → nothing to query)
```
*Anchor: flattr unbundles the database — index here, durability there,
never both.*

**Q: Where would a real database first earn its place?**
The instant two things become true: the dataset stops fitting in memory, or
a second device needs the same writes. Until then the in-memory graph is
strictly faster and the AsyncStorage blob is strictly simpler.
*Anchor: a DB earns its place when state is shared or doesn't fit in RAM —
flattr has neither.*

## See also

- `02-records-pages-and-storage-layout.md` — how each surface is laid out.
- `03-btree-hash-and-secondary-indexes.md` — the two indexes in detail.
- `00-overview.md` — the ranked findings.
