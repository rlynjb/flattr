# Embeddings
*Vector embeddings — Industry standard*

## Zoom out

An embedding turns a piece of text into a fixed-length list of floats, placed so that *similar meaning lands nearby*. It's the substrate under every retrieval system you've shipped — AdvntrCue's pgvector index is just a pile of these. flattr has none; the only float-vectors here are geographic, and "near in space" means literally near on a map, not near in meaning.

```
LAYERS — where embeddings sit (RAG stack)
┌──────────────────────────────────────────────┐
│ retrieval (kNN over vectors)                  │
│   ┌────────────────────────────────────────┐ │
│   │ embedding = f(text) → [0.02, -0.4, …]  │ │ ◄── semantic
│   │   similar meaning → small cosine dist   │ │     coordinate
│   └────────────────────────────────────────┘ │
│ embedding model (frozen encoder)              │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** An embedding is a *coordinate in meaning-space*. "steep climb" and "tough uphill" land close; "steep climb" and "flat detour" land far. Distance (cosine / dot product) is the only operation you run on them.

```
PATTERN — text → semantic coordinate
  "tough uphill"  ─►[encoder]─► ● ┐
  "steep climb"   ─►[encoder]─► ●  ├ close together (similar meaning)
  "flat detour"   ─►[encoder]─────────────● far away
```

**Move 2 — the mechanism.** You run text through a frozen encoder (one forward pass, no generation), get back e.g. a 1536-d vector, normalize it, and store it. At query time you embed the query the *same way* and find the nearest stored vectors. That's it — retrieval is k-nearest-neighbor in this space.

```
MECHANISM — embed once, search forever
  docs ─► embed ─► [vector store]
  query ─► embed ─► kNN ───────────► top-k nearest docs
                    (cosine)
```

**Move 3 — principle.** An embedding is only meaningful *relative to other embeddings from the same model*. The numbers are not interpretable alone; geometry between them is the whole point.

## In this codebase

**Not yet exercised in flattr.** There are no embeddings and no encoder — dependencies are tsx/typescript/vitest only.

Watch the name collision: flattr is full of float-vectors, but they're **geographic, not semantic**. A node's `[lat, lng]` is a coordinate where "near" means *near on the ground*; MapLibre's vector tiles (`mobile/`) are cartographic geometry. Neither is an embedding — there is no learned encoder, no meaning-space, nothing to cosine-compare. The honest summary: flattr has coordinates, not embeddings.

And there's no attach point. Embeddings exist to retrieve over a *corpus*; flattr's data is `data/graph.json` — nodes and edges, not documents. Nothing to embed.

## See also
- [02 — Embedding model choice](02-embedding-model-choice.md)
- [11 — RAG](11-rag.md)
- [04 — Vector databases](04-vector-databases.md)
