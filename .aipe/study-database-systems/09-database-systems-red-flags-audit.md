# Database systems — red-flags audit

**Industry name:** storage-engine & consistency risk audit — *type label:
Project-specific.*

Ranked by consequence. Each finding names the evidence (`file:line`), the
verdict, and the trigger that turns a today-fine choice into a real bug.
flattr has no database, so most "risks" are *absences* — correctly skipped
mechanisms. Two findings are genuine gaps in the code that exists.

## Verdict first

flattr's storage is correct for its workload: an immutable in-memory graph
plus a disposable, best-effort device cache. The two real risks are both
about *change over time*, not about today: an unindexed scan that's cheap at
1750 nodes and a missing schema-version tag that's harmless until the
pipeline and app diverge. Everything else (no transactions, no locks, no WAL,
no replication) is an appropriate absence, listed here so the audit is
honest that each lens was checked.

```
  Risk ranking by consequence

  #1 ███████████  spatial-index gap (O(N) scan)   — perf cliff on growth
  #2 ████████     no graph schema version          — silent corruption on drift
  #3 ████         whole-blob best-effort write      — bounded, reconstructible loss
  #4 ██           no transactional primitive        — absent until 2nd write
  #5 ░░           no WAL/MVCC/lock/replication       — correctly not exercised
```

## #1 — `nearestNode` is an unindexed O(N) full scan

**Evidence:** `features/routing/nearest.ts:5-18` — loops over
`Object.keys(graph.nodes)`, haversine per node, no spatial index. Called at
`mobile/src/MapScreen.tsx:133-134`, twice per route (start + end tap).

**Verdict:** the one place flattr genuinely lacks an index it wants. At
~1750 nodes it's sub-millisecond — shipping it is correct. It's a
**latency cliff, not a bug**: cost is proportional to node count with no
early exit, so it degrades linearly as the graph grows.

**Trigger:** the graph expands past one neighborhood (city-scale, ~100k+
nodes) *or* `nearestNode` starts running on every map pan instead of twice
per route. Either makes the scan visible jank.

**Fix:** build a k-d tree (or geohash buckets) once at `loadGraph` time;
`nearestNode` becomes an O(log N) descent. Contained — only `nearestNode`
changes; A*, adjacency, cost all stay. Maps onto the BST code already in
Rein's reincodes repo (a k-d tree is a BST alternating split axes).
→ deep walk in `03`, cost model in `04`.

## #2 — `graph.json` has no schema version

**Evidence:** `mobile/src/loadGraph.ts:7-11` — `import graph from
"../assets/graph.json"` then `return graph as unknown as Graph` with no
validation. Contrast `mobile/src/elevCache.ts:7`, where the cache key
*is* versioned: `"flattr.elevCache.v1"`.

**Verdict:** a **silent-corruption risk** the day the pipeline and the
bundled artifact disagree. The `as unknown as Graph` cast asserts a shape
nobody checks. If `pipeline/` adds/renames an `Edge` field
(`features/routing/types.ts:10-20`) and the bundled `graph.json` is stale,
the first read of the missing field returns `undefined` — no error, wrong
routes.

**Trigger:** any change to the `Node`/`Edge`/`Graph` shape in `pipeline/`
shipped without regenerating + re-bundling `graph.json`. Today they ship
together so it can't happen; the day they're decoupled (graph served
remotely, or built on a different cadence), it can.

**Fix:** add a `"schemaVersion"` field to `graph.json`, check it in
`loadGraph`, throw on mismatch. One field, one comparison — exactly the
guard the cache already has via its `.v1` key.
→ `02` (layout angle), `07` (recovery angle).

## #3 — elev-cache write is whole-blob, best-effort, unsynchronized

**Evidence:** `mobile/src/elevCache.ts:42-57` — `persistNow` serializes the
entire Map (`JSON.stringify(Object.fromEntries(entries))`) and overwrites the
key; `catch` swallows the error and re-sets `dirty` to retry. No fsync
control, no WAL, no error surfaced.

**Verdict:** **correct for a cache, bounded loss.** Checkpoint-only (no log)
means O(N) per flush — fine under the `MAX_ENTRIES = 50000` cap
(`elevCache.ts:9`), a bottleneck only at far larger sizes. A crash within the
4s debounce window (`PERSIST_DEBOUNCE_MS`, `elevCache.ts:8`) loses unflushed
entries, which the API re-fetches. The async gap at `await setItem`
(`elevCache.ts:51`) is benign because `mem` is append-only (`putElev` no-ops
on existing keys, `elevCache.ts:36`).

**Trigger:** this exact code holding data that is *not* reconstructible —
user routes, preferences, anything without a cloud source of truth. Then
best-effort + lossy-window becomes a data-loss bug.

**Fix (only if the trigger fires):** move non-reconstructible state to
`expo-sqlite` with real transactions, or write-through (no debounce) with a
surfaced error. → durability in `07`, the async gap in `06`.

## #4 — no transactional / multi-write atomicity primitive

**Evidence:** the only write is one `setItem` (`elevCache.ts:53`); the graph
never writes. No `BEGIN/COMMIT`, no combined-write helper anywhere.

**Verdict:** **correctly absent.** A transaction protects a group of writes
that must agree; flattr's write group is size one. Nothing to make atomic.

**Trigger:** the first feature persisting two things that must stay
consistent — saved routes + an index of them, prefs + their version. A crash
between the two writes orphans one.

**Fix:** `expo-sqlite` `BEGIN/COMMIT`, or keep the cache's trick of writing
everything in one key so the group stays size one. → `05`.

## #5 — no WAL, MVCC, locks, or replication

**Evidence:** none present anywhere in `mobile/src` or `features/`.

**Verdict:** **correctly not exercised**, each for a concrete reason:

| Mechanism | Why correctly absent | Trigger to add |
|---|---|---|
| WAL | writes are reconstructible; checkpoint-only suffices | a write you can't recreate (`07`) |
| MVCC | single thread, no concurrent readers-of-writes | a worklet/process reads while main writes (`06`) |
| Locks | event loop serializes; graph immutable | true parallelism on shared state (`06`) |
| Replication | one device, one copy; data immutable | a 2nd copy anywhere (`08`) |
| Isolation levels | one serial writer; no anomalies possible | concurrent transactions (`05`) |

These aren't gaps. A single-device, read-mostly app carrying WAL or MVCC
machinery would be *over-engineering* — the audit lists them to prove each
lens was walked, not to flag a missing feature.

## The honest summary

```
  what to actually do, in order

  NOW:    nothing is broken. Ship as-is.
  SOON:   add graph "schemaVersion" (#2) — 1 field, prevents silent
          corruption the day pipeline/app decouple. Cheap insurance.
  ON GROWTH: k-d tree for nearestNode (#1) when the graph leaves the
          neighborhood. Contained change.
  ON NEW STATE: transactions + real durability (#3/#4) only when flattr
          persists data the API can't hand back.
```

The through-line: every mechanism flattr skips, it skips because its data is
either *immutable* (graph, elevation facts) or *reconstructible* (the cache
from the API). Those two properties delete the need for transactions, locks,
WAL, and replication. The day flattr persists *mutable, irreplaceable* state
is the day this audit's "correctly absent" rows start becoming work.

## See also

- `00-overview.md` — the same findings in the ranked overview.
- `03` (spatial index) · `07` (schema version + durability) · `05`/`06`
  (transactions/concurrency) — the deep walks behind each finding.
