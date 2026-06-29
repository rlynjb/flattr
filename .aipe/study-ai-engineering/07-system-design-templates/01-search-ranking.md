# 01 — Design a Search + Ranking System

**Query → candidate retrieval → ranking → results. The classic interview reframe — and flattr has a search UI but no ranking layer of its own.**

This is a generic system-design template, not a flattr walkthrough. The shape shows up in every search loop: a user types a query, you retrieve a cheap candidate set, you re-score those candidates with something more expensive, and you return the top few. In the LLM era the "expensive" stage is often a learned re-ranker (cross-encoder) or an embedding-similarity step. The interview question is always the same: *where does each stage live, and what's the latency/quality tradeoff at each boundary?*

## The standard architecture

```
Search + ranking pipeline (generic)
┌──────────┐   ┌──────────────────┐   ┌─────────────────┐   ┌──────────┐
│  query   │──▶│ candidate         │──▶│ ranker           │──▶│ top-k    │
│  "elm st"│   │ retrieval         │   │ (score & sort)   │   │ results  │
└──────────┘   │ (recall stage)    │   │ (precision stage)│   └──────────┘
               │ cheap, high-recall│   │ expensive, learned│
               │ inverted index /  │   │ cross-encoder /  │
               │ ANN / BM25        │   │ feature model    │
               └──────────────────┘   └─────────────────┘
                       │                       │
                  thousands              re-score top ~100
                  of hits                keep top ~10
```

The whole game is **two stages with different cost profiles**: retrieval is tuned for recall (don't miss the right answer), ranking is tuned for precision (put it at the top). You never run the expensive ranker over the whole corpus.

## Data model + scale concerns (brief)

- **Index**: an inverted index (term → doc ids) or an ANN index (vector → neighbors). Updated incrementally as the corpus changes.
- **Candidate set size**: the knob between latency and recall. Retrieve 100, re-rank 100, show 10.
- **Ranking features**: text-match score, freshness, popularity, personalization, geographic proximity. A learned ranker combines them.
- **Scale**: shard the index by term or by space; cache hot queries; debounce keystroke traffic; budget the ranker's per-candidate cost (a cross-encoder at 100 candidates is 100 model calls).

## Applies to this codebase

Partially — and the honest answer is *the shape is there, the ranking is not.*

- **There is a real search UI.** `mobile/src/AddressBar.tsx` renders From/To inputs with a live suggestion dropdown (`Suggestions`, line 9; rendered at lines 84 and 103). It is a genuine query→results loop visually.
- **But the "ranker" is Nominatim's, not flattr's.** `pipeline/geocode.ts` `geocodeSuggest` (line 31) is a **thin pass-through**: it builds a query string, hits `https://nominatim.openstreetmap.org/search`, and maps the rows straight to `GeocodeResult` (line 52) — no flattr-side scoring, no re-sort, no learned features. The order you see is whatever OSM returned. The only flattr-side knobs are `limit` (line 41) and the `viewbox`/`bounded` bias (lines 42–45) — that's recall shaping, not ranking.
- **A\* "ranks" routes — but by objective, not by learning.** `features/routing/cost.ts` is the closest thing to a ranking function in the whole repo. `gradeCostDirected` (line 32) scores each edge by distance × grade-penalty, and A* (`features/routing/astar.ts`) returns the *single* lowest-cost path. That's **ranking-by-explicit-objective** — a hand-written cost function, the opposite of a learned ranker. There is no candidate *set* of routes being re-scored; A* returns one winner.
- **The nearest LLM seam:** if you ever fed candidates into a model, the output→prompt seam is `features/routing/summary.ts:11` (route totals, the natural thing to describe) and the input→prompt seam is `pipeline/geocode.ts:9`. Neither is wired to anything ranking-shaped today.

Verdict: flattr is a **retrieval pass-through + an objective-cost optimizer**. It has neither half of a learned search-ranking system.

## How to make it apply

Two concrete, in-repo refactors if you wanted to actually build the template here:

**A. A learned (or heuristic) re-ranker over geocode results.**
Today `geocodeSuggest` returns OSM's order verbatim. Insert a ranking stage in `pipeline/geocode.ts` between the `rows.map(...)` (line 52) and the return:

```
Re-ranked autocomplete (proposed)
geocodeSuggest ─▶ rows (OSM order) ─▶ rankSuggestions(rows, ctx) ─▶ top-k
                                       │
                                       ├─ proximity to map center / current loc
                                       ├─ string-match strength vs query
                                       └─ (later) a learned scorer from tap logs
```

Concretely: add `rankSuggestions(results: GeocodeResult[], ctx: { center?: [lat,lng]; query: string }): GeocodeResult[]`, sort by a feature blend, and have `AddressBar.tsx` render the re-sorted list. Start heuristic (distance + match), then — if you log which suggestion the user actually taps — train a tiny logistic ranker offline and ship it as the scoring function. That turns the pass-through into a real two-stage search.

**B. Learned route ranking in `features/routing/cost.ts`.**
The cost weights `DEFAULT_K1`/`DEFAULT_K2` (lines 8–9) and the penalty shape (line 16) are hand-tuned. The "make it learned" version: emit *multiple* candidate routes (e.g. run A* with several cost profiles, or k-shortest-paths), then rank them with a model trained on which route users accepted. That's the candidate-retrieval → ranking split applied to routes instead of documents — `astar.ts` becomes the recall stage, a learned scorer becomes the precision stage.

Both are real features, not toys — but both are net-new ML that flattr deliberately doesn't have. As shipped, flattr's "ranking" is a 6-line cost function, and that's the right call for a routing engine.

## See also

- `03-retrieval-and-rag/07-reranking.md` — the reranking concept in isolation (also N/A in flattr today)
- `03-retrieval-and-rag/06-hybrid-retrieval-rrf.md` — merging retrieval signals; note A* ranks by cost, not by signal merge
- `01-search-ranking.md`'s sibling `02-tech-support-chatbot.md` — the other generic template here
- Real seams: output→prompt `features/routing/summary.ts:11`; input→prompt `pipeline/geocode.ts:9`; injection vector `pipeline/geocode.ts:27,52,69`
