# RAG
*Retrieval-Augmented Generation — Industry standard*

## Zoom out

RAG is three moves: **retrieve** relevant chunks from a corpus, **augment** the prompt with them, **generate** an answer grounded in those chunks. It exists to give a frozen model fresh, private, or too-large-to-fit knowledge. You built the canonical version in AdvntrCue — pgvector + GPT-4 + Drizzle + Netlify Functions, chunking, hybrid retrieval, MemoRAG session memory. flattr has no corpus, so RAG has no home here. That's not a gap; it's the right answer.

```
LAYERS — the RAG loop
┌──────────────────────────────────────────────┐
│ query ─► RETRIEVE (kNN over corpus)           │
│   ┌────────────────────────────────────────┐ │
│   │ AUGMENT prompt with top-k chunks        │ │
│   │ GENERATE grounded answer (cite sources) │ │ ◄── answer
│   └────────────────────────────────────────┘ │     ⊂ corpus
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** The model is frozen and ignorant of your private/recent data. Instead of fine-tuning, you fetch the right facts at *query time* and paste them into the prompt — the model reads them like an open-book exam.

```
PATTERN — open-book exam
  question ─► fetch relevant pages ─► [LLM reads pages] ─► grounded answer
                  (retrieval)                              (cited)
```

**Move 2 — the mechanism.** Offline: chunk corpus → embed → index. Online: embed query → retrieve top-k → template chunks + question into a prompt → LLM generates, ideally citing which chunk. Quality is gated by retrieval, not the model — garbage in, confident garbage out.

```
MECHANISM — offline index, online answer
  [offline] corpus ─► chunk ─► embed ─► index
  [online]  query ─► retrieve top-k ─► augment prompt ─► generate
```

**Move 3 — principle.** RAG is *grounding*, and grounding needs a corpus to ground *in*. The above-threshold rule: don't bolt RAG onto features that already work without retrieval — added retrieval is added failure surface.

## In this codebase

**Not yet exercised in flattr — and there is no natural attach point.** Be blunt: **RAG needs a document corpus; flattr has a graph, not documents.** `data/graph.json` is nodes and edges (street segments with grades), not a body of text to retrieve over. There is nothing to chunk, embed, or fetch.

And flattr's core feature doesn't *want* RAG. Routing is fully solved by A* over the graph (`features/routing/astar.ts`, `cost.ts`) — deterministic, offline, no retrieval needed. Adding RAG would be pure liability with zero benefit; the above-threshold rule says leave it alone.

The only conceivable future target is *user-generated* text that doesn't exist today — saved places, route history, notes. If those ever accumulated into a searchable body, a small RAG ("find my past flat routes near here") could attach. Until that corpus exists, the honest answer is: no RAG, on purpose.

## See also
- [12 — GraphRAG](12-graphrag.md)
- [01 — Embeddings](01-embeddings.md)
- [08 — Query rewriting & HyDE](08-query-rewriting-hyde.md)
