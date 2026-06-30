# Data-Modeling Audit — flattr

Pass 1: every lens walked against the repo, `file:line` grounded, `not yet
exercised` named honestly. Significant findings cross-link to their pattern
file rather than restating.

Persistence inventory: one artifact, `mobile/assets/graph.json` (544 KB,
1621 nodes / 1879 edges, `city: "seattle-mvp"`), built by `pipeline/` and read
read-only by `mobile/`. There is no database, no ORM, no migration tool, no
runtime write of persistent data. `useTileGraph` builds *additional* in-memory
graphs at runtime and an elevation cache (`mobile/src/elevCache.ts`) persists
fetched DEM samples — but the canonical model is the static graph.

---

## 1. The data model and its shape

**Found.** A directed-capable street graph, normalized into two entities plus
a materialized adjacency index. Canonical schema is one file:
`features/routing/types.ts:1-28`.

- `Node {id, lat, lng, elevationM}` (`types.ts:1-6`)
- `Edge {id, fromNode, toNode, geometry, lengthM, riseM, gradePct, absGradePct, kind?}` (`types.ts:10-20`)
- `Graph {city, bbox, nodes: Record<id,Node>, edges: Edge[], adjacency: Record<nodeId, edgeId[]>}` (`types.ts:22-28`)

`nodes` is keyed (a hash index on `id`); `edges` is a flat array (no key index).
The relations are `Edge.fromNode`/`toNode` → `Node.id` (foreign-key-shaped) and
`adjacency[nodeId]` → `edgeId[]` (a denormalized inverse of that relation).

No red flag for "everything in one blob" — the structure is real and explicit.
→ Deep walk: `01-graph-as-entity-model.md`.

---

## 2. Normalization and duplication

**Found — two deliberate denormalizations, both defensible.**

- **`absGradePct` is derived-but-stored.** `grade.ts:31` sets
  `absGradePct: Math.abs(gradePct)`. It's a pure function of `gradePct`, stored
  anyway so the heatmap path (`geojson.ts:30`, `zones.ts`) reads steepness
  without recomputing. The cost: one fact in two columns; if a future edit
  changes `gradePct` without re-deriving, they diverge silently. There's no
  write path today, so the risk is latent.
- **`adjacency` duplicates the endpoint relation.** Every entry restates
  `edge.fromNode`/`toNode` (`graph.ts:22-29` `buildAdjacency`). This is the DB
  analog of a materialized inverse index — re-derivable, stored for O(1)
  neighbor expansion in A*.

`riseM` vs `gradePct` is *not* duplication — `riseM` is the raw signed
elevation delta (kept for climb totals), `gradePct` is the clamped ratio
(`grade.ts:27-31`). Two facts, not one fact twice.

Cross-link: this is the data analog of software-design's single-source-of-truth
→ `study-software-design`. Deep walk: `02-derived-and-denormalized-fields.md`.

---

## 3. Indexing vs query patterns

**Found — one index that fits, two queries with no index.**

- **Fits:** `adjacency` is the access-pattern index. A*'s inner loop is
  `for (const edgeId of graph.adjacency[current] ?? [])` (`astar.ts:64`) — O(1)
  to get a node's incident edges. `astar.ts:12` also builds an `indexEdges()`
  `Map<id,Edge>` once per search so each `byId.get(edgeId)` is O(1)
  (`astar.ts:65`).
- **Missing — spatial index:** `nearestNode` scans all nodes
  (`nearest.ts:5-18`) — O(N), N=1621, on every tap-to-route. No grid/k-d tree.
- **Missing — reused id index (N+1 shape):** `edgeById` is
  `graph.edges.find(e => e.id === edgeId)` (`graph.ts:3-7`) — O(E). It's called
  once per route edge inside loops in `summary.ts:14` and `geojson.ts:54`,
  making route summary/coloring O(path · E). A* already has the fix
  (`indexEdges`) but the read path doesn't reuse it.

→ Deep walk: `03-indexes-vs-query-patterns.md`.

---

## 4. Transactions and integrity

**Largely not exercised — and that's the gap.** There's no database, so no
FK/unique/not-null/check constraints and no transactions. The model has FK-
*shaped* relations (`Edge.fromNode/toNode → Node.id`) but **nothing enforces
them**:

- `loadGraph()` is `graph as unknown as Graph` (`mobile/src/loadGraph.ts:10`) —
  a blind cast, zero validation.
- A dangling `edge.fromNode` doesn't fail at load; it surfaces as
  `graph.nodes[goalId]` being `undefined` (`astar.ts:39`) or a deref crash deep
  in expansion — far from the cause.
- **No schema version** on the artifact (confirmed: no `version`/`schemaVersion`
  field in `types.ts` or `graph.json`). A shape change between build and app
  silently mis-reads.

The build pipeline is the *only* integrity guarantee: `computeGrades` derefs
`nodes[e.toNode]`/`nodes[e.fromNode]` (`grade.ts:27`), so a build with a
dangling edge crashes at build time. That protects artifacts *this* pipeline
produces — not hand-edited or version-skewed ones.
→ Deep walk: `04-integrity-without-a-database.md`.

---

## 5. Migrations and evolution

**Not exercised — no framework, by design.** There is no migration tool, no
versioned schema, no backfill. Evolution is **rebuild-and-reship**: change the
`Edge`/`Node` type, run `npm run build:graph` (`pipeline/run-build.ts`), copy
the new `graph.json` into `mobile/assets/`. Because the artifact is static and
read-only with a single consumer, this is the right call — a migration
framework would be machinery with nothing to migrate.

The one latent hazard is the missing schema version (see lens 4): with no
`version` tag, an app binary bundled against an old shape and a newly-rebuilt
`graph.json` (or vice versa) mis-reads silently instead of refusing to load.
That's the one piece of migration discipline worth adding before anything else.
Covered in `04-integrity-without-a-database.md` (Phase A/B).

---

## 6. Access patterns and storage choice

**Found — static file is the correct storage shape.** The access pattern is
read-only whole-graph traversal: load once, run A* and heatmap rendering over
the entire structure, never write back. For that pattern a bundled static JSON
beats a database — zero query latency, zero connection setup, works offline,
no server. A relational DB here would be fighting a graph-shaped, whole-object
access pattern.

The runtime *does* build more graphs on demand (`useTileGraph.ts`) and merges
them (`tiles.ts mergeGraphs`), and persists an elevation cache
(`elevCache.ts`) — but those are *architecture* (how regions are fetched and
budgeted against rate limits) → `study-system-design`. The storage-shape call
— "the model is a graph, persist it as a graph blob" — is here.
→ Deep walk: `01-graph-as-entity-model.md` (storage-choice section).

---

## 7. Data-modeling red-flags audit (capstone)

| Red flag | Status in flattr | Evidence |
|----------|------------------|----------|
| No discernible model (one blob) | **Clear** — two explicit entities + index | `types.ts:1-28` |
| Same fact editable in two places | **Latent** — `absGradePct`=`\|gradePct\|`, no write path yet | `grade.ts:31` |
| Frequent query with no index | **Present** — `nearestNode` O(N) scan, every tap | `nearest.ts:5-18` |
| Loop issuing one lookup per row (N+1) | **Present** — `edgeById` O(E) find per path edge | `summary.ts:14`, `geojson.ts:54`, `graph.ts:3` |
| Multi-write with no transaction | **N/A** — no runtime writes of the model | — |
| Invariant only in app code, DB can't guard | **Present** — FK-shaped relations, nothing enforces them | `loadGraph.ts:10`, `astar.ts:39` |
| Destructive migration, no rollback | **N/A** — rebuild-and-reship, no migrations | `pipeline/run-build.ts` |
| No schema version on a serialized artifact | **Present** — no `version` field anywhere | `types.ts`, `graph.json` |
| Storage shape fights access pattern | **Clear** — graph blob matches whole-graph read | `loadGraph.ts`, `astar.ts` |
| Index re-keying / id-collision on merge | **Handled** — `prefixGraph` namespaces ids per tile | `tiles.ts:21-38` |

**Worst-first:** missing integrity/version guards on a blind-cast artifact
(`04`) → missing spatial index on the hot tap path (`03`) → N+1 `edgeById`
(`03`). Everything else is either a defensible denormalization or correctly
absent.
