# 03 — Retrieval and RAG

flattr has no embeddings, no vector store, and no RAG. Its route facts are
already a typed struct (`RouteSummary`), so there's no corpus to retrieve
over — adding vector search would be the spec's "above-threshold"
anti-pattern. These files teach retrieval as study material and stay
honest about the absence, while anchoring to flattr's two real, non-AI
analogs:

- **Spatial retrieval** — `nearestNode` (`nearest.ts:5`) finds the closest
  node by `haversine` distance. It's a third retrieval family (geometric),
  not dense and not sparse.
- **Build-artifact staleness + rebuild** — `graph.json` is a frozen
  snapshot of OSM/elevation that can go stale, refreshed by a full
  rebuild. Same freshness/indexing shape as embeddings, no vectors.

## Files

- [01-embeddings.md](01-embeddings.md) — text→vector. flattr's only
  vectors are 2D `(lat, lng)` coordinates: geometric, not semantic.
- [02-embedding-model-choice.md](02-embedding-model-choice.md) — N/A, a
  one-way decision; flattr embeds nothing, so there's no choice.
- [03-chunking-strategies.md](03-chunking-strategies.md) — N/A, no corpus;
  the look-alike is edge-splitting for grade physics, not retrieval.
- [04-vector-databases.md](04-vector-databases.md) — N/A; flattr's store is
  a static read-only `graph.json` queried geographically.
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — N/A; flattr's retrieval
  is spatial (nearest-node), a third family the dense/sparse axis misses.
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — N/A; flattr
  returns a single argmin node, so there are no rankings to fuse.
- [07-reranking.md](07-reranking.md) — N/A; flattr's retrieval is an exact
  top-1, so there's no candidate list to rerank.
- [08-query-rewriting-hyde.md](08-query-rewriting-hyde.md) — N/A; the
  closest seam is the NL-parse/rewrite step in front of `geocode`. HyDE is
  structurally inapplicable (nothing to embed).
- [09-stale-embeddings.md](09-stale-embeddings.md) — N/A as embeddings, but
  flattr has the same freshness failure shape: `graph.json` drifts from
  live OSM/elevation.
- [10-incremental-indexing.md](10-incremental-indexing.md) — flattr
  full-rebuilds `graph.json` via `run-build.ts`; the rebuild-vs-incremental
  tradeoff is real and decided.
- [11-rag.md](11-rag.md) — the route-describe (output→prompt) seam. flattr
  doesn't need RAG: its context is a typed struct, not a corpus.
- [12-graphrag.md](12-graphrag.md) — flattr's graph is *geographic*
  (coordinates + roads), not a *knowledge* graph; A* over it is routing,
  not retrieval.

## Reading order

Self-contained per concept. If reading straight through, the honest
through-line is: embeddings (geographic vs semantic) → why each text-RAG
stage is N/A → the two real analogs (staleness, rebuild) → RAG itself (the
output seam) → GraphRAG (geographic vs knowledge graph). The single most
important file is [11-rag.md](11-rag.md) — it names the one place an LLM
actually attaches to flattr.
