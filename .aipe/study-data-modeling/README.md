# Study — Data Modeling · flattr

The through-line: **does the data's shape match how it's actually read and
written — and can it stay correct?**

flattr has exactly one persistent data structure: a grade-annotated street
graph, shipped as a static `graph.json` artifact and read whole into memory.
There's no database, no live writes, no migration framework. That makes this
an unusually *clean* data-modeling study — the model is small, the canonical
schema is one TypeScript file (`features/routing/types.ts`), and every access
pattern is visible in the code. The interesting findings aren't "this table is
shaped wrong"; they're about **a denormalized in-memory index (`adjacency`)
that's load-bearing for A*, a derived field stored on disk (`absGradePct`),
a missing spatial index (`nearestNode` is an O(N) scan), an N+1-shaped
`edgeById` linear find in the read path, and zero referential-integrity or
schema-version guards** on an artifact that's cast blind at load.

```
  The whole data model — one entity graph, three relations

  ┌─ Graph (the artifact: graph.json) ─────────────────────────────┐
  │  city: string                                                  │
  │  bbox: [minLng, minLat, maxLng, maxLat]                        │
  │                                                                │
  │   nodes: Record<id, Node>        edges: Edge[]                 │
  │   ┌──────────────┐               ┌──────────────────────────┐ │
  │   │ Node         │   fromNode    │ Edge                     │ │
  │   │  id   (PK)   │◄──────────────│  id        (PK)          │ │
  │   │  lat         │   toNode      │  fromNode  (FK→Node.id)  │ │
  │   │  lng         │◄──────────────│  toNode    (FK→Node.id)  │ │
  │   │  elevationM  │               │  geometry  [[lat,lng]]   │ │
  │   └──────────────┘               │  lengthM                 │ │
  │                                  │  riseM   (signed)        │ │
  │   adjacency: Record<            │  gradePct (signed)       │ │
  │     nodeId, edgeId[]  ──────────►│  absGradePct ( =|grade| )│ │← derived,
  │   >   (denormalized index)       │  kind?                   │ │  stored
  │                                  └──────────────────────────┘ │
  └────────────────────────────────────────────────────────────────┘
       1621 nodes · 1879 edges · adjacency over all 1621 nodes
       (mobile/assets/graph.json, city "seattle-mvp")
```

## The two partition seams (what's here vs next door)

- **vs system-design:** "graph is a static file, not a DB; rebuild-and-reship
  to evolve it" is the *storage-choice* call — that seam is walked here in
  `06`. "Pan-to-load tiling, rate-limit budgeting, the corridor/viewport
  fetch pump" is architecture → `study-system-design`. The schema *shape* and
  whether it matches access is here; how the runtime *fetches and merges*
  regions is there.
- **vs DSA-foundations:** the binary heap in `pqueue.ts`, A* itself, the
  adjacency-list *data structure* as an algorithms primitive → `study-dsa-
  foundations`. Here we care only about adjacency as a *persisted /
  materialized index* and whether it matches the query (`O(1)` neighbor
  expansion in A*).
- **vs software-design:** `absGradePct` stored alongside `gradePct` is the DB
  analog of duplicated state — single-source-of-truth. The information-hiding
  principle behind it lives in `study-software-design`; here we judge the
  *denormalization call* on its read-optimization merits.

## Reading order

```
  00-overview.md                          ← orient: the model in one page
  audit.md                                ← Pass 1: all 7 lenses, file:line
  01-graph-as-entity-model.md             ← the schema as-built (the zoom-out)
  02-derived-and-denormalized-fields.md   ← absGradePct + adjacency
  03-indexes-vs-query-patterns.md         ← adjacency hit, nearestNode/edgeById miss
  04-integrity-without-a-database.md       ← no FK/version guards; blind cast
  05-tile-prefixing-and-id-namespacing.md  ← re-keying ids on merge
```

## Cross-links to sibling guides

- `study-system-design` — tiling, fetch pump, rate-limit budget, storage architecture
- `study-dsa-foundations` — binary heap, A*, adjacency list as an algorithms primitive
- `study-software-design` — information hiding / single source of truth (the normalization analog)
- `study-performance-engineering` — the O(N) `nearestNode` scan and O(E) `edgeById` find as latency
- `study-runtime-systems` — whole-graph-in-memory, no streaming/paging of the artifact
- `study-debugging-observability` — how a dangling `fromNode` surfaces (it crashes deep in A*, not at load)
