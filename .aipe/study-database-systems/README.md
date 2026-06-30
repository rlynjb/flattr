# Study — Database Systems (flattr)

Curriculum-style guide to the storage and consistency mechanisms beneath
flattr. **flattr has no database** — that's the subject, not a gap. The guide
teaches each database mechanism anchored to what flattr does *instead*: an
immutable in-memory graph (`mobile/assets/graph.json` → `loadGraph.ts`) and
one best-effort device cache (`mobile/src/elevCache.ts`).

## Reading order

| # | File | What it covers |
|---|---|---|
| 00 | `00-overview.md` | The two storage surfaces, ranked findings, `not yet exercised` inventory |
| 01 | `01-database-systems-map.md` | The datastore map: read store vs. write store, query paths |
| 02 | `02-records-pages-and-storage-layout.md` | How graph.json + the cache blob are laid out; the cost model |
| 03 | `03-btree-hash-and-secondary-indexes.md` | The two indexes flattr HAS (nodes, adjacency), the one it lacks (spatial) |
| 04 | `04-query-planning-and-execution.md` | A* as an indexed query plan vs. nearestNode as a seq scan; N+1 avoidance |
| 05 | `05-transactions-isolation-and-anomalies.md` | Why there are none; the trigger for the first transaction |
| 06 | `06-locks-mvcc-and-concurrency-control.md` | The event loop as the lock; the one benign async race |
| 07 | `07-wal-durability-and-recovery.md` | The debounced blob write as a durability model; the schema-version gap |
| 08 | `08-replication-and-read-consistency.md` | One device, one copy; eventual consistency if sync ever arrives |
| 09 | `09-database-systems-red-flags-audit.md` | Ranked risks with evidence and triggers |

## The two real findings

1. **Spatial-index gap** — `nearestNode` (`nearest.ts:5-18`) is an O(N) full
   scan, fine at 1750 nodes, a latency cliff on growth. → `03`, `09`.
2. **No graph schema version** — `loadGraph.ts:10` casts JSON to `Graph`
   unchecked; the cache is versioned (`elevCache.ts:7`), the graph isn't.
   Silent corruption the day pipeline/app diverge. → `02`, `07`, `09`.

## The through-line

Every mechanism flattr skips (transactions, locks, MVCC, WAL, replication),
it skips because its data is **immutable** (the graph, elevation facts) or
**reconstructible** (the cache, from the API). Those two properties delete
the need for the whole database machine.

## Sibling guides (cross-links)

`study-data-modeling` (the data *shape*) · `study-dsa-foundations` (the heap
+ A* as algorithms) · `study-system-design` (which store, how it scales) ·
`study-performance-engineering` (the O(N) scan as a budget) ·
`study-runtime-systems` (the event loop) · `study-distributed-systems` (if
sync arrives).
