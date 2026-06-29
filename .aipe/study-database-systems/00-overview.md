# Database Systems — flattr (overview)

> Curriculum-style guide. flattr has **no database server** — no Postgres, no
> SQLite, no Mongo, no client to a remote store. So this guide teaches the
> storage-engine and consistency mechanisms a working engineer needs to reason
> about, and *anchors each one to what flattr actually does instead*. Where a
> mechanism is genuinely absent, it's marked `not yet exercised` with the
> concrete trigger that would force it in.

## The verdict first

flattr's "database" is **one immutable, read-only static artifact**:
`mobile/assets/graph.json` (544 KB, 1621 nodes, 1879 edges, 1621 adjacency
entries). It's bundled into the app, loaded once at startup
(`mobile/src/loadGraph.ts:9`), cast to a typed `Graph`, and held in memory for
the process lifetime. There is no write path back to it.

That single choice cascades into every concept in this guide:

```
  flattr's storage shape — one diagram

  ┌─ BUILD TIME (pipeline/, offline) ───────────────────────┐
  │  OSM + Open-Meteo elevation                              │
  │      → split → grade → build-graph → graph.json (artifact)│
  └────────────────────────────┬─────────────────────────────┘
                               │  bundled into the app
  ┌─ RUNTIME (mobile/, on device) ▼──────────────────────────┐
  │  loadGraph() ── reads graph.json once ──► Graph in memory │
  │     nodes: Record<id,Node>   (primary-key map, O(1))      │
  │     adjacency: id→edgeId[]    (hand-built secondary index)│
  │     edges: Edge[]            (array, scanned by nearest)  │
  │                                                           │
  │  elevCache  ── AsyncStorage KV store ──► debounced writes │
  │     the ONLY persistent write path in the whole app       │
  └───────────────────────────────────────────────────────────┘
```

So flattr is two storage stories, not one:

1. **The graph** — a read-only, in-memory artifact. This is where the
   *index-vs-scan* and *storage-layout* lessons live: `nodes` is a primary-key
   hash map, `adjacency` is a hand-built secondary index that makes A* expansion
   O(1) (`features/routing/astar.ts:64`), and `nearestNode` is an **unindexed
   O(N) full scan** (`features/routing/nearest.ts:8`) — the spatial-index gap.

2. **The elevation cache** — `mobile/src/elevCache.ts` uses AsyncStorage as a
   key/value store with **debounced, batched writes**. This is the one place
   flattr touches durability, write batching, and a (very weak) recovery story.

Everything else — transactions, isolation levels, locks, MVCC, WAL, query
planners, replication — is `not yet exercised`. That's not a failing; flattr's
workload doesn't need them. The job of this guide is to teach them anyway, so
that the day flattr grows a real datastore (the spec's Next.js + Postgres
target, `docs/flattr-spec.md` §8), you reach for the right mechanism.

## Ranked findings — what's worth your attention

```
  ranked by consequence — read top-down

  ┌────────────────────────────────────────────────────────────────┐
  │ #1  nearestNode is an O(N) full scan — no spatial index         │ HIGH
  │     features/routing/nearest.ts:8                                │
  │     every tap scans all 1621 nodes. Fine at city-MVP size;      │
  │     the spatial-index gap that bites at metro scale.            │
  ├────────────────────────────────────────────────────────────────┤
  │ #2  graph.json has NO schema version field                      │ HIGH
  │     top-level keys: city, bbox, nodes, edges, adjacency         │
  │     a real gap: a bundled artifact + an app reading it with no  │
  │     handshake. Shape drift = silent breakage on next build.     │
  ├────────────────────────────────────────────────────────────────┤
  │ #3  elevCache write path has no atomicity / no real recovery    │ MED
  │     mobile/src/elevCache.ts:42  single setItem, last-write-wins │
  │     debounced 4s window; a crash inside the window loses writes.│
  ├────────────────────────────────────────────────────────────────┤
  │ #4  adjacency is a derived index with no integrity enforcement  │ MED
  │     features/routing/graph.ts:22  build-time only; if graph.json│
  │     and adjacency disagree, routing silently drops edges.       │
  ├────────────────────────────────────────────────────────────────┤
  │ #5  in-memory merged graph rebuilt per state change (no caching │ LOW
  │     of the join) — useTileGraph.ts:132 stitch on every change.  │
  └────────────────────────────────────────────────────────────────┘
```

The full ranked audit with evidence per verdict is in
`09-database-systems-red-flags-audit.md`.

## Reading order

```
  00-overview.md ......... you are here
  01-database-systems-map ........ the datastore map: artifacts, engines, query
                                   paths, durability boundaries
  02-records-pages-and-storage-layout .. records, pages, locality, the cost of
                                   persistence — flattr's JSON-as-storage choice
  03-btree-hash-and-secondary-indexes .. the nodes hash map, the adjacency
                                   secondary index, and the missing spatial index
  04-query-planning-and-execution ...... what a "query" is in flattr (A* + scan),
                                   plans, N+1, EXPLAIN
  05-transactions-isolation-and-anomalies .. ACID, isolation levels, anomalies —
                                   all not-yet-exercised, taught + triggered
  06-locks-mvcc-and-concurrency-control .. locks, MVCC, optimistic vs pessimistic
                                   — flattr's single-writer in-process model
  07-wal-durability-and-recovery ....... write-ahead logs, fsync, recovery — the
                                   elevCache debounce as the only durability seam
  08-replication-and-read-consistency .. replicas, lag, stale reads — not
                                   exercised; the bundled-artifact analog
  09-database-systems-red-flags-audit .. ranked risks, evidence per verdict
```

## not yet exercised — the honest list

- **Transactions / ACID** — no multi-statement atomic unit anywhere. `→ 05`
- **Isolation levels** — no concurrent readers/writers over shared durable
  state; the elevCache is single-process. `→ 05`
- **Locks / MVCC** — no lock manager, no version chains. `→ 06`
- **WAL** — no write-ahead log; the durability boundary is AsyncStorage's own
  `setItem`. `→ 07`
- **Query planner / optimizer** — A* is a hand-written algorithm, not a planned
  query; there's no cost-based plan selection. `→ 04`
- **Replication / failover** — single device, single artifact. `→ 08`

## Partition (don't look here for these)

```
  study-data-modeling      the SHAPE of the graph schema, normalization, whether
                           Edge[] vs Record matches access — the modeling call.
  study-database-systems   (this) the MECHANISMS that execute & preserve reads
                           and writes — indexes, scans, durability, isolation.
  study-system-design      WHICH datastore is chosen and how it scales.
  study-dsa-foundations    the heap, the graph traversal, Big-O of the algorithms.
  study-performance-engineering  measuring the O(N) scan, profiling the build.
```

Cross-links: `../study-data-modeling/`, `../study-dsa-foundations/`,
`../study-system-design/`, `../study-performance-engineering/`,
`../study-runtime-systems/`.
