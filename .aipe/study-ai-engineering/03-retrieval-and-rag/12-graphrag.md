# GraphRAG
*Graph-based retrieval — Industry standard*

## Zoom out

GraphRAG retrieves over a **knowledge graph** — entities as nodes, relationships as edges — instead of (or alongside) a flat vector index. It shines on multi-hop questions ("how does X connect to Z?") where the answer lives in *relationships*, not in any single chunk. flattr contains a graph — but it's the wrong *kind* of graph, and that contrast is the whole lesson here.

```
LAYERS — retrieve by traversing relations
┌──────────────────────────────────────────────┐
│ query ─► find entities ─► TRAVERSE relations  │
│   ┌────────────────────────────────────────┐ │
│   │ gather connected chunks/facts           │ │ ◄── multi-hop
│   │ ─► augment prompt ─► generate           │ │     context
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Vector RAG retrieves *independent* chunks; it struggles when an answer requires chaining facts across documents. A knowledge graph encodes those connections explicitly, so retrieval = walk the edges from the query's entities and collect what they touch.

```
PATTERN — semantic edges
  [Aspirin] --treats--> [Headache] --caused_by--> [Dehydration]
       └── query "what relieves dehydration headaches?" walks these
```

**Move 2 — the mechanism.** Offline: extract entities + relations from text (often LLM-assisted) into a graph, with each node/edge pointing back to source chunks. Online: locate query entities → traverse N hops → gather the connected chunks → augment → generate. The edges carry *meaning* (treats, causes, authored-by).

```
MECHANISM — entity → traverse → gather
  query ─► entity link ─► graph walk (k hops) ─► source chunks ─► generate
```

**Move 3 — principle.** Use GraphRAG when the answer is a *path through relationships*, not a single passage — the graph's value is the edges' semantics.

## In this codebase

**Not yet exercised as GraphRAG** — and here's the irony worth sitting with: **flattr literally has a graph.** `features/routing/graph.ts` builds adjacency (`buildAdjacency`), and A* traverses it. But it is a **spatial routing graph, not a knowledge graph.**

```
CONTRAST — same data structure, opposite purpose
  GraphRAG graph │ nodes=entities, edges=SEMANTIC relations
                 │ traverse to FETCH TEXT CHUNKS for an LLM
  flattr graph   │ nodes=intersections, edges=STREET segments
                 │ traverse to FIND A PATH (lowest grade-cost)
```

GraphRAG walks meaning to retrieve documents; flattr walks geography to compute a route. Both are graph traversal, but one feeds a language model and one feeds a map. There is no LLM, no chunk, no entity-extraction step. The graph is a beautiful red herring for retrieval — great teaching contrast, not an attach point.

## See also
- [11 — RAG](11-rag.md)
- [03 — Chunking strategies](03-chunking-strategies.md)
- [06 — Hybrid retrieval (RRF)](06-hybrid-retrieval-rrf.md)
