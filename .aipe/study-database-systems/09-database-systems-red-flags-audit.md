# Database systems — red-flags audit

**Industry name(s):** storage-engine risk audit / consistency-risk review ·
**Type:** Project-specific.

> Ranked by consequence. Every verdict names its evidence (`file:line`),
> distinguishes observed behavior from inference, and states the trigger that
> turns a today-acceptable simplification into a real bug. flattr has *no
> database*, so most "classic" DB risks are `not yet exercised` — those are listed
> honestly at the end, not padded into the ranking.

## Zoom out, then zoom in

```
  Zoom out — where the risks live in flattr's storage map

  ┌─ BUILD ──────────────────────────────────────────────────┐
  │  pipeline → graph.json   ◄── #2 no schema version         │ ← HIGH
  │                          ◄── #4 unenforced adjacency       │ ← MED
  └────────────────────────────┬─────────────────────────────┘
  ┌─ READ (in-memory) ─────────▼─────────────────────────────┐
  │  nearestNode O(N) scan     ◄── #1 no spatial index        │ ← HIGH
  │  mergeGraphs re-stitch     ◄── #5 uncached join           │ ← LOW
  └────────────────────────────┬─────────────────────────────┘
  ┌─ WRITE (elevCache) ────────▼─────────────────────────────┐
  │  debounced setItem         ◄── #3 durability window       │ ← MED
  └───────────────────────────────────────────────────────────┘
```

Zoom in. The two HIGH risks are both *seam* problems (`01`): the missing spatial
index is a read-path latency cliff, and the missing schema version is a contract
gap at the build→read boundary. Neither bites at MVP scale — both are the kind of
thing that's invisible until exactly the moment the project succeeds.

## The structure pass

**Axis traced — "is this a bug *now*, or a bug *at the trigger*?"** Every finding
is acceptable at the current scale; the audit's job is to name the trigger that
flips each one. Ordering is by *consequence × likelihood-of-hitting-the-trigger*.

## How it works — the ranked findings

### #1 — `nearestNode` is an O(N) full scan (no spatial index) · HIGH

**Evidence (observed):** `features/routing/nearest.ts:8` loops over every node:
```ts
for (const id of Object.keys(graph.nodes)) {       // scans ALL 1621 nodes
  const d = haversine(point, { lat: n.lat, lng: n.lng });
```
**Consequence:** every route-endpoint tap is O(N). At 1621 nodes (current
`graph.json`), microseconds — fine. The cost grows linearly with the graph; the
merged graph (`useTileGraph`) makes N grow as the user pans, so it's already not
fixed at 1621.

**Trigger:** a metro-scale graph (10⁵–10⁶ nodes). Then each tap is a visible
stall on the UI thread.

**Fix:** a spatial index — k-d tree / R-tree / geohash grid built once at load,
turning the scan into O(log N). Post-Postgres migration: PostGIS `ORDER BY geom
<-> point LIMIT 1` on a GiST index. `→ 03` for the full walk.

```
  now: O(N) per tap (fine) ──trigger: big graph──► O(N) per tap (laggy)
  fix: spatial index ──► O(log N) per tap
```

### #2 — `graph.json` has no schema version field · HIGH

**Evidence (observed):** top-level keys of `graph.json` are exactly
`city, bbox, nodes, edges, adjacency` — no `version` / `schemaVersion`. The reader
casts blind: `graph as unknown as Graph` at `mobile/src/loadGraph.ts:10`, zero
runtime validation.

**Consequence:** the build→read seam (`01`) has *no contract*. If `build-graph.ts`
changes the shape (renames `adjacency`, changes `gradePct` sign convention,
restructures `edges`), an app shipped against the old shape compiles and "loads"
fine, then crashes deep in A* (`undefined` index) or — worse — routes *silently
wrong* (e.g. a sign-convention flip inverts uphill/downhill, the project's entire
point). The two programs that must agree (pipeline, app) are coupled only by a
TypeScript type that's erased at runtime.

**Contrast that flattr already gets right:** the elevCache *does* version its
namespace — `STORAGE_KEY = "flattr.elevCache.v1"` (`elevCache.ts:7`). Bump to
`.v2` and old blobs are ignored cleanly. `graph.json` lacks exactly this.

**Trigger:** any pipeline schema change shipped out of lockstep with the app — a
near-certainty over the project's life.

**Fix:** add `"schemaVersion": N` to `graph.json`; have `loadGraph` assert it and
fail loud on mismatch (or run a lightweight runtime validator). `→ 01`, `→ 08`.

```
  pipeline (shape vN) ──no handshake──► app (expects shape vN)
  shape drifts → silent crash OR silent wrong routing
  fix: schemaVersion field + assert on load (fail loud)
```

### #3 — elevCache durability window; no atomicity / weak recovery · MED

**Evidence (observed):** `mobile/src/elevCache.ts:39` schedules a 4-second
debounced flush; `:53` is a single whole-blob `setItem`; `:56` re-marks `dirty`
on failure; `:26` swallows a corrupt blob and starts empty.

**Consequence:** up to 4 seconds of cached elevations are lost on a crash, and a
corrupt persisted blob is silently discarded. **Acceptable today** — the data is
re-fetchable cache, so the cost of loss is a re-fetch (and the cost of corruption
is a cold cache). It is *not* acceptable for any non-re-derivable data.

**Trigger:** storing user-authored data (saved routes, prefs, sync state) through
the same debounced pattern. Then the 4s window and the swallow-corruption recovery
become real data loss.

**Fix:** for re-derivable cache, leave it. For durable data, write synchronously on
the critical path or move to an engine with a WAL; surface corruption instead of
swallowing it. `→ 07`.

### #4 — `adjacency` is a derived index with no integrity enforcement · MED

**Evidence (observed):** `adjacency` is built from `edges` at build time
(`features/routing/graph.ts:22`). Nothing at runtime checks that `graph.json`'s
`adjacency` is consistent with its `edges` — A* trusts it blindly
(`astar.ts:64`).

**Consequence:** if a build emits an `adjacency` that references a dropped edge or
omits a present one, routing silently traverses a ghost edge or misses a real one
— no error, just wrong paths. It's an index that can drift from the data
(`03`'s load-bearing-skeleton lesson: the sync is the part that breaks).

**Trigger:** any pipeline bug or hand-edit that desyncs `adjacency` from `edges`.

**Fix:** validate on load (every `adjacency` edgeId exists in `edges`; every edge's
endpoints appear in `adjacency`), or rebuild `adjacency` from `edges` at load
instead of trusting the persisted copy. `→ 03`.

### #5 — merged graph re-stitched on every change; per-search index rebuild · LOW

**Evidence (observed):** `useTileGraph.ts:132-145` recomputes the full
`mergeGraphs → stitchGraph` whenever `[baseGraph, corridor, view]` changes (the
`useMemo` deps), with no caching of the join result. Separately, `astar.ts:11`
rebuilds the `byId` edge index (O(E)) on every search.

**Consequence:** the join (`04`'s materialized-view-with-no-caching) and the
per-search index build are both redundant work. **Negligible now** — three small
inputs, ~1879 edges. The seed of an N+1-shaped cost if tiles multiply or routing
is called in a tight loop.

**Trigger:** many merged tiles, or high-frequency routing (live re-route on
movement).

**Fix:** memoize the stitch incrementally; hoist `indexEdges` to load time (build
`byId` once with the graph). `→ 04`.

### Move 3 — the principle

Every finding here is the same shape: a simplification that's *correct at the
current scale* and becomes a bug *at a named trigger*. That's the honest way to
audit a small codebase — not "this is wrong" but "this is right until X, and X is
likely/unlikely." The two HIGH items (spatial index, schema version) are the ones
whose triggers are near-certain over the project's life; the rest are gated on
features flattr hasn't built. An audit that can't name the trigger is just
opinion.

## Primary diagram

```
  the ranked board — finding × evidence × trigger

  rank  finding                     evidence              trigger
  ────  ──────────────────────────  ────────────────────  ────────────────────
  #1 H  nearestNode O(N) scan       nearest.ts:8          big graph → laggy taps
  #2 H  no schema version           graph.json keys;      pipeline shape drift →
        on graph.json               loadGraph.ts:10        silent crash/wrong route
  #3 M  durability window +         elevCache.ts:39,53,   durable user data →
        swallow-corruption          26                     real data loss
  #4 M  adjacency unenforced        graph.ts:22;          desynced index →
        vs edges                    astar.ts:64            silent wrong paths
  #5 L  uncached merge / per-       useTileGraph.ts:132;  many tiles / hot loop →
        search index rebuild        astar.ts:11            redundant work
```

## not yet exercised — honestly, not ranked

These are real database risks that simply don't apply to flattr's current shape.
Listing them so the audit is complete, not to inflate it:

- **Transaction anomalies** (dirty/non-repeatable/phantom/write-skew) — no
  multi-writer shared durable state. Trigger: multi-device sync. `→ 05`
- **Lock contention / deadlock** — one app-level lock, no cycle possible. Trigger:
  a real lock manager over shared rows. `→ 06`
- **Replication lag / stale reads / failover** — single device, single artifact
  (the static bundle-staleness analog is in `08`, not a runtime risk). Trigger:
  live backend with replicas. `→ 08`
- **Query-planner regressions** — no planner; the plan is hand-written A*. `→ 04`
- **N+1** — the routing N+1 is designed out by the adjacency index; only the mild
  per-search rebuild (#5) remains. `→ 04`

## Interview defense

**Q: "What are the top two storage risks in flattr?"**

> One: `nearestNode` is an O(N) scan with no spatial index (`nearest.ts:8`) —
> fine at 1621 nodes, a per-tap latency cliff at metro scale; fix is a k-d tree or
> PostGIS GiST. Two: `graph.json` has no schema version and the app casts it blind
> (`loadGraph.ts:10`), so a pipeline shape change shipped out of lockstep crashes
> silently or — worse for a grade router — flips a sign convention and routes
> wrong with no error. The elevCache already versions its key (`.v1`); the graph
> should too.

```
  #1 unindexed nearest → latency cliff at scale
  #2 unversioned artifact → silent wrong routing on drift
```

Anchor: *both top risks are seam problems invisible until the project succeeds —
a read-path cliff and a contract-less build→read boundary.*

**Q: "Why isn't the missing transaction support on your risk list?"**

> Because there's nothing to make atomic — the graph is read-only and the only
> writer does single-op whole-blob writes. Putting "no transactions" on the risk
> list would be padding. It becomes a real risk the day flattr adds multi-device
> sync to a shared store, and I'd flag it *then*. An audit that can't name the
> trigger for a finding shouldn't list the finding.

Anchor: *a risk without a trigger is opinion; flattr's absent DB mechanisms are
correct simplifications until a named feature flips them on.*

## See also

- `00-overview.md` — the same ranking with the storage map
- `03-btree-hash-and-secondary-indexes.md` — #1 the spatial-index gap in depth
- `01-database-systems-map.md` — #2 the build→read seam contract gap
- `07-wal-durability-and-recovery.md` — #3 the durability window
- `04-query-planning-and-execution.md` — #4/#5 the index and merge costs
- `../study-performance-engineering/` — measuring #1 and #5
- `../study-system-design/` — the migration that activates the deferred risks
