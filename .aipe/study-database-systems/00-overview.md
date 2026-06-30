# Database Systems — flattr overview

> Curriculum-style guide. flattr has **no database** — no SQLite, no
> Postgres, no Supabase, no ORM. The only persistence is one AsyncStorage
> key/value blob (`mobile/src/elevCache.ts`). That is not a gap in this
> guide; it is the subject. The storage-engine mechanisms a real database
> gives you for free — indexes, transactions, MVCC, WAL, replication —
> are taught here *against what flattr actually does instead*, so when you
> later reach for Postgres you recognize which mechanism you're buying.

## The verdict first

flattr is a **read-mostly, in-memory graph application** with one tiny
persistent cache. The "datastore" is a 544 KB JSON file
(`mobile/assets/graph.json`, ~1750 nodes) bundled into the app and loaded
once at startup into a plain JS object. Everything routing touches lives in
RAM for the process lifetime.

That single design decision — *the whole dataset fits in memory and never
changes at runtime* — is why flattr doesn't need a database. It deletes the
need for every mechanism this guide teaches:

```
  Why flattr exercises almost no DB mechanism

  graph.json (544 KB, immutable)
        │  loaded once at startup
        ▼
  ┌──────────────────────────────────────────┐
  │  in-memory Graph object                   │
  │   nodes: Record<id, Node>   ← PK index    │  ← O(1) lookup, free
  │   adjacency: Record<id, edgeId[]>         │  ← secondary index, hand-built
  │   edges: Edge[]                           │  ← no index → O(N) scans
  └──────────────────────────────────────────┘
        │
        │  no writes at runtime → no transactions, no locks,
        │  no MVCC, no WAL, no recovery, no replication
        ▼
  the ONLY write path: elevCache.ts → AsyncStorage (one blob)
```

A database is a machine for **safely sharing mutable state across
concurrent writers and surviving crashes**. flattr shares nothing mutable
and crashes lose nothing important. So it skips the machine.

## The map (where each mechanism lives, or doesn't)

```
  flattr storage surfaces, by mechanism

  ┌─ in-memory graph (graph.ts, astar.ts, nearest.ts) ──────────┐
  │  primary index   nodes: Record<id,Node>      O(1) PK lookup │  ← exercised
  │  secondary index adjacency: id → edgeId[]     O(1) expansion │  ← exercised
  │  full scan       nearest.ts over all nodes    O(N) per tap   │  ← exercised (the gap)
  │  transactions / isolation / MVCC / locks                     │  ← not exercised
  │  WAL / recovery / replication                                │  ← not exercised
  └──────────────────────────────────────────────────────────────┘
  ┌─ persistent cache (elevCache.ts → AsyncStorage) ────────────┐
  │  storage layout  one JSON blob under key "...v1"            │  ← exercised
  │  durability      debounced whole-blob rewrite, best-effort  │  ← exercised
  │  versioning      ".v1" key suffix = a schema version tag     │  ← exercised
  │  transactions / concurrency control                          │  ← not exercised
  └──────────────────────────────────────────────────────────────┘
```

## Ranked findings (consequence-ordered — full audit in `09`)

1. **`nearestNode` is an unindexed O(N) full scan**
   (`features/routing/nearest.ts:5-18`). Every start/end tap walks all
   ~1750 nodes. This is the one place flattr *needs* an index it doesn't
   have — a spatial index. Today it's cheap; it stops being cheap the
   moment the graph grows past a neighborhood. → `03`, `04`, `09`.

2. **`graph.json` has no schema version**
   (`mobile/src/loadGraph.ts:7`, the `as unknown as Graph` cast). The cache
   tags its blob `flattr.elevCache.v1`; the graph does not. A pipeline
   change to the Edge shape silently mismatches an old bundled graph with
   no detection. → `02`, `07`, `09`.

3. **The elev-cache write is whole-blob, best-effort, and unsynchronized**
   (`elevCache.ts:42-57`). Every persist serializes the entire Map and
   overwrites the key. No partial writes, no WAL, no lock — a concurrent
   `persistNow` could lose entries. In practice JS is single-threaded so
   this is benign, but it's the seam where a real durability story would
   go. → `07`, `09`.

4. **No transactional boundary anywhere.** The graph never mutates;
   the cache's "transaction" is one `setItem`. Correct for the workload,
   but it means there's no atomic multi-write primitive if the app ever
   grows one (saved routes, user prefs as structured data). → `05`, `06`.

## Reading order

```
  00  overview ......................... you are here
  01  database-systems-map ............. the storage surfaces + query paths
  02  records-pages-and-storage-layout . how graph.json + the blob are laid out
  03  btree-hash-and-secondary-indexes . the two indexes flattr HAS, the one it lacks
  04  query-planning-and-execution ..... A* expansion vs the nearest-node scan
  05  transactions-isolation-anomalies . why there are none, when you'd need them
  06  locks-mvcc-and-concurrency ....... single-threaded JS as the concurrency story
  07  wal-durability-and-recovery ...... the debounced blob write as a durability model
  08  replication-and-read-consistency . one device, one copy — and what changes if not
  09  red-flags-audit .................. ranked risks with evidence
```

## `not yet exercised` — honest inventory

| Mechanism | flattr status | Trigger that makes it relevant |
|---|---|---|
| Transactions / atomicity | not exercised | first multi-row write (saved routes + index) |
| Isolation levels | not exercised | first concurrent writer (sync to a server) |
| MVCC | not exercised | first reader that must not see a half-write |
| Pessimistic / optimistic locks | not exercised | two devices writing the same record |
| WAL | not exercised | a write you cannot afford to lose on crash |
| Recovery / restore | not exercised | persistent user data worth backing up |
| Replication / read replicas | not exercised | a second device or a server copy |
| Spatial index | **gap** (O(N) scan today) | graph grows past one neighborhood |
| Schema versioning (graph) | **gap** (no version tag) | any Edge-shape change in the pipeline |

Each row is taught in the file that owns it, with the trigger spelled out
so you know *when* to reach for the mechanism — not before.

## See also (sibling guides)

- `study-data-modeling` — the *shape* of the graph data (Node/Edge schema,
  the signed-grade decision). This guide owns the *mechanisms*; that one
  owns the *shape*.
- `study-dsa-foundations` — the binary heap (`pqueue.ts`) and A* itself as
  algorithms. Here we treat the heap as a query-execution operator.
- `study-system-design` — *which* store to pick and how it scales.
- `study-performance-engineering` — the O(N) scan as a latency budget.
- `study-runtime-systems` — the single-threaded event loop that makes
  flattr's "concurrency control" free.
