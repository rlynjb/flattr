# Study — Data Modeling (flattr)

The shape of flattr's persistent data: one canonical artifact, `graph.json`,
a grade-annotated street graph. There is no database, no ORM, no migration
runner. The "schema" is a TypeScript type (`features/routing/types.ts`) and the
"rows" are a JSON file the app reads once at startup. That doesn't make data
modeling irrelevant — it makes it *sharper*, because every normalization call,
every index, and every integrity guard is hand-built and visible in one place.

## The through-line

```
  Does the data's SHAPE match how it's actually read and written —
  and can it stay correct over time?

  flattr's answer, in one breath:
    - shape:   one undirected grade-annotated graph (Node / Edge / adjacency)
    - reads:   A* asks "neighbors of node X" (adjacency index) +
               nearest.ts asks "closest node to a tap" (NO index — O(N) scan)
    - writes:  build-time only — the pipeline writes the whole artifact once
    - correct: NO schema version, NO load-time referential-integrity check
```

## The two partition seams (what lives here vs next door)

```
  study-data-modeling   the SHAPE of the graph artifact: Node/Edge/Graph,    ← here
                        adjacency, absGradePct denormalization, the O(N)
                        nearest-node scan, no schema version.
  study-database-systems  adjacency-AS-INDEX storage layout, the JSON-as-
                        storage-engine call, load-once-read-many durability.
                        → .aipe/study-database-systems/
  study-dsa-foundations adjacency-list as an in-memory GRAPH REPRESENTATION,
                        A*/Dijkstra over it. → .aipe/study-dsa-foundations/
  study-system-design   graph.json as a BUILD-TIME ARTIFACT, pipeline vs
                        runtime split, on-device tile builds.
                        → .aipe/study-system-design/
```

Two seams to hold straight. Against **database-systems**: "adjacency is a
hash index keyed by nodeId" is a storage-engine fact → there; "adjacency
duplicates the from/to facts already in `edges`, traded for O(1) neighbor
lookup" is a normalization call → here. Against **DSA**: "adjacency list is how
you represent a sparse graph in memory" is a data-structure fact → there; "is
that the right shape for the query A* actually runs" is data modeling → here.

## The schema, in one diagram

The whole persistent model. Read it before opening any concept file.

```
  flattr's data model — one Graph artifact (features/routing/types.ts)

  ┌─ Graph ─────────────────────────────────────────────────────────┐
  │  city: string                                                    │
  │  bbox: [minLng, minLat, maxLng, maxLat]                          │
  │                                                                  │
  │  nodes: Record<nodeId, Node>  ◄── keyed map (PK = id)            │
  │  edges: Edge[]                ◄── flat array (no PK index)        │
  │  adjacency: Record<nodeId, edgeId[]>  ◄── derived INDEX          │
  └──────────────────────────────────────────────────────────────────┘
        │                    │                       │
        ▼                    ▼                       ▼
  ┌─ Node ──────┐    ┌─ Edge ────────────────┐   adjacency[nodeId]
  │ id (PK)     │    │ id (PK)               │   = [edgeId, edgeId, …]
  │ lat, lng    │    │ fromNode  ──FK──► Node │      │
  │ elevationM  │◄───│ toNode    ──FK──► Node │      └─ redundant with
  └─────────────┘    │ geometry: [lat,lng][] │         edge.fromNode/toNode,
                     │ lengthM   (derived)   │         kept for O(1) lookup
                     │ riseM     (derived)   │
                     │ gradePct  (derived,   │   ◄── all four DERIVED from
                     │           signed)     │       elevation + geometry at
                     │ absGradePct (derived) │       build time (grade.ts)
                     │ kind?                 │
                     └───────────────────────┘
```

## Reading order

```
  01-the-data-model-and-its-shape.md     the entities + the schema diagram
  02-normalization-and-duplication.md    absGradePct, adjacency — derived/dup
  03-indexing-vs-query-patterns.md       adjacency index vs nearest.ts O(N) scan
  04-transactions-and-integrity.md       FK-like refs, node-snapping, no validation
  05-migrations-and-evolution.md         no schema version — what breaks
  06-access-patterns-and-storage-choice.md  JSON-document fit for graph access
  07-data-modeling-red-flags-audit.md    consolidated checklist, ranked
```

Ranked top findings (the worst-first capstone is `07`):

1. **No schema version on the artifact** — `graph.json` is `JSON.stringify(graph)`
   with no `schemaVersion` field; `loadGraph` is a bare `as unknown as Graph`
   cast. A field rename silently mis-reads old artifacts. (`05`, `04`)
2. **`nearest.ts` is an un-indexed O(N) scan** — every tap-to-route does a full
   linear pass over `graph.nodes` with a haversine per node; the one spatial
   query the app runs has no spatial index. (`03`)
3. **No referential-integrity check at load** — nothing validates that every
   `edge.fromNode` / `edge.toNode` resolves to a real node; a corrupt artifact
   fails later, deep in A*, with a confusing `undefined` deref. (`04`)
4. **`absGradePct` + `adjacency` are deliberate denormalization** — both
   recomputable, both stored. Correct calls, but they make the artifact a
   read-only build output, not an editable store. (`02`)
```
