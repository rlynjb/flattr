# Vector Databases
*Vector store / ANN index — Industry standard*

## Zoom out

A vector database stores embeddings and answers "nearest k to this query vector" fast, via an approximate-nearest-neighbor index (HNSW, IVF). You've run the spectrum — pgvector in AdvntrCue, and the lighter end is sqlite-vec or a hosted Pinecone. flattr stores a static graph read-only on device; there is no vector DB, and the one thing *named* "vector" here is a cartography format, not this.

```
LAYERS — the vector store's job
┌──────────────────────────────────────────────┐
│ query vector ─► [ANN index] ─► top-k ids      │
│   ┌────────────────────────────────────────┐ │
│   │ HNSW / IVF over millions of vectors     │ │ ◄── sublinear
│   │   trades exactness for speed            │ │     kNN
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Brute-force kNN is O(n) per query — fine for 10k vectors, fatal at 10M. A vector DB builds a graph/cluster index so search is roughly O(log n), accepting small recall loss for big speed wins.

```
PATTERN — exact vs approximate
  brute force │ scan all N, exact, slow
  ANN (HNSW)  │ hop through a navigable graph, ~exact, fast
```

**Move 2 — the mechanism.** Insert: embed → add vector to index (+ metadata for filtering). Query: embed query → traverse index → return top-k ids + scores → hydrate the chunk text. Most stores also do metadata pre/post-filtering ("only docs from user X").

```
MECHANISM — insert + query
  insert: vec + meta ─► [HNSW graph] grows
  query:  qvec ─► greedy graph walk ─► top-k ─► join metadata
```

**Move 3 — principle.** A vector DB is just an index over embeddings — it's only worth its operational weight once brute-force kNN over your corpus stops being instant.

## In this codebase

**Not yet exercised in flattr.** No vector DB, no ANN index, no embeddings to store.

**Kill the false positive:** flattr's `mobile/` uses MapLibre **vector tiles**. That is a *name collision* — vector tiles are compact vector-geometry map graphics (roads, polygons as drawing instructions), nothing to do with embedding vectors or kNN search. flattr's actual data store is `data/graph.json`: a static, read-only, bundled artifact the device loads whole. No queries against an index, no nearest-neighbor over meaning — just a JSON graph in memory. No attach point.

## See also
- [01 — Embeddings](01-embeddings.md)
- [09 — Stale embeddings](09-stale-embeddings.md)
- [10 — Incremental indexing](10-incremental-indexing.md)
