# Build and evolve the artifact

**Industry name:** offline build pipeline / ETL into a materialized artifact;
rebuild-and-reship as the migration strategy; runtime key-rewriting on merge.
**Type label:** Industry standard (ETL, materialized view), Project-specific (the
rebuild-and-reship evolution model).

---

## Zoom out, then zoom in

Most apps evolve their schema with migrations — `ALTER TABLE`, run against live data,
reversible, careful. flattr has no live data and no migration framework. Its schema
evolution is: change the code, re-run the build, re-ship the file. The data model is
*regenerated from source*, not *migrated in place*. Here's the lifecycle:

```
  Zoom out — how the artifact is born and how it changes

  ┌─ Sources (external) ────────────────────────────────────────┐
  │  OSM (Overpass)        +        elevation (Open-Meteo DEM)   │
  └───────────────────────────┬──────────────────────────────────┘
                              │  npm run build:graph (offline, build-time)
  ┌─ Pipeline (ETL) ──────────▼──────────────────────────────────┐
  │  parse → split → sampleElevation → grade → buildAdjacency    │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  data/graph.json → copy → bundle
  ┌─ Artifact (shipped) ──────▼──────────────────────────────────┐
  │  mobile/assets/graph.json (read-only, loaded once)           │
  └───────────────────────────┬──────────────────────────────────┘
                              │  runtime, when coverage runs out
  ┌─ Runtime merge ───────────▼──────────────────────────────────┐
  │  prefixGraph (re-key ids) + stitchGraph (connect seams)      │
  └────────────────────────────────────────────────────────────── ┘
```

Zoom in: there are two evolution stories. The *build-time* one (regenerate the whole
file) and the *runtime* one (tile-prefix and merge new regions into the loaded
graph). The first replaces the schema's data; the second rewrites the schema's keys
live. The question: **how does a model with no migrations change safely, and what
does the runtime merge do to keep ids from colliding?**

## Structure pass

**Layers — the build pipeline as a stage chain, each owning part of the schema:**

```
  The ETL stages, what each writes into the model

  parseOsm        → raw ways (geometry only)
  splitWays       → nodes{elevationM:0} + edges{grade:0}   (snapping, densify)
  sampleElevation → fills node.elevationM                  (the external join)
  computeGrades   → fills lengthM/riseM/gradePct/absGradePct
  buildAdjacency  → the derived index (LAST — needs final edges)
```

**Axis traced — "when does this part of the model get its final value?"** Hold it
down the chain. Every field is assigned in exactly one stage, in dependency order:
geometry first (split), then elevation (the external lookup), then grade (needs
elevation), then adjacency (needs final edges). The answer moves strictly forward —
no stage rewrites an earlier stage's output. That's the pipeline discipline:
*single-assignment, left to right.*

**Seam:** the boundary between *build-time* and *runtime*. At build time the whole
artifact is regenerated (no migration, no live data). At runtime, `useTileGraph`
*adds* regions by re-keying and merging — a different operation entirely (it mutates
the in-memory model's namespace, never the disk file). The axis-answer for "can this
change the schema?" flips across that seam: build-time replaces everything, runtime
only extends-and-rekeys. Those are the two evolution mechanisms, and they don't share
code.

## How it works

### Move 1 — the mental model

Think of `graph.json` as a *materialized view*. In SQL, a materialized view is a
query's result frozen to a table — fast to read, stale until you `REFRESH` it. flattr's
graph is exactly that: the "query" is the whole build pipeline (OSM + elevation →
graph), the "table" is `graph.json`, and `REFRESH` is `npm run build:graph`. You never
`UPDATE` a materialized view row-by-row; you recompute it. That's why there are no
migrations — you don't migrate a view, you rebuild it.

```
  the materialized-view evolution model

   sources ──build pipeline──► graph.json ──ship──► app
   (OSM,        (the "query")    (the "view")
   elevation)
       │                            ▲
       └──── change code, ──────────┘
             re-run build = REFRESH (not migrate)
```

The strategy: **when the data is fully derivable from source, evolve it by
re-deriving, not by migrating — there's no live state to preserve.**

### Move 2 — the walkthrough

#### The build pipeline — single-assignment stage chain

`buildGraph` is the whole ETL, and its structure is the lesson: each stage fills one
slice of the schema and hands off:

```ts
// pipeline/build-graph.ts:24-29
const ways = parseOsm(osm);                              // E: extract geometry
const { nodes, edges } = splitWays(ways, maxSegM);       // T: shells, grade=0
const nodesWithElev = await sampleElevations(nodes, elevation); // T: + elevation
const edges2 = computeGrades(nodesWithElev, edges);      // T: + grade fields
return { city, bbox, nodes: nodesWithElev, edges: edges2,
         adjacency: buildAdjacency(edges2) };            // L: derive index, ship
```

Notice the dependency order is forced by the data: `computeGrades` *can't* run before
`sampleElevations` (grade needs elevation, `grade.ts:27`), and `buildAdjacency` *must*
run last (the index is derived from final edges). The schema isn't designed and then
filled — it's assembled in the only order the derivations allow. `splitWays` even
leaves grade fields at literal `0` (`split.ts:77`) as placeholders, a contract that
says "a later stage owns this."

```
  why the order is forced, not chosen

  split ──► sampleElevation ──► computeGrades ──► buildAdjacency
   geom        elevation          grade (needs       index (needs
   only        (external join)    elevation)         final edges)
            └─ each stage's output is the next's input; no rewrites ─┘
```

#### Evolution = rebuild and reship (no migration)

To change the schema — add a field, change how grade is computed, recover a new city —
the move is not a migration. It's:

1. Edit `features/routing/types.ts` (the schema).
2. Edit the pipeline stage that fills the new/changed field.
3. `npm run build:graph` (`pipeline/run-build.ts`) → writes `data/graph.json`.
4. Copy to `mobile/assets/graph.json`, re-bundle the app (`loadGraph.ts` header
   documents this exact step).

There's no reversible migration, no backfill, no zero-downtime concern — because
there's no live data and no users mid-write. The whole artifact is replaced. This is
genuinely the right model *for derivable data*: a migration exists to preserve state
you can't recompute; when you can recompute everything from OSM + elevation, a
migration is strictly more complex than a rebuild.

```
  migration vs rebuild — when each is right

  live, non-derivable data  ──► MIGRATE  (preserve state, reversible, careful)
  fully derivable artifact  ──► REBUILD  (re-run the pipeline, replace the file)
       (flattr)                          ← simpler, and correct here
```

**The one gap this leaves** (from `04`): because there's no schema *version* stamped
in the artifact, step 4 has no safety net. Forget to re-copy the file and a new app
build runs an old artifact — and nothing detects it. The rebuild-and-reship model is
sound; it's missing the version sentinel that would make a botched reship fail loud.
Stamping `version: N` in the build (`run-build.ts`) and checking it in `loadGraph` is
the one addition that hardens this whole flow.

#### The runtime evolution — tile prefixing as live re-keying

The second evolution mechanism is subtler and lives entirely in memory. When the user
pans beyond the bundled graph, `useTileGraph` fetches and builds new regions and
merges them in. But each region is built *independently* — `splitWays` restarts its
counter at `n0`/`e0` every time (`split.ts:44-45`). So two independently-built tiles
both have a node `n0` for *different* places. Merge them naively and the ids collide.
`prefixGraph` solves it by re-keying the entire schema:

```ts
// features/map/tiles.ts:21-38
export function prefixGraph(graph: Graph, prefix: string): Graph {
  const p = (id: string) => `${prefix}:${id}`;
  const nodes: Record<string, Node> = {};
  for (const id of Object.keys(graph.nodes)) {
    nodes[p(id)] = { ...graph.nodes[id], id: p(id) };   // re-key node + its id field
  }
  const edges = graph.edges.map((e) => ({
    ...e, id: p(e.id),
    fromNode: p(e.fromNode), toNode: p(e.toNode),       // re-key the FKs too
  }));
  const adjacency: Record<string, string[]> = {};
  for (const id of Object.keys(graph.adjacency)) {
    adjacency[p(id)] = graph.adjacency[id].map(p);      // re-key the index keys AND values
  }
  return { ...graph, nodes, edges, adjacency };
}
```

This is a *live schema operation* — it rewrites every id in every part of the model
(node keys, node.id, edge.id, edge FKs, adjacency keys, adjacency values) so a tile's
namespace becomes `corridor:n0`, `view:n0`, etc. The thing to appreciate: it has to
touch *all* the places an id appears — and because the model denormalizes ids into
adjacency (02) and stores `node.id` redundantly (02), there are more places than you'd
think. Miss one (say, re-key edge.id but forget edge.fromNode) and routing breaks at
the seam. The function re-keys all six id locations; that completeness is what makes
the merge safe.

```
  prefixGraph rewrites every id location — six of them

  before (tile)         after (prefix="corridor")
  ─────────────         ─────────────────────────
  nodes["n0"]           nodes["corridor:n0"]
  node.id "n0"          node.id "corridor:n0"
  edge.id "e0"          edge.id "corridor:e0"
  edge.fromNode "n0"    edge.fromNode "corridor:n0"
  edge.toNode "n1"      edge.toNode "corridor:n1"
  adjacency["n0"]:[e0]  adjacency["corridor:n0"]:["corridor:e0"]

  all six, or the merged graph has dangling refs (→ 04's crash)
```

Then `stitchGraph` (`tiles.ts:45-86`) adds zero-length connector edges between nodes
that sit at the same coordinate but came from different (prefixed) tiles, so routing
crosses the seam — a schema-level patch that re-establishes the connectivity prefixing
deliberately broke.

### Move 2 variant — the load-bearing skeleton

The kernel of "evolve a materialized artifact" has three parts. What breaks without
each:

1. **A pure rebuild from source.** `buildGraph(OSM, elevation) → Graph`. Drop this
   (hand-edit the JSON) and you've created un-reproducible state — the next rebuild
   silently overwrites your edit, the migration nightmare a materialized view exists
   to avoid.
2. **Dependency-ordered stages.** Each field filled after its inputs. Drop the order
   (compute grade before elevation) and you ship a model with derived fields computed
   from placeholder zeros — `grade.ts` would read `elevationM: 0` and emit flat grades
   for the whole city.
3. **A namespace operation for merges.** `prefixGraph` re-keying all id locations.
   Drop it (merge raw tiles) and independently-built ids collide — `corridor:n0` and
   `view:n0` become one node, fusing unrelated streets.

Optional hardening (the gap): a **version sentinel** stamped at build and checked at
load, so a stale reship fails loud (04). And a **validator** on the rebuilt artifact
in CI, so a bad build never reaches the bundle. Neither exists; both are the natural
next step for this evolution model.

### Move 3 — the principle

How a schema evolves is decided by one question: is the data derivable from source, or
is it irreplaceable live state? Irreplaceable state demands migrations — careful,
reversible, state-preserving. Fully derivable data demands the opposite — rebuild from
source and replace, because a migration there is just a more fragile way to reach a
result you can recompute. flattr's graph is derivable (OSM + elevation in, graph out),
so rebuild-and-reship is correct, not lazy. The runtime merge is the same principle at
a smaller grain: rather than reconcile colliding namespaces, it re-keys deterministically
so collisions can't happen. The transfer: **match your evolution mechanism to your
data's provenance — migrate what you can't recompute, regenerate what you can — and
stamp a version on anything you ship so a stale copy fails loud.**

## Primary diagram

The two evolution mechanisms — build-time rebuild and runtime re-key — in one frame.

```
  How flattr's data model changes — both mechanisms

  BUILD-TIME (replace the artifact)            RUNTIME (extend in memory)
  ┌──────────────────────────────────┐         ┌──────────────────────────────────┐
  │ change types.ts + pipeline stage │         │ user pans past coverage          │
  │        │                         │         │        │                         │
  │ npm run build:graph              │         │ fetchOverpass + buildGraph(tile) │
  │   parseOsm → splitWays →         │         │        │                         │
  │   sampleElevation → computeGrades│         │ prefixGraph(g, "view")           │
  │   → buildAdjacency               │         │   re-key all 6 id locations      │
  │        │                         │         │        │                         │
  │ data/graph.json → copy → bundle  │         │ mergeGraphs + stitchGraph        │
  │   ✗ NO version stamp (04 gap)    │         │   connect coincident seams       │
  └──────────────┬───────────────────┘         └──────────────┬───────────────────┘
                 │ replaces the file                           │ extends loaded graph
                 ▼                                             ▼
          mobile/assets/graph.json  ──loadGraph──►  in-memory Graph  ──merge──► routed
          (derivable → REBUILD)                     (collision-safe → RE-KEY)
```

## Elaborate

The rebuild-and-reship model is how every static-site generator, every compiled asset,
every protobuf descriptor set evolves — you don't migrate a build output, you rebuild
it. It works precisely because the output is a pure function of inputs under version
control. The moment that stops being true (someone hand-edits `graph.json`, or user
data accretes in the artifact), you've lost reproducibility and inherited the
migration problem you were avoiding — which is why hand-editing the JSON is the one
thing to never do here. The tile-prefix re-keying is the same idea ORMs and module
bundlers use to avoid namespace collisions: deterministic prefixing so independently-
generated id spaces compose without coordination. flattr's twist is that prefixing has
to chase ids through a *denormalized* model (ids live in six places, 02), which is
exactly why `prefixGraph` is longer than you'd expect.

This is the last pattern file. Loop back to `audit.md` for the consolidated red-flag
checklist, or `04` for the version sentinel this evolution model is missing.

## Interview defense

**Q: There are no migrations. How does the schema change without one?**

The data is fully derivable from source (OSM + elevation), so the artifact is a
materialized view, not a database — you evolve it by re-running the build pipeline and
replacing the file, not by migrating in place. Change the type and the pipeline stage,
`npm run build:graph`, re-bundle. A migration exists to preserve state you can't
recompute; when you can recompute everything, rebuild-and-reship is simpler and
correct. The honest gap: there's no version stamped in the artifact, so a botched
reship (stale file, new code) fails silently — stamping a version at build and
checking it at load is the one missing safety net.

```
  derivable? ──yes──► rebuild from source (flattr)
       │ no
       ▼
   migrate in place (preserve live state)
```

Anchor: *"The graph is a materialized view of OSM+elevation, so evolution is
rebuild-and-reship, not migrate — correct for derivable data, but it's missing a
version stamp to catch a stale reship."*

**Q: When the app loads new map tiles at runtime, how do their ids not collide with
the bundled graph?**

Each tile is built independently, so they all restart ids at `n0`/`e0`. Before merging,
`prefixGraph` (`tiles.ts:21`) re-keys every id location with a namespace prefix —
node map keys, the redundant `node.id`, `edge.id`, both edge FKs, and the adjacency
keys *and* values. All six, because the model denormalizes ids into adjacency and
stores `node.id` twice. Miss one and you get dangling refs that crash A\* (04). Then
`stitchGraph` adds zero-length connectors at coincident coordinates so routing crosses
the tile seam.

Anchor: *"prefixGraph re-keys all six id locations with a namespace prefix so
independently-built tiles compose without collision — then stitchGraph reconnects the
seams."*

## See also

- `01-graph-as-the-schema.md` — the stage chain that fills the schema.
- `02-adjacency-as-denormalized-index.md` — why prefixing has six id locations to chase.
- `04-integrity-without-a-database.md` — the version sentinel this flow is missing.
- `study-system-design` — tile-and-merge coverage as architecture; the build pipeline.
- `study-networking` — the Overpass / Open-Meteo fetches the build depends on.
