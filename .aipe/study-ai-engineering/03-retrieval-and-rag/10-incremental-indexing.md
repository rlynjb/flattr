# Incremental Indexing
*Delta indexing vs full reindex — Industry standard*

## Zoom out

When source data changes, you either re-embed and rebuild the *whole* index (simple, slow, costly) or embed only the **deltas** and patch the index in place (fast, cheap, fiddly). The right call depends on corpus size and change rate — a tradeoff you weigh in AdvntrCue every time content updates. flattr has no embedding index, but its build pipeline embodies one end of this exact tradeoff: full rebuild only.

```
LAYERS — two update strategies
┌──────────────────────────────────────────────┐
│ source change ─┬─► FULL: re-embed all, rebuild │
│                └─► DELTA: embed changed only,  │
│   ┌──────────────────── patch index ────────┐ │
│   │ full = correct & dumb; delta = fast & risky│ │
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Full rebuild is a pure function of current source — always consistent, but you pay to redo unchanged work. Incremental is a diff applied to live state — cheap, but you must track adds/edits/deletes correctly or the index drifts.

```
PATTERN — full vs delta
  full   │ ∀ docs: embed → fresh index        (O(corpus))
  delta  │ changed docs only: upsert/delete    (O(changes))
```

**Move 2 — the mechanism.** Incremental needs change detection (hashes / timestamps / a change log), then per-doc *upsert* for adds-and-edits and *tombstone* for deletes against the existing index. Full rebuild needs none of that — just re-run from scratch and swap.

```
MECHANISM — delta path
  diff source ─► {added, edited, deleted}
       added/edited ─► embed ─► upsert
       deleted      ─► remove from index
  (vs full: throw away index, rebuild all)
```

**Move 3 — principle.** Start with full rebuilds — they're trivially correct; reach for incremental only when rebuild cost or latency actually hurts.

## In this codebase

**Not yet exercised in flattr** as an embedding index — there's no index.

But the **same tradeoff lives in the build pipeline**, in graph-build form. `pipeline/run-build.ts` does a **full rebuild**: it re-fetches OSM for the whole BBOX, re-samples elevation for every segment, recomputes all grades, and rewrites `data/graph.json` end to end. There is no delta path — change one road and you rebuild the entire graph. That's the "full, correct, dumb" end of this axis, chosen sensibly because the corpus (one city BBOX) is small and rebuilds are infrequent. The honest mapping: full-vs-incremental is a real engineering decision flattr makes — just over a street graph, not an embedding store.

## See also
- [09 — Stale embeddings](09-stale-embeddings.md)
- [03 — Chunking strategies](03-chunking-strategies.md)
- [04 — Vector databases](04-vector-databases.md)
