# 01 — LLM Foundations

The string→string function and the engineering that surrounds it. These are the primitives every LLM feature is built from — sampling, tokens, schemas, cost, provider seams — taught as study material against the flattr codebase.

> **All nine concepts are NOT YET EXERCISED in flattr.** flattr has no LLM, no embeddings, no RAG, no vector store, no trained model, no inference runtime. Its dependencies are tsx/typescript/vitest (engine) and maplibre-react-native/expo/react-native (mobile). Each file is honest about this and points at the precise *seam* where the concept would attach if a model were ever added. The one partial exception is file 07 (Heuristic Before LLM): flattr already embodies its deterministic-first half in real code — it simply has no LLM fallback by design (spec §14, "hand-rolled only").

## The three real seams these files anchor to

```
SEAMS — where an LLM would attach (all currently absent)
┌──────────────────────────────────────────────────────────┐
│ INPUT→PROMPT   pipeline/geocode.ts:9                        │
│   raw user text → Nominatim. Wrap for NL destination parse. │
│   (also the injection vector: geocode.ts:27,52,69 returns   │
│    untrusted OSM display_name)                               │
│                                                              │
│ OUTPUT→PROMPT  features/routing/summary.ts:11               │
│   routeSummary() → {distanceM, climbM, steepCount}.          │
│   Cleanest LLM attach point: narrate the struct to a         │
│   sentence. Consumed at MapScreen.tsx:159 / RouteSummaryCard │
└──────────────────────────────────────────────────────────┘
```

## Files

| # | Concept | Type | Status |
|---|---------|------|--------|
| 01 | [What an LLM Is](01-what-an-llm-is.md) | Industry standard | Not yet exercised — output→prompt seam (summary.ts:11) |
| 02 | [Tokenization](02-tokenization.md) | Industry standard | Not yet exercised — payload trivially small |
| 03 | [Sampling Parameters](03-sampling-parameters.md) | Industry standard | Not yet exercised — narration would want temp=0 |
| 04 | [Structured Outputs](04-structured-outputs.md) | Industry standard | Not yet exercised — key seam: typed destination at geocode.ts:9 |
| 05 | [Streaming](05-streaming.md) | Industry standard | Not yet exercised — output too short to stream |
| 06 | [Token Economics](06-token-economics.md) | Industry standard | Not yet exercised — no cost ledger, trivial volume |
| 07 | [Heuristic Before LLM](07-heuristic-before-llm.md) | Language-agnostic | Heuristic half fully exercised (classify.ts, cost.ts); no LLM fallback by design |
| 08 | [Provider Abstraction](08-provider-abstraction.md) | Language-agnostic | Not yet exercised — would live in features/routing/narrate.ts |
| 09 | [User Override Locks](09-user-override-locks.md) | Language-agnostic | Not yet exercised — GradeSlider userMax is single-author, no lock needed |
