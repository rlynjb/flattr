# Data-modeling audit — flattr

Pass 1 of the two-pass shape: every lens walked against the real schema, with
`file:line` grounding or an honest `not exercised`. Significant findings cross-link
to a pattern file (Pass 2) rather than restating the deep walk here.

The schema under audit: `features/routing/types.ts:1-28`, serialized to
`mobile/assets/graph.json` (544 KB, 1621 nodes, 1879 edges). No DB. The TypeScript
type *is* the DDL; the JSON file *is* the table.

---

## 1. The data model and its shape

**What's there.** One entity graph, three parts (`features/routing/types.ts:22-28`):

- `nodes: Record<string, Node>` — a keyed map, id → `{id, lat, lng, elevationM}`.
  This is the closest thing to a primary-key index in the model: O(1) node lookup
  by id, and the JSON object key *is* the id (also stored redundantly inside the
  node, see lens 2).
- `edges: Edge[]` — a flat array of `{id, fromNode, toNode, geometry, lengthM,
  riseM, gradePct, absGradePct, kind?}` (`types.ts:10-20`). The relationship table:
  each edge points at two nodes by id. No index on the array — lookup by edge id is
  a linear `find` (lens 3).
- `adjacency: Record<string, string[]>` — nodeId → incident edgeIds. The
  access-pattern index, built by `buildAdjacency` (`features/routing/graph.ts:22-29`).

The model is well-shaped: it is *not* one undifferentiated JSON blob. Nodes,
edges, and the adjacency index are distinct, each with a clear role. No red flag
here — the structure matches the domain (a street network is a graph).

→ Deep walk: **`01-graph-as-the-schema.md`**.

## 2. Normalization and duplication

Three duplications, two deliberate, one cosmetic:

- **`adjacency` duplicates edge endpoints** — every edge's `fromNode`/`toNode`
  relationship is restated in the adjacency lists. This is the *good* kind: a
  denormalized index, justified by O(1) A\* expansion (`astar.ts:64`). The cost is
  that adjacency must be rebuilt whenever edges change — and it is, by
  `buildAdjacency`, never hand-edited. Single source of truth (`edges`) preserved.
- **`absGradePct` is `Math.abs(gradePct)`** — a stored derived field
  (`pipeline/grade.ts:31`). `gradePct` is canonical (signed); `absGradePct` is its
  derivation, copied onto every edge so the heatmap doesn't recompute `abs` per
  render. Deliberate read optimization. The risk: if anything ever wrote `gradePct`
  without recomputing `absGradePct`, the two would disagree — the classic
  denormalization hazard. Nothing writes at runtime, so the risk is latent.
- **`node.id` is stored inside the node *and* used as the map key** (`types.ts:1-6`,
  graph.json `{"n0":{"id":"n0",...}}`). Pure redundancy — the key already is the id.
  Harmless, costs a few KB, but it's a fact stored twice that *could* drift (key
  `n0` holding a node whose `id` says `n5`). Cosmetic.

→ Deep walk: **`02-adjacency-as-denormalized-index.md`**.

## 3. Indexing vs query patterns

This is where the missing-database bites. The shipped graph has exactly one real
index (the `nodes` map's keys = node PK). Everything else is a scan:

- **`nearestNode` is O(N)** (`features/routing/nearest.ts:5-18`) — every coordinate
  tap (snapping start/goal to a graph node) walks all `Object.keys(graph.nodes)` and
  haversines each. No spatial index (no grid, no k-d tree, no R-tree). At 1621 nodes
  it's microseconds; it's linear in node count and runs on every route request.
- **`edgeById` is O(E) `graph.edges.find`** (`features/routing/graph.ts:3-7`) —
  and it's called *inside a loop per path edge* in `summary.ts:14` and
  `geojson.ts:53`. So building a route summary or its GeoJSON is O(path × E). This
  is the data-modeling equivalent of an N+1: one full-table scan per row of the
  result. Notably, `astar.ts:12-16` *already solved this* — `indexEdges` builds a
  `Map<id, Edge>` once per search. The summary/geojson paths just don't reuse it.
- **No id index on `edges` in the artifact itself** — A\* rebuilds the `Map` on
  every search (`indexEdges` in `astar.ts`). Cheap relative to the search, but it
  means the on-disk model ships without the index its own consumers need.

→ Deep walk: **`03-missing-indexes-and-scans.md`**.

## 4. Transactions and integrity

**Transactions: `not exercised`, correctly.** There are zero runtime writes to the
graph — it's loaded read-only via `loadGraph()` (`mobile/src/loadGraph.ts:9-11`).
Nothing needs to be atomic because nothing mutates. (Tile merging in
`useTileGraph.ts` builds *new* graph objects; it doesn't mutate the base.)

**Integrity: the gap.** With no DB, nothing enforces the relationships the model
assumes:

- **No referential-integrity check** — nothing verifies that every `edge.fromNode`
  / `edge.toNode` exists in `nodes`. `astar.ts:64-72` does `graph.nodes[next]` on a
  node id pulled from an edge; if that id is dangling, `graph.nodes[next]` is
  `undefined` and the search either silently misroutes or crashes later when the
  heuristic dereferences it. The error surfaces deep in traversal, not at load.
- **No schema version on `graph.json`** — the artifact's top-level keys are
  `{city, bbox, nodes, edges, adjacency}` (verified), no `version` / `schemaVersion`.
  If `types.ts` renames a field (say `gradePct` → `grade`) and the bundled
  `graph.json` is stale, the load `as Graph` cast (`loadGraph.ts:10`) succeeds and
  the mismatch surfaces as `undefined` arithmetic downstream. No drift guard.
- **No constraints** — `lengthM > 0`, `gradePct` within `±MAX_GRADE_PCT`, adjacency
  consistent with edges: all *assumed*, none *checked* on the shipped artifact. The
  build pipeline clamps grade (`grade.ts:30`) and skips zero-length edges
  (`split.ts:65`), so the producer is partially trustworthy — but there's no
  validator between "JSON on disk" and "graph in memory."

→ Deep walk: **`04-integrity-without-a-database.md`**.

## 5. Migrations and evolution

**No migration framework — `not exercised`,** and for a static artifact that's
defensible. Schema evolution here is: edit `features/routing/types.ts`, change the
pipeline that fills the new shape, run `npm run build:graph` (`pipeline/run-build.ts`),
copy `data/graph.json` → `mobile/assets/graph.json`, re-bundle the app. There's no
live data to migrate, no backfill, no rollback — you regenerate the whole artifact
from source (OSM + elevation) every time.

The runtime *does* have one schema transform: **tile prefixing**
(`features/map/tiles.ts:21-38`). When the app fetches new regions and merges them
into the base graph, `prefixGraph` re-keys every node/edge id with a `prefix:` so
ids from independently-built tiles don't collide, and `stitchGraph`
(`tiles.ts:45-86`) adds zero-length connector edges at coincident coordinates so
routing crosses tile seams. That's a live, in-memory schema operation — a merge with
key-rewriting — even though there's no on-disk migration.

The honest gap: because there's no schema version (lens 4), there's also no
*migration trigger*. A new app build with a new type but an old bundled `graph.json`
has no mechanism to detect or refuse the mismatch.

→ Deep walk: **`05-build-and-evolve-the-artifact.md`**.

## 6. Access patterns and storage choice

**The storage choice matches the access pattern — this is the strongest part of the
model.** The access shape is: *load the entire graph once, then run whole-graph
in-memory traversals (A\* per route, heatmap zones over all edges), with zero
runtime writes.* For that shape:

- A relational DB would be pure overhead — you'd `SELECT *` the whole graph on
  startup anyway, paying connection + serialization cost for data you always read in
  full.
- A document store buys nothing — there are no partial reads, no per-document access.
- A static bundled file is exactly right: zero latency, zero network, works offline,
  ships with the app. `loadGraph.ts:9-11` is the entire data-access layer.

The one place the access pattern outgrows the storage shape is **coverage**: the
bundled graph is one neighborhood. Beyond it, `useTileGraph.ts` fetches and builds
new regions on the fly (Overpass + Open-Meteo at runtime) and merges them. That's
the access pattern (pan to a new area → need its graph) pushing past the
ship-it-static model into a build-on-demand model. The seam is handled (tile prefix +
stitch), but it's where the static-artifact choice starts to strain — covered as
architecture in `study-system-design`.

→ Deep walk: **`05-build-and-evolve-the-artifact.md`** (the build side) and
`study-system-design` (the tile-coverage architecture side).

## 7. Data-modeling red-flags audit (capstone checklist)

| Red flag | Status | Where |
|---|---|---|
| Everything in one undifferentiated blob | **No** — nodes/edges/adjacency distinct | `types.ts:22-28` |
| Same fact editable in two places | **Latent** — `absGradePct` = `\|gradePct\|`; `node.id` = map key | `grade.ts:31`, `types.ts:1` |
| Frequent query with no supporting index | **Yes** — `nearestNode` O(N) per route | `nearest.ts:5-18` |
| N+1 / scan-per-row pattern | **Yes** — `edgeById` O(E) in a per-edge loop | `summary.ts:14`, `geojson.ts:53` |
| Multi-write op with no transaction | **N/A** — no runtime writes | `loadGraph.ts:9-11` |
| Invariant enforced only in app code | **Yes** — referential integrity, grade clamp | `grade.ts:30`, no validator |
| Destructive migration / no rollback | **N/A** — rebuild-from-source artifact | `run-build.ts` |
| Schema with no version on serialized data | **Yes** — `graph.json` has no version field | verified: keys are `{city,bbox,nodes,edges,adjacency}` |
| Storage shape fights access pattern | **No** — static file fits read-only whole-graph traversal | `loadGraph.ts` |

**The ranked verdict (worst-first):** (1) no referential-integrity check on edge
endpoints — crashes deep, not at load. (2) no schema version on the artifact —
silent mis-read on drift. (3) `nearestNode` O(N) — fine now, quadratic with the
city. (4) `edgeById` O(E) per-edge — an N+1 the codebase already knows how to fix
(`indexEdges` exists in `astar.ts`, just not reused). (5) `absGradePct` stored-derived
— cheap, justified, latent-drift only.

Everything else is either genuinely good (adjacency index, storage choice, signed-vs-
derived grade) or honestly not-exercised (transactions, migrations) for a read-only
shipped artifact.
