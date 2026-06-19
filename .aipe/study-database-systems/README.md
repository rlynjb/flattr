# Study — Database Systems (flattr)

Generated 2026-06-19 · Mode: CREATE · Generator: `study-database-systems`

## The honest framing

**flattr has no database.** No SQL server, no query engine, no transactions, no
WAL, no replicas. Its canonical store is one prebuilt static artifact —
`mobile/assets/graph.json` (544 KB, 1621 nodes, 1879 edges) — assembled offline
by `pipeline/build-graph.ts` and read once at runtime by `mobile/src/loadGraph.ts`.

So this guide is deliberately split:

- **The storage/index mechanisms the repo DOES exercise** — an immutable
  read-only store, a hand-built secondary index (`adjacency`), a primary-key
  map (`nodes`), a heap-file array (`edges`), bbox partitioning (`tiles.ts`),
  and a bulk-load ETL (the pipeline). These get full, grounded teaching.
- **The database-engine machinery it deliberately does without** — query
  planning, transactions, isolation, locks/MVCC, WAL/recovery, replication. These
  are marked `not yet exercised`, with the activation trigger named for each. We
  do not invent a database that isn't there.

## Reading order

```
  00-overview.md ........................ the map, ranked findings, the not-yet ledger
  01-database-systems-map.md ............ the store, access paths, durability boundary
  02-records-pages-and-storage-layout.md  Node/Edge layout; JSON as page format
  03-btree-hash-and-secondary-indexes.md  adjacency + indexEdges; the missing spatial index
  04-query-planning-and-execution.md .... no planner — hand-coded access paths instead
  05-transactions-isolation-and-anomalies.md ..... not yet exercised (no runtime writes)
  06-locks-mvcc-and-concurrency-control.md ....... not yet exercised (immutable store)
  07-wal-durability-and-recovery.md ..... rebuild-as-recovery; one atomic-write gap
  08-replication-and-read-consistency.md  not yet exercised (one bundled copy)
  09-database-systems-red-flags-audit.md  ranked risks + the not-yet-exercised ledger
```

Files `01`–`04` teach what's real. Files `05`–`08` honestly mark what's absent and
explain what would change. File `09` ranks everything.

## The one trigger to remember

Four of the five absent DB topics (transactions, concurrency control, WAL,
replication) share a single activation trigger: **the first runtime write to
shared state** — e.g. a "report this sidewalk closed" feature. Until flattr lets
users change the data, they all stay correctly dormant. That's scope discipline,
not technical debt.

## Cross-links to sibling guides

- `.aipe/study-data-modeling/` — the *shape* of the graph schema (fields,
  normalization, the signed-grade choice). This guide owns *mechanisms*; that one
  owns *shape*.
- `.aipe/study-dsa-foundations/` — `adjacency` as an adjacency list, the binary
  heap behind `PQueue`, the k-d tree flattr lacks. The index here is a DSA
  structure there.
- `.aipe/study-system-design/` — *why* the store is a build-time artifact, the
  tile read-through cache, and how it would scale.
- `.aipe/study-distributed-systems/` — replication and consistency in the
  live-store case flattr doesn't have yet.

## Key evidence files

- `mobile/assets/graph.json` — the canonical store (the "database")
- `mobile/src/loadGraph.ts` — the load ("connection")
- `features/routing/types.ts` — the `Graph`/`Node`/`Edge` storage schema
- `features/routing/graph.ts` — `buildAdjacency` (the secondary index)
- `features/routing/astar.ts` — `indexEdges` + the hot index-scan access path
- `features/routing/nearest.ts` — the un-indexed full scan
- `features/map/tiles.ts` — bbox partitioning + seam stitching
- `pipeline/build-graph.ts`, `pipeline/run-build.ts` — the bulk-load ETL + the write
- `mobile/src/useTileGraph.ts` — the read-through tile cache + single-flight guard
