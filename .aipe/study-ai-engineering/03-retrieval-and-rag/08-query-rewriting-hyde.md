# Query Rewriting & HyDE
*Query transformation / Hypothetical Document Embeddings — Industry standard*

## Zoom out

User queries are short, vague, and underspecified; documents are verbose and declarative — so they embed *far apart* even when relevant. Query rewriting closes that gap: an LLM expands or restates the query, and **HyDE** goes further — it asks the LLM to *hallucinate a plausible answer*, then embeds that to retrieve real docs. flattr has a real input→prompt seam that *looks* adjacent, but it's geocoding, not document retrieval.

```
LAYERS — transform query before retrieval
┌──────────────────────────────────────────────┐
│ raw query "flat way home" (vague, sparse)     │
│   ┌────────────────────────────────────────┐ │
│   │ rewrite / HyDE → richer text to embed   │ │ ◄── better
│   │   then kNN over the corpus              │ │     match
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** A question and its answer don't look alike, but two *answers* do. HyDE exploits this: generate a fake answer to the query (it can be wrong on facts), embed *that*, and its vector lands near genuine answer-docs.

```
PATTERN — HyDE
  "what's a flat route?" ─►[LLM]─► "A flat route avoids grades
                                     over 6%, favoring valleys…"
                                          │ embed THIS
                                          ▼
                                   kNN ─► real docs near it
```

**Move 2 — the mechanism.** Rewriting: LLM rephrases/expands/decomposes the query (maybe into several sub-queries) before retrieval. HyDE: LLM drafts a hypothetical passage → embed it → retrieve → discard the draft, keep the real hits. Both add one LLM call in front of retrieval.

```
MECHANISM — LLM in front of retrieval
  query ─► [LLM rewrite/HyDE] ─► embed ─► retrieve ─► real docs ─► generate
```

**Move 3 — principle.** When query and corpus speak different dialects, translate the query into the corpus's dialect *before* you search — don't expect the index to bridge the gap.

## In this codebase

**Not yet exercised in flattr.** No LLM, no retrieval — so no query rewriting and no HyDE.

There *is* a real input→prompt seam at `pipeline/geocode.ts:9` — `geocode(query)` takes a fuzzy human destination ("the bakery on Elm") and resolves it to a coordinate. Superficially that's "rewriting a vague query." But the distinction matters: geocoding resolves a *place name to a point* via Nominatim; query rewriting reshapes text to retrieve *documents*. flattr's query targets a map, not a corpus. If an LLM ever pre-normalized the user's destination phrasing before that call, *that* would be query rewriting — but it would still feed geocoding, not document retrieval. Note the seam; it is not RAG query rewriting. Not exercised.

## See also
- [11 — RAG](11-rag.md)
- [05 — Dense vs sparse](05-dense-vs-sparse.md)
- [01 — Embeddings](01-embeddings.md)
