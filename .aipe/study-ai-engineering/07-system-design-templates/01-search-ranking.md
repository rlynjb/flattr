# Search & Ranking

An interview-reframe template. The same flattr code, viewed through the lens of a
search-ranking system-design prompt. Answered honestly about flattr's current state.

## The prompt

"Design a search ranking system that takes a query and returns top-k relevant items."

## Standard architecture

The canonical answer is a two-stage funnel: a cheap retrieval pass narrows millions
of candidates to hundreds, then an expensive learned ranker reorders them using
features, with click logs feeding a training loop that closes back onto the ranker.

```
                 SEARCH RANKING — canonical two-stage funnel
  ┌─────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
  │  query  │──► │  retrieval   │──► │ feature build │──► │ learned rank │──► top-k
  └─────────┘    │ (recall, ~k0)│    │ per candidate │    │ (precision)  │
                 └──────────────┘    └───────────────┘    └──────────────┘
                       ▲                                          │
                       │                                          ▼
                 ┌──────────┐         ┌──────────────────┐   ┌─────────┐
                 │  index   │ ◄────── │  training loop    │◄──│ click   │
                 │ (ANN/BM25)│        │ (offline retrain) │   │  logs   │
                 └──────────┘         └──────────────────┘   └─────────┘
```

The load-bearing idea is the feedback edge: the system gets better because it watches
which result the user picked and trains on that signal.

## Data model

- **Index**: inverted index (BM25) or vector index (ANN over embeddings), keyed by item.
- **Feature store**: per-(query,item) features — text match, freshness, popularity, prior CTR.
- **Click/interaction logs**: (query, shown list, clicked position, dwell) — the training fuel.
- **Model artifact**: serialized ranker (GBDT / learned-to-rank weights), versioned.

## Key components

- **Retriever** — recall-optimized first pass. Technical choice: ANN (HNSW) when
  relevance is semantic; BM25 when it's lexical. Pick by whether synonyms matter.
- **Ranker** — precision-optimized reorder over the candidate set. Technical choice:
  pairwise/listwise LTR over pointwise, because ranking quality is about *order*, not
  absolute score.
- **Feature pipeline** — must compute identically offline (training) and online
  (serving) or you get train/serve skew. Choice: shared feature code, one definition.
- **Logging** — log impressions, not just clicks, or you can't model what was *not*
  chosen.

## Scale concerns

Ordered by what hits first as the corpus grows.

- **At ~10k items**: linear scan retrieval is fine; no index needed. This is where
  flattr's graph lives today (`nearest.ts` scans every node).
- **At ~1M items**: linear scan dies; you need an inverted or ANN index, and index
  build/refresh becomes its own pipeline with staleness budgets.
- **At ~10M+ items**: feature computation dominates latency. You shard the index, cache
  hot queries, and move feature joins off the request path into a feature store.
- **Logging volume** outgrows the serving fleet before the model does — click logs at
  scale are a data-engineering problem (sampling, partitioning) before they're an ML one.

## Eval framing

- **Offline**: NDCG@k / MRR / MAP against a held-out judged set; replay click logs as
  counterfactual relevance.
- **Online**: CTR, click-through position, abandonment rate, session success — measured
  by interleaving or A/B, because offline NDCG and online CTR routinely disagree.

## Common failure modes

- **Train/serve skew** — features differ between training and serving. Mitigation: one
  feature definition, shared code path, monitored feature distributions.
- **Feedback loop / popularity bias** — the ranker only ever shows popular items, so
  only popular items get clicks, so they stay popular. Mitigation: exploration
  (epsilon-random slots), position-debiased training.
- **Stale index** — new items aren't retrievable until the next build. Mitigation:
  incremental indexing with a real-time tier for fresh items.
- **Cold-start query/item** — no logs, no features. Mitigation: content-based fallback
  features and sane retrieval-only ordering.

## Applies to this codebase

**Partially.** flattr has two genuine retrieval surfaces and zero ranking. The
autocomplete (`geocodeSuggest`, `pipeline/geocode.ts:31`, called from
`MapScreen.tsx:82`) is a query-to-candidates surface — you type, it returns up to five
place matches. And `features/routing/nearest.ts` is a literal nearest-neighbor search:
given a tapped coordinate, scan every node in the static `graph.json` and return the
closest by haversine distance. That is the retrieval *instinct* — query in, ranked-by-
distance candidates out. But the resemblance stops at the funnel's first box. There is
no learned ranker, no embeddings, no feature store, and critically no click logs:
flattr never records which suggestion the user picked, so there is no signal to learn
from and nothing closes the feedback loop. The "ranking" in `geocodeSuggest` is
whatever order Nominatim returns; the "ranking" in `nearestNode` is pure geographic
distance. Both are deterministic geometry, not relevance learning. Calling flattr a
search-ranking system would overclaim — it does stage-one retrieval and stops.

## How to make it apply

The cheapest honest step is to start logging. Today `MapScreen.tsx:82` calls
`geocodeSuggest` and the user taps one of the returned `GeocodeResult` rows, but that
choice evaporates. Add a `(query, shownLabels[], pickedIndex)` log at the tap site —
that's the click log the canonical architecture is built around, and flattr has no
backend so it'd start as a local append-only file behind the same INPUT seam.

Once logs exist, rank the suggestions before display: a `rankSuggestions(query,
results, history)` shim between `geocodeSuggest` and the render, scoring by features
flattr already has — distance from current map center, prior pick frequency, prefix
match strength. Start with a hand-weighted score (mirrors `cost.ts:16` `penalty()`,
which is also a tunable hand-weighted function), then swap the weights for a learned
model once the pick-log is large enough. That is exactly the retrieval-then-rank
instinct I shipped in AdvntrCue (pgvector recall into a GPT-4 rerank); here it would
attach at flattr's geocode INPUT seam rather than over documents. Keep the framing
honest in the room: flattr today is retrieval-only, and the refactor adds the ranking
stage it currently lacks.
