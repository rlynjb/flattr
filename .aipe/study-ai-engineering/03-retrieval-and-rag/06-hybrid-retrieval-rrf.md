# Hybrid Retrieval (RRF)
*Reciprocal Rank Fusion — Industry standard*

## Zoom out

Hybrid retrieval runs dense and sparse in parallel and merges their ranked lists. **Reciprocal Rank Fusion (RRF)** is the cheap, robust merge: it ignores raw scores (which aren't comparable across systems) and combines *ranks* instead. You used this fusion in AdvntrCue. flattr does no retrieval to fuse — but RRF's "merge ranked lists" shape has a faint, instructive echo here.

```
LAYERS — fuse two rankings
┌──────────────────────────────────────────────┐
│ dense list ─┐                                 │
│ sparse list ─┼─► RRF ─► one fused ranking      │
│   ┌─────────┴──────────────────────────────┐ │
│   │ score(d) = Σ 1/(k + rank_i(d))          │ │ ◄── rank,
│   └────────────────────────────────────────┘ │     not score
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Dense scores (cosine ~0.8) and sparse scores (BM25 ~14.2) live on different scales — you can't add them. RRF sidesteps this: a doc's contribution depends only on *where it ranked*, so the two systems vote on equal footing.

```
PATTERN — rank-based voting
  doc appears at rank 1 in dense, rank 3 in sparse
    score = 1/(60+1) + 1/(60+3)   (k=60 typical)
  high rank in EITHER list ⇒ floats up; agreement ⇒ wins
```

**Move 2 — the mechanism.** Take each list, for every doc add `1/(k + rank)` across the lists it appears in, sort by the summed score. k (≈60) damps the gap between top ranks so no single list dominates.

```
MECHANISM — sum reciprocal ranks
  dense:  [A, B, C]      A: 1/61
  sparse: [B, A, D]      B: 1/61 + 1/62  ◄── in both → wins
                         A: 1/61 + 1/62
                  ─► fused: [A≈B, C, D]
```

**Move 3 — principle.** Fuse on ranks, not raw scores — rank fusion is model-agnostic, tuning-light, and beats trying to normalize incomparable score scales.

## In this codebase

**Not yet exercised in flattr.** No dense or sparse retrieval exists, so there are no ranked lists to fuse.

The interesting aside: RRF is fundamentally *rank-merging*, and flattr **does** rank routes — A* explores candidate paths and returns the lowest-cost one (`features/routing/cost.ts`, `astar.ts`). But that ranking comes from a single explicit cost function (distance + grade penalty), not from merging multiple independent retrieval signals. There's nothing to fuse because there's only one scorer. Conceptually adjacent ("produce one ordering"), mechanically unrelated. N/A as RRF.

## See also
- [05 — Dense vs sparse](05-dense-vs-sparse.md)
- [07 — Reranking](07-reranking.md)
- [11 — RAG](11-rag.md)
