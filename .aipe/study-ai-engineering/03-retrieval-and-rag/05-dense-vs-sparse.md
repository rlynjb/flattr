# Dense vs Sparse Retrieval
*Dense (embedding) vs sparse (lexical) — Industry standard*

## Zoom out

Two ways to retrieve text: **dense** (embeddings — match by meaning) and **sparse** (BM25/TF-IDF — match by exact words). Dense catches paraphrase; sparse catches rare tokens, codes, and names dense models smear together. You combined both in AdvntrCue's hybrid retrieval. flattr does *no text search of any kind*, dense or sparse, so neither applies.

```
LAYERS — two retrieval signals
┌──────────────────────────────────────────────┐
│ dense  │ cosine over embeddings   → meaning   │
│ sparse │ term overlap (BM25)      → exact words│
│   ┌────────────────────────────────────────┐ │
│   │ best systems run both, then merge       │ │
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Dense knows "automobile" ≈ "car" but can miss "SKU-4471". Sparse nails "SKU-4471" but thinks "car" and "automobile" are unrelated. Their failure modes are complementary — that's why hybrid exists (file 06).

```
PATTERN — complementary blind spots
  query "steep hill"
    dense  ─► finds "tough climb", "abrupt grade"  (paraphrase ✓)
    sparse ─► finds docs literally saying "steep hill" (exact ✓)
```

**Move 2 — the mechanism.** Dense: embed query, kNN over vectors. Sparse: build an inverted index (term → doc list), score by BM25 (term frequency × inverse doc frequency, length-normalized). Each returns a ranked list; you fuse them.

```
MECHANISM — two pipelines
  query ─┬─► embed ─► vector kNN ─► ranked list A
         └─► tokenize ─► inverted index/BM25 ─► ranked list B
                                          (merge → file 06)
```

**Move 3 — principle.** Don't pick one — dense and sparse fail differently, so production retrieval runs both and fuses the rankings.

## In this codebase

**Not yet exercised in flattr.** There is no full-text search, no inverted index, no embeddings — neither retrieval mode is present.

The closest thing to a "lookup" in flattr is geocoding (`pipeline/geocode.ts`), but that's an outbound HTTP call to Nominatim (OSM's geocoder) — flattr doesn't index or rank anything itself; it hands a string to a remote service and takes the first row. No dense, no sparse, nothing to fuse. N/A.

## See also
- [06 — Hybrid retrieval (RRF)](06-hybrid-retrieval-rrf.md)
- [01 — Embeddings](01-embeddings.md)
- [07 — Reranking](07-reranking.md)
