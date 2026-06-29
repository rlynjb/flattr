# 02 — Design an LLM Tech-Support Chatbot

**RAG over a support corpus + tool-calling + guardrails. The canonical LLM interview question — and it has essentially zero attach point in flattr.**

This is a generic system-design template. The classic ask: build a support assistant that answers user questions by retrieving from your docs (RAG), can take actions on the user's behalf (tool-calling), and won't go off the rails (guardrails). It's worth knowing cold because it bundles three subsystems every LLM product eventually grows. But be blunt up front: **flattr has no chat surface, no support corpus, and no model.** This file teaches the template and then says honestly where the single thin analog lives.

## The standard architecture

```
LLM support chatbot (generic)
┌──────────┐   ┌──────────────┐   ┌─────────────────────┐   ┌──────────┐
│ user turn│──▶│ retrieve      │──▶│ LLM (system prompt + │──▶│ guardrail │──▶ reply
│ "reset   │   │ from docs     │   │ retrieved context +  │   │ filter    │
│  my pw"  │   │ (RAG)         │   │ tool definitions)    │   └──────────┘
└──────────┘   └──────────────┘   └─────────────────────┘
                     ▲                    │   ▲
              support corpus         tool-call │ tool result
              (vector store)              ▼   │
                                  ┌──────────────────┐
                                  │ tools: lookup     │
                                  │ order, reset pw,  │
                                  │ escalate to human │
                                  └──────────────────┘
```

Three subsystems:
- **RAG** grounds answers in your real docs so the model doesn't hallucinate policy.
- **Tool-calling** lets it *do* things (look up an account, file a ticket) instead of just talking.
- **Guardrails** sit on both input (prompt-injection, abuse) and output (PII leakage, off-topic, hallucinated promises) — plus a human-escalation path.

## Data model + scale concerns (brief)

- **Corpus**: support articles chunked and embedded; re-indexed when docs change.
- **Conversation state**: turn history, possibly summarized to fit the context window.
- **Tool registry**: typed function schemas the model can call; each needs auth + a permission boundary.
- **Guardrail tier**: cheap classifiers before the expensive model; output validation after.
- **Scale**: cache common answers, batch embeddings, rate-limit per user, and track deflection rate (tickets the bot resolved without a human) as the north-star metric.

## Applies to this codebase

**Not at all.** This is the most honest verdict in the whole section.

- **No chat.** There is no conversational surface anywhere in flattr. The only text-input UI is `mobile/src/AddressBar.tsx` — two address fields and a Route button. No turns, no history, no dialogue.
- **No support corpus.** flattr's data is `data/graph.json` (a routing graph) and OSM/elevation pipeline inputs. There is nothing resembling support articles to retrieve over. (See `03-retrieval-and-rag/README.md`: "flattr has a graph, not a corpus.")
- **No model, no tools, no guardrails.** Nothing in the repo calls an LLM. There is no tool registry, no system prompt, no output filter. The cost function in `features/routing/cost.ts` and A* in `features/routing/astar.ts` are deterministic algorithms, not agents.
- **The single honest thread** — and it's thin: the one place a flattr feature touches *natural language a model could speak* is `features/routing/summary.ts:11` (`routeSummary` → distance / climb / steep-count). A hypothetical *"describe my route"* or *"why did it avoid that hill?"* assistant would start by feeding that summary into a prompt. That is the **embryo of a chatbot's grounding context** — but it is grounding for a *route-explanation* feature, not a *support* feature. There's still no support-doc corpus, no tools, and no dialogue. It's a different product.

Verdict: **out of scope.** flattr is a routing engine. A support chatbot shares none of its subsystems.

## How to make it apply

The honest move is to *not* build a support chatbot — flattr has nothing to support. The only adjacent thing worth naming is the route-explanation assistant, and even that is a different product than this template:

```
Route-explanation assistant (the nearest flattr-shaped thing — NOT a support bot)
features/routing/summary.ts:11  ──▶  prompt("Describe this route: …")  ──▶  LLM  ──▶  text
        (distance, climbM,            (grounding = your own route                "Mostly flat,
         steepCount)                   facts, not a doc corpus)                   one short climb…")
```

- **Seam to start from:** `features/routing/summary.ts:11`. Build a `describeRoute(summary, path)` that serializes route facts into a prompt; call a model; render the prose in `mobile/src/RouteSummaryCard.tsx`. That's grounding-by-your-own-data, closer to *report generation* than to RAG.
- **What's still missing for the actual template:** there is no corpus to retrieve (kills the RAG leg), no actions to take (kills the tool-calling leg), and the only guardrail that matters is the existing injection concern — OSM `display_name` is untrusted (`pipeline/geocode.ts:27,52,69`) and would need escaping before it ever entered a prompt.

So: the *seam* exists, the *product* doesn't. Building a support chatbot here would mean inventing a support domain flattr doesn't have. Don't — but know that `summary.ts:11` is where natural-language generation would first touch this codebase.

## See also

- `02-context-and-prompts/` — system prompts and context construction (the LLM leg of this template)
- `04-agents-and-tool-use/` — tool-calling in isolation (also N/A in flattr)
- `03-retrieval-and-rag/11-rag.md` — the RAG leg; note flattr has a graph, not a corpus
- `01-search-ranking.md` — the other template here; geocode is a real search UI, this is not
- Real seams: output→prompt `features/routing/summary.ts:11`; input→prompt `pipeline/geocode.ts:9`; injection vector `pipeline/geocode.ts:27,52,69`
