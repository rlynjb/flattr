# Stale Embeddings
*Index staleness / re-embedding drift — Industry standard*

## Zoom out

An embedding is a *snapshot* of text at embed-time. Edit the source text and the stored vector still describes the old version — retrieval now matches against a ghost. This is the silent corruption of every RAG system; you guard against it in AdvntrCue by re-embedding on edit. flattr has no embeddings — but it has the *exact same staleness shape* one layer over, in its prebuilt graph.

```
LAYERS — the snapshot drifts from truth
┌──────────────────────────────────────────────┐
│ source text  (edited)        ✎                │
│   ┌────────────────────────────────────────┐ │
│   │ stored vector (NOT re-embedded)         │ │ ◄── describes
│   │   retrieval matches stale meaning       │ │     the past
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** The vector and the text are two copies of the same fact; if you mutate one without the other, they disagree and the index lies. Staleness is a cache-invalidation problem wearing an ML costume.

```
PATTERN — drift
  t0: text="6% max" ─► embed ─► vec₀  (in sync)
  t1: text="9% max" (edited)  ─► vec₀ unchanged ─► STALE
```

**Move 2 — the mechanism.** You need an invalidation trigger: track a content hash or `updated_at` per chunk; on change, re-embed and overwrite the vector + bump the index. Skip the trigger and queries silently retrieve outdated content — no error, just wrong.

```
MECHANISM — re-embed on change
  edit ─► hash differs? ─► re-embed chunk ─► overwrite vector
                        └─ no? ─► keep      (cheap)
```

**Move 3 — principle.** Every embedding is a cache of its source — wire an invalidation trigger at write time, or accept silent rot.

## In this codebase

**Not yet exercised in flattr** as embeddings — there are none.

But the **staleness shape is real here**, just in a different domain. `data/graph.json` is a *prebuilt static artifact*: `pipeline/run-build.ts` fetches OSM geometry and elevation, computes grades, and freezes them into JSON the app ships with. If OSM adds a road, or the elevation source updates its DEM, the bundled graph keeps serving the *old* world until someone re-runs the build. Same failure mode as stale embeddings — a precomputed snapshot diverging from the live source, silently, with no error — different artifact (graph vs vector index). The cure rhymes too: re-derive from source on change. Worth naming this analog explicitly; that's the honest transfer.

## See also
- [10 — Incremental indexing](10-incremental-indexing.md)
- [01 — Embeddings](01-embeddings.md)
- [04 — Vector databases](04-vector-databases.md)
