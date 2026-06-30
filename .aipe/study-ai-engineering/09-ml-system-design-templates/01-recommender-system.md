# 01 — Recommender System

A reusable interview template, reframed against flattr. flattr has no recommender,
so the honest answer below is "no" — the value here is knowing the standard shape
well enough to say *why* it doesn't fit and what the nearest analog actually is.

- **The prompt:** "Design a recommender that surfaces N items per user from a catalog of M items, maximizing engagement."

- **Standard architecture:** A recommender is a two-stage funnel — a cheap candidate generator narrows M to a few hundred, then an expensive ranker scores those for a single user. The diagram below shows the request path with the offline training loop feeding both stages.

```
                    Recommender — two-stage retrieve-then-rank
  ┌──────────────┐   user_id    ┌─────────────────────┐
  │  Client UI   │─────────────►│  Serving API        │
  │ (feed/shelf) │◄─────────────│  (N ranked items)   │
  └──────────────┘   N items    └──────────┬──────────┘
                                            │ candidate request
                                            ▼
                          ┌───────────────────────────────┐
                          │ Stage 1: Candidate Generation  │
                          │ ANN / co-visitation  M ► ~500  │
                          └───────────────┬───────────────┘
                                          │ ~500 candidates
                                          ▼
                          ┌───────────────────────────────┐
                          │ Stage 2: Ranker                │
                          │ learned scorer  ~500 ► N       │
                          └───────────────┬───────────────┘
                                          │ logs (impression, click)
                                          ▼
                          ┌───────────────────────────────┐
                          │ Offline training (batch)       │
                          │ embeddings + ranker weights    │
                          └───────────────────────────────┘
```

  The logged interactions close the loop: yesterday's impressions become today's training labels. flattr has none of these boxes.

- **Data model:** Three stores. A user/item interaction log (user_id, item_id, event, timestamp) is the label source. An item feature store (embeddings, categorical attributes) and a user feature store (history, demographics) feed the ranker. Item embeddings live in an ANN index for stage-1 retrieval. flattr stores none of this: its only persisted artifact is the static `mobile/assets/graph.json` (nodes and edges of a street graph), and it has no user identity, no event log, and no per-user state beyond the in-memory `userMax` slider value.

- **Key components:** Candidate generator — approximate-nearest-neighbor over item embeddings; the technical choice is ANN over exact search because at M in the millions, exact top-k per request blows the latency budget and recall@500 from a good ANN index is close enough. Ranker — a gradient-boosted or neural scorer over (user, item) features; the choice is a pointwise/pairwise learned model over hand-tuned weights because engagement objectives shift and a learned ranker re-fits from logs without a code change. Logging pipeline — append-only impression/click stream; the choice is to log impressions (not just clicks) so the ranker sees negatives, otherwise it overfits to whatever the old policy already surfaced.

- **Scale concerns (ordered by what hits first):** (1) Candidate latency — once M passes a few hundred thousand items, stage-1 must be ANN, not a scan; a 50ms per-request p99 budget breaks first. (2) Feature freshness — user features computed in nightly batch go stale within a session; a streaming feature path is needed past roughly daily-active users in the hundreds of thousands. (3) Cold start — new items have no interaction history and never get retrieved; content features must backfill the embedding. (4) Feedback-loop bias — the ranker trains on items the old ranker chose, narrowing the catalog over weeks; needs exploration injection.

- **Eval framing:** Offline — recall@N and NDCG against held-out future interactions, plus a counterfactual estimate (inverse-propensity) since logged data is biased by the serving policy. Online — A/B test on the real engagement objective (click-through, dwell, retention), because offline NDCG routinely disagrees with online lift. The gap between the two is the whole reason online testing exists.

- **Common failure modes:** Popularity collapse — the ranker learns to always surface head items; mitigate with diversity penalties or per-slot exploration. Feedback loop — narrowing catalog from training on own output; mitigate with epsilon-exploration and impression logging. Stale features — a user's last 5 actions aren't reflected; mitigate with a real-time feature path. Train/serve skew — the ranker sees different feature values offline vs online; mitigate with a shared feature-transformation library.

- **Applies to this codebase: NO.** flattr is not a recommender and has no part of this architecture. There is no catalog of items, no user identity, no interaction log, no candidate generation, and no ranker trained on engagement. flattr solves a single deterministic query — shortest grade-penalized path between two points — with A* over a static graph. The closest thing to "scoring" in the codebase is the learned-ish edge cost in `features/routing/cost.ts`: `penalty(g, max, k1, k2)` (cost.ts:16) produces a per-edge multiplier, and `gradeCostDirected` (cost.ts:32) is the `CostFn` that A* minimizes. That *is* a ranking of edges in the sense that A* prefers cheaper ones — but it is optimization inside a graph search, not recommendation. It has no user model, no candidate set, and no engagement objective; it is admissible scalar cost minimization, not top-N selection over a catalog. Calling it a recommender would be wrong.

- **How to make it apply (honest stretch):** The only flattr surface with anything recommender-shaped is the `userMax` preset chooser. `USERMAX_PRESETS` in `features/grade/classify.ts:46` already lists three presets (Kick scooter = 5, Walking = 8, Any = 15) and `GradeSlider` lets the user pick one. A genuinely tiny single-user, content-based / rules recommender would suggest a default preset instead of making the user choose blind: take the just-completed route's realized grade distribution (the `gradePct`/`absGradePct` on the chosen edges), and rule-recommend "you took a Walking route but hit three red segments — try Kick scooter next time." That is content-based filtering with a population of one and a catalog of three, which is barely a recommender at all — be honest that it is a UX nicety dressed in the vocabulary, not a system worth the two-stage architecture above. To make it real you would add: an interaction log of (route_query, chosen_preset, completed?) persisted locally, and a rules table mapping realized-grade summaries to a suggested preset. The learned cost in `cost.ts` is *not* the place this attaches — that ranks edges, not presets. I've shipped on-device ML before (contrl runs a MediaPipe pose-landmark model to count reps end-to-end on device), so I know what a real model-backed feature costs to build; the honest read is that flattr's preset suggestion does not need one and shouldn't pretend to.
