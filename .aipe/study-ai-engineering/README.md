# Study: AI engineering — flattr

flattr has **no LLM, no embeddings, no RAG, no vector store, no trained
model**. This guide teaches the AI/ML concepts as study material and
anchors each to the real file:line **seam** in this repo where it would
attach. Honest mode throughout — nothing is invented.

## Read these first

- [00-overview.md](00-overview.md) — the four seams, the framing.
- [ai-features-in-this-codebase.md](ai-features-in-this-codebase.md) — what AI is NOT here + the 3 LLM seams.
- [ml-features-in-this-codebase.md](ml-features-in-this-codebase.md) — what ML is NOT here + the 1 ML attach point (and why `classify.ts` is not a classifier).

## The four anchors

| Seam | File:line | Concept |
|------|-----------|---------|
| Output → prompt | `features/routing/summary.ts:5`, consumed `mobile/src/MapScreen.tsx:368` | route-describe LLM feature |
| Input → prompt | `pipeline/geocode.ts:9`, called `mobile/src/MapScreen.tsx:82` | NL destination parsing |
| Trust boundary | `pipeline/geocode.ts:27` (`display_name`) | prompt injection vector |
| ML attach point | `features/routing/cost.ts:16` (`penalty()`) | learned edge cost (≥0, monotone, finite BLOCKED) |

## Sub-sections

- [01-llm-foundations/](01-llm-foundations/README.md) — LLM IO model, tokens, sampling, structured outputs, streaming, token cost, heuristic-before-LLM, provider abstraction, override locks.
- [02-context-and-prompts/](02-context-and-prompts/README.md) — context window, lost-in-the-middle, prompt chaining.
- [03-retrieval-and-rag/](03-retrieval-and-rag/README.md) — embeddings through RAG and GraphRAG.
- [04-agents-and-tool-use/](04-agents-and-tool-use/README.md) — agents vs chains, tool calling, ReAct, routing, memory, recovery.
- [05-evals-and-observability/](05-evals-and-observability/README.md) — eval sets, methods, LLM-as-judge, observability.
- [06-production-serving/](06-production-serving/README.md) — caching, cost, **prompt injection (the live concern)**, rate limiting, retry/circuit-breaker.
- [07-system-design-templates/](07-system-design-templates/README.md) — search ranking, tech-support chatbot (interview reframes).
- [08-machine-learning/](08-machine-learning/README.md) — supervised ML through retraining, anchored to the `cost.ts` learned-cost attach point.
- [09-ml-system-design-templates/](09-ml-system-design-templates/README.md) — recommender, anomaly detection, object detection / CV.

## Cross-links (sibling guides)

runtime-systems · networking · database-systems · dsa-foundations ·
system-design · software-design · frontend-engineering · data-modeling ·
security · testing · distributed-systems · debugging-observability ·
performance-engineering · prompt-engineering · agent-architecture

The graph/A\* substance lives in **dsa-foundations** and
**system-design**; the `display_name` trust boundary is shared with
**security**; the on-device serving story connects to
**performance-engineering**.
