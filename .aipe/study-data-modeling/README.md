# Study — Data Modeling (flattr)

> The question this guide answers: **does the data's shape match how it's
> actually read and written — and can it stay correct?**

flattr has no database. Its persistent data is one file: `mobile/assets/graph.json`
(544 KB, 1621 nodes / 1879 edges for Capitol Hill). That single artifact *is* the
data model — a grade-annotated street graph, built once by an offline pipeline,
shipped read-only into the app, and traversed by a hand-rolled A\*. So this audit
is unusual: there are no migrations, no FKs, no indexes in the SQL sense. But every
data-modeling decision is still here — it's just made in TypeScript types and a JSON
blob instead of DDL.

The canonical schema lives in `features/routing/types.ts`. Read it first.

```
  The whole data model in one frame

  ┌─ Graph ───────────────────────────────────────────────────────┐
  │  city: string                                                  │
  │  bbox: [minLng, minLat, maxLng, maxLat]                        │
  │                                                                │
  │  nodes: Record<id, Node>     ◄── keyed map (PK = id)           │
  │     Node { id, lat, lng, elevationM }                          │
  │                                                                │
  │  edges: Edge[]               ◄── array (no PK index!)          │
  │     Edge { id, fromNode ─┐                                     │
  │            toNode ───────┼──► point into nodes (FK, unchecked) │
  │            geometry, lengthM, riseM,                           │
  │            gradePct (signed), absGradePct (derived), kind? }   │
  │                                                                │
  │  adjacency: Record<nodeId, edgeId[]>  ◄── the access index     │
  │     denormalized: duplicates edge endpoints for O(1) expansion │
  └────────────────────────────────────────────────────────────────┘
```

## The two partition seams

This guide is **data modeling** — the *shape* of persistent data. Two neighbors:

- **vs. `study-system-design`** — "ship the graph as a static file instead of a
  DB; build it offline; tile-and-merge for coverage" is architecture → lives there.
  "the edges array has no id index; `absGradePct` is stored but derivable" is shape
  → lives here.
- **vs. `study-dsa-foundations`** — the binary heap in `pqueue.ts` and the A\*
  traversal are in-memory data structures → there. The on-disk graph schema and its
  adjacency index → here.

Normalization is information-hiding for data — a fact stored once, editable in one
place. The CODE analog (duplication, single source of truth) lives in
`study-software-design`; this guide applies the same lens to the *data*.

## Reading order

1. `00-overview.md` — one-page orientation: the model, the verdict, worst-first.
2. `audit.md` — the seven-lens audit. Every lens walked, `not yet exercised`
   named honestly. Start here for the full picture.
3. Pattern files (Pass 2 — what's actually interesting in this repo):
   - `01-graph-as-the-schema.md` — nodes + edges + adjacency as a shipped artifact.
   - `02-adjacency-as-denormalized-index.md` — the deliberate duplication that
     buys O(1) A\* expansion, and `absGradePct` as a stored-derived field.
   - `03-missing-indexes-and-scans.md` — `nearestNode` O(N), `edgeById` O(E)
     per-edge, no spatial index, no id→edge map on the shipped graph.
   - `04-integrity-without-a-database.md` — no referential check on
     `fromNode`/`toNode`; no schema version; where a dangling edge crashes.
   - `05-build-and-evolve-the-artifact.md` — the build pipeline as the migration
     story; rebuild-and-reship; tile prefixing as runtime re-keying.

## Cross-links to sibling guides

- `study-system-design` — static-artifact-vs-DB, tile-and-merge coverage, the
  offline build pipeline as architecture.
- `study-dsa-foundations` — the binary heap (`pqueue.ts`), A\* traversal, BFS/graph
  vocabulary you already own from reincodes (`Graph2.ts`, `PriorityQueue.ts`).
- `study-software-design` — information hiding / single-source-of-truth, the CODE
  analog of normalization.
- `study-performance-engineering` — the O(N) `nearestNode` scan and O(E) `edgeById`
  as latency findings; the elevation dedup cache.
- `study-networking` — the Overpass / Open-Meteo build-time fetches and throttling.
