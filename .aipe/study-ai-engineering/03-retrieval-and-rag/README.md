# 03 — Retrieval & RAG

**flattr has a graph, not a corpus — RAG has no natural home here.**

That sentence is the spine of this whole section. RAG and retrieval exist to fetch *text* from a *document corpus* and ground a model on it. flattr's data is `data/graph.json` — nodes and edges (street segments with grades) — and its core feature, A* routing, is fully solved without any retrieval. There is no LLM, no embeddings, no vector store, no corpus. So these files are **study material**, not codebase walkthroughs: you (Rein) shipped textbook RAG in AdvntrCue (pgvector + GPT-4 + chunking + hybrid + MemoRAG), and the goal here is to name precisely *why each concept has nowhere to attach in flattr* — and to catch the two honest analogs that genuinely do transfer.

Two name collisions to kill up front:
- **MapLibre vector tiles** (`mobile/`) are cartographic geometry, not embedding vectors — file 04.
- **flattr's graph** (`features/routing/graph.ts`) is a spatial routing graph, not a knowledge graph — file 12.

Two real analogs (different domain, same shape):
- **Staleness** — `data/graph.json` is a prebuilt snapshot that rots if OSM/elevation changes and you don't rebuild — file 09.
- **Full vs incremental** — `pipeline/run-build.ts` does a full graph rebuild, the same tradeoff as full-vs-delta reindexing — file 10.

## Files

| # | Concept | flattr verdict |
|---|---------|----------------|
| [01](01-embeddings.md) | Embeddings | N/A — coordinates/tile vectors are geographic, not semantic |
| [02](02-embedding-model-choice.md) | Embedding model choice | N/A — no corpus to embed |
| [03](03-chunking-strategies.md) | Chunking strategies | N/A — flattr's unit is a graph edge, not a text chunk |
| [04](04-vector-databases.md) | Vector databases | N/A — static `graph.json`; vector tiles are a name collision |
| [05](05-dense-vs-sparse.md) | Dense vs sparse | N/A — no text search of any kind |
| [06](06-hybrid-retrieval-rrf.md) | Hybrid retrieval (RRF) | N/A — A* ranks routes by cost, not by merging retrieval signals |
| [07](07-reranking.md) | Reranking | N/A — no candidate set to rerank |
| [08](08-query-rewriting-hyde.md) | Query rewriting & HyDE | Not exercised — `geocode.ts:9` is place-resolution, not doc retrieval |
| [09](09-stale-embeddings.md) | Stale embeddings | Analog: `graph.json` snapshot staleness (real, different domain) |
| [10](10-incremental-indexing.md) | Incremental indexing | Analog: `run-build.ts` full rebuild (real, different domain) |
| [11](11-rag.md) | RAG | No attach point — graph, not documents; routing needs no retrieval |
| [12](12-graphrag.md) | GraphRAG | Not exercised — flattr's graph is spatial, not a knowledge graph |

## Real seams (verified)
- output→prompt: `features/routing/summary.ts:11`
- input→prompt: `pipeline/geocode.ts:9`
- injection vector: `pipeline/geocode.ts:27,52,69` (OSM `display_name` is untrusted)
