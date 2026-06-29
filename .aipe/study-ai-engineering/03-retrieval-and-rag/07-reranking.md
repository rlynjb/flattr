# Reranking
*Cross-encoder reranking — Industry standard*

## Zoom out

Reranking is the second stage of retrieval: cheap retrieval grabs ~100 candidates, then an expensive **cross-encoder** rescores the top of them by reading query+doc *together*. It fixes the precision the first stage couldn't afford. You'd add this in AdvntrCue when top-k quality mattered. flattr has no first-stage retrieval, so there's nothing to rerank.

```
LAYERS — two-stage funnel
┌──────────────────────────────────────────────┐
│ stage 1: fast retrieval   → top 100 (recall)  │
│   ┌────────────────────────────────────────┐ │
│   │ stage 2: cross-encoder → top 5          │ │ ◄── precision
│   │   reads (query, doc) jointly            │ │
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Bi-encoders (embeddings) encode query and doc *separately* — fast, indexable, but they never see them side by side. A cross-encoder feeds the pair through one model together, so it judges true relevance — accurate but too slow to run over the whole corpus. Hence: retrieve wide cheaply, rerank narrow expensively.

```
PATTERN — separate vs joint encoding
  bi-encoder:    [q]→vec   [d]→vec   then cosine   (fast, approx)
  cross-encoder: [q ⊕ d] → one model → score       (slow, sharp)
```

**Move 2 — the mechanism.** Stage 1 returns candidates by vector/BM25. For each candidate, concatenate (query, doc) and run the cross-encoder to get a relevance score. Re-sort, keep top-k for the prompt.

```
MECHANISM — retrieve wide, rerank narrow
  query ─► retrieve top-100 ─► cross-encode each (q,dᵢ) ─► sort ─► top-5
              (recall)              (precision)
```

**Move 3 — principle.** Reranking buys precision at the top with compute you only spend on a shortlist — never rerank the whole corpus, only the candidates.

## In this codebase

**Not yet exercised in flattr.** No candidate set is ever retrieved, so there is nothing to rerank, and no cross-encoder (no models at all).

flattr produces a single best route from A*, not a candidate list awaiting a precision pass. If it ever returned N alternate routes to reorder by some richer criterion, that'd be a *ranking* problem — but still cost-function ranking, not query-document relevance scoring. N/A.

## See also
- [06 — Hybrid retrieval (RRF)](06-hybrid-retrieval-rrf.md)
- [05 — Dense vs sparse](05-dense-vs-sparse.md)
- [11 — RAG](11-rag.md)
