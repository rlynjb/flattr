# Chunking Strategies
*Document chunking — Industry standard*

## Zoom out

Chunking decides the **unit of retrieval**: you split documents into pieces, embed each piece, and retrieve pieces — not whole docs. The chunk boundary quietly determines recall and precision; you tuned this in AdvntrCue (chunk + overlap + hybrid). flattr's atomic unit isn't a text chunk at all — it's a graph edge — so there's nothing to chunk.

```
LAYERS — chunk = what gets retrieved
┌──────────────────────────────────────────────┐
│ document                                      │
│   ┌──────┐ ┌──────┐ ┌──────┐                  │
│   │chunk1│ │chunk2│ │chunk3│  ◄── each embedded│
│   └──────┘ └──────┘ └──────┘      & retrievable│
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Too big a chunk and one vector blurs many ideas (bad precision); too small and you sever context (bad recall). Chunk size is a recall/precision dial, plus overlap so ideas straddling a boundary survive.

```
PATTERN — the three families
  fixed       │ every N tokens, +overlap     (simple, blind)
  sentence    │ on sentence/paragraph breaks (semantic-ish)
  structural  │ on headings/code blocks/rows (respects shape)
```

**Move 2 — the mechanism.** Split → optionally overlap → embed each chunk → store chunk text + vector + a pointer back to the source doc. At retrieval you fetch chunks and stitch their source context for the prompt.

```
MECHANISM — split then index
  doc ─► splitter ─► [chunk + overlap]* ─► embed each ─► store
                                                   │
                                       (each row: text, vec, doc-ref)
```

**Move 3 — principle.** Chunk on the document's natural seams, not arbitrary byte counts — structure-aware chunks retrieve better than fixed windows almost every time.

## In this codebase

**Not yet exercised in flattr.** There's no text to split.

The honest reframe: flattr already *has* an atomic unit — the graph **edge** in `data/graph.json` (a street segment with `gradePct`, `riseM`, length). But an edge is a retrieval unit for *pathfinding* (A* over adjacency in `features/routing/graph.ts`), not a chunk for *semantic search*. Chunking presupposes documents and embeddings; flattr has geometry and a cost function. Same idea ("pick the right granular unit"), entirely different machine. N/A.

## See also
- [01 — Embeddings](01-embeddings.md)
- [10 — Incremental indexing](10-incremental-indexing.md)
- [12 — GraphRAG](12-graphrag.md)
