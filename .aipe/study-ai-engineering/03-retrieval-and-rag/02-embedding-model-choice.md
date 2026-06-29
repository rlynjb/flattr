# Embedding Model Choice
*Embedding model selection — Industry standard*

## Zoom out

Picking an embedding model is a near-irreversible decision: vectors from model A and model B live in incompatible spaces, so switching means **re-embedding your entire corpus**. You make this call once, early, and live with it — exactly the lock-in you accepted choosing AdvntrCue's encoder. flattr never makes this call because it has no corpus to embed.

```
LAYERS — the choice locks the space
┌──────────────────────────────────────────────┐
│ stored vectors  [model-A space]               │
│   ┌────────────────────────────────────────┐ │
│   │ switching model ⇒ space A ≠ space B     │ │ ◄── one-way
│   │   ⇒ re-embed everything, rebuild index  │ │     door
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** The embedding model defines the coordinate system. A query vector only compares meaningfully against doc vectors from *the same model*. Mix two models and cosine distance is noise.

```
PATTERN — incompatible spaces
  model A: "climb" ─► [0.1, -0.3, …]   ┐ never
  model B: "climb" ─► [0.8,  0.2, …]   ┘ comparable
```

**Move 2 — the decision axes.** You trade dimensionality (storage + speed) vs quality, domain fit (general vs code/legal/multilingual), cost (API per-token vs self-host), and max input length (caps your chunk size, file 03). Then you commit, because changing later is a full reindex.

```
MECHANISM — the one-way switch
  pick model ─► embed corpus ─► index
       │
       └─ change mind ─► RE-embed corpus ─► REbuild index  (expensive)
```

**Move 3 — principle.** Treat embedding-model choice like a database schema: cheap to pick, costly to change, so decide deliberately and pin the version.

## In this codebase

**Not yet exercised in flattr.** No embedding model is selected because nothing is embedded.

If flattr ever grew a retrieval surface (say, search over saved places or route history — neither exists today), *this* is when the choice would matter. Until there's a corpus, there is no model to pick and no space to lock in. N/A by absence, not by oversight.

## See also
- [01 — Embeddings](01-embeddings.md)
- [03 — Chunking strategies](03-chunking-strategies.md)
- [09 — Stale embeddings](09-stale-embeddings.md)
