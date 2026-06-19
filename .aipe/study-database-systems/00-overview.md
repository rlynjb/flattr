# Database Systems — overview

> Study guide for `flattr`, generated 2026-06-19. Mode: CREATE.
> Honest framing up front: **this repo has no database.** No SQL server, no
> query engine, no transactions, no WAL, no replicas. The canonical store is a
> single prebuilt JSON file (`mobile/assets/graph.json`) that the app reads
> once at startup. Most classic DB-engine topics are therefore `not yet
> exercised` — and this guide says so plainly instead of inventing machinery
> that isn't here. What *is* here is a real storage-and-index story worth
> studying: an immutable read-only artifact, a hand-built in-memory index, and
> a bbox partitioning scheme. We teach those honestly and name what would
> change the day a real DB shows up.

## The one-diagram map

The whole storage surface fits in one picture. The thing a real app would call
"the database" is the box marked `graph.json`.

```
  flattr storage surface — where data lives and who reads it

  ┌─ BUILD TIME (offline ETL, pipeline/) ───────────────────────────┐
  │  Overpass (OSM) ─► parse ─► split ─► elevation ─► grade ─►       │
  │  buildAdjacency()  ───────────────────────────────────►  graph  │
  │                                          JSON.stringify ─► FILE  │
  └───────────────────────────────────────┬─────────────────────────┘
                                           │  graph.json (544 KB,
                                           │  bundled into the app)
  ┌─ RUN TIME (Expo / React Native) ───────▼─────────────────────────┐
  │  import graph from "./graph.json"   ◄── the "database": immutable │
  │           │                              read-only artifact       │
  │           ▼                                                       │
  │  loadGraph(): Graph   ──►  { nodes: Record<id,Node>,  ← PK lookup │
  │                              edges: Edge[],           ← heap file │
  │                              adjacency: Record<id,[]> }← index    │
  │           │                                                       │
  │           ▼                                                       │
  │  A* search reads adjacency[current]  ──►  O(1) neighbor fetch     │
  └───────────────────────────────────────────────────────────────────┘
```

## The verdict — what this repo exercises vs. what it doesn't

**Exercised (real, worth studying):**

| DB concept | flattr analog | Where |
|---|---|---|
| Immutable read-only store | `graph.json`, loaded once | `mobile/assets/graph.json`, `mobile/src/loadGraph.ts:9` |
| Primary-key lookup | `nodes: Record<id, Node>` | `features/routing/types.ts:25` |
| Heap file (unordered rows) | `edges: Edge[]` array | `features/routing/types.ts:26` |
| Hand-built secondary index | `adjacency: Record<id, edgeIds[]>` | `features/routing/graph.ts:22-29` |
| In-memory hash index | `indexEdges()` Map per search | `features/routing/astar.ts:12-16` |
| Full table scan | `nearestNode` loops all nodes | `features/routing/nearest.ts:8-15` |
| Bulk-load / ETL | the `pipeline/` build | `pipeline/build-graph.ts`, `pipeline/run-build.ts` |
| Partitioning / sharding by key | fixed-grid bbox tiles | `features/map/tiles.ts` |
| Read-through cache / lazy load | viewport+corridor tile fetch | `mobile/src/useTileGraph.ts` |

**`not yet exercised` (the DB machinery this repo deliberately does without):**

1. **Query planning & execution** — no query language, no planner, no joins, no
   `EXPLAIN`. Access is direct map/array reads. → `04`
2. **Transactions / atomicity / isolation** — nothing is written at runtime, so
   there's nothing to make atomic or isolate. → `05`
3. **Locks / MVCC / concurrency control** — single reader, immutable data, no
   writers to coordinate. → `06`
4. **WAL / durability / recovery** — the artifact is a static file; "recovery"
   is `npm run build:graph` again. → `07`
5. **Replication / read consistency / failover** — one bundled copy per app;
   no replicas, no lag, no stale-read window. → `08`

## Ranked findings (most consequential first)

1. **The store is immutable and the whole engine is built around that.** No
   write path means the five hardest DB topics collapse to "not applicable."
   This is the single most important fact about the repo's data layer — and
   it's a *strength*, not a gap, for a read-only routing app. (`loadGraph.ts:9`)
2. **`adjacency` is the load-bearing index.** Drop it and A* falls back to
   scanning all 1879 edges per node expansion — O(E) instead of O(1). It's a
   hand-built secondary index, materialized once at build time. (`graph.ts:22-29`)
3. **`nearestNode` is an un-indexed full scan** — O(N) over 1621 nodes on every
   tap-to-snap. Fine at this scale; the first thing a spatial index (k-d tree /
   R-tree) would fix if the graph grew. (`nearest.ts:8-15`)
4. **Tiling is partitioning-by-bbox done by hand**, with a real distributed-data
   problem solved at the seams: independently-built tiles get prefixed ids and
   stitched at coincident coordinates. (`tiles.ts:21-86`)
5. **`indexEdges()` rebuilds a hash index on every search call** — re-paying
   O(E) index-build cost per route. A persistent index would amortize it; at
   MVP scale it's negligible. (`astar.ts:12-16`)

## Reading order

```
  00-overview.md ........... you are here
  01-database-systems-map .. the store, the access paths, the durability boundary
  02-records-pages-...... ... how a Node/Edge is laid out; JSON as the page format
  03-btree-hash-and-...... .. adjacency + indexEdges as indexes; the missing spatial index
  04-query-planning-...... .. there's no planner — what the access paths look like instead
  05-transactions-...... .... not yet exercised — what a write path would need
  06-locks-mvcc-...... ...... not yet exercised — single immutable reader
  07-wal-durability-...... .. the rebuild IS the recovery story
  08-replication-...... ..... not yet exercised — one bundled copy
  09-...red-flags-audit ..... ranked risks + the not-yet-exercised ledger
```

## Cross-links

- `.aipe/study-data-modeling/` — the *shape* of the graph schema (Node/Edge
  fields, normalization, the signed-grade choice). This guide owns the
  *mechanisms*; that guide owns the *shape*.
- `.aipe/study-dsa-foundations/` — `adjacency` as an adjacency list, the binary
  heap behind `PQueue`, A* itself. The index here is a DSA structure there.
- `.aipe/study-system-design/` — *why* the store is a build-time artifact and
  how tiling scales. This guide owns "how reads/writes are preserved"; that one
  owns "which store and how it scales."
