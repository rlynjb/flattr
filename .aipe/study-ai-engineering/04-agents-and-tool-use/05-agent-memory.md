# Agent Memory
### Short-term in context, long-term retrieved (orchestration / study material)

## Zoom out

```
TWO MEMORIES, TWO TIME-SCALES
┌──────────────────────────────────────────────────────────┐
│  SHORT-TERM   lives in the context window this turn        │
│     recent messages, tool results, scratchpad             │
│     vanishes when the window closes                       │
├──────────────────────────────────────────────────────────┤
│  LONG-TERM    lives OUTSIDE the model, fetched on demand   │
│     vector store / KV / DB ──retrieve──▶ inject into ctx  │
│     survives across turns and sessions                    │
├──────────────────────────────────────────────────────────┤
│  flattr       STATELESS per route — no agent memory at all │
│     only AsyncStorage holds a user pref (userMax)         │
└──────────────────────────────────────────────────────────┘
```

Agent memory splits by time-scale: **short-term** is whatever fits in the context
window right now; **long-term** is everything persisted elsewhere and pulled back in
when relevant (you built this in MemoRAG). flattr has neither — each route compute is
a pure function of its inputs. Its only persistence is a mobile user preference, which
is config, not memory.

## How it works

### Move 1 — the mental model: RAM vs disk

```
SHORT-TERM ≈ RAM     fast, small, wiped on exit
LONG-TERM  ≈ disk    slow, large, retrieved by relevance
the agent's skill = deciding WHAT to promote disk→RAM each turn
```

Fast read: short-term is free but tiny and forgetful; long-term is durable but you
must *retrieve* the right slice (that's the RAG part). An agent's memory quality is
mostly its retrieval quality.

### Move 2 — flattr's actual state, step by step

```
flattr STATE — none of it is agent memory
┌──────────────────────────────────────────────────────────┐
│ route compute:  pure(graph, start, goal, userMax) ─▶ Path │
│                 same inputs ⇒ same output, every time      │
├──────────────────────────────────────────────────────────┤
│ the ONLY persistence:                                     │
│   AsyncStorage on mobile ─▶ userMax (max grade pref)      │
│   a single config value, not a history or a memory store  │
└──────────────────────────────────────────────────────────┘
```

Step by step: a route request carries everything it needs. Nothing from a previous
request influences the next — no conversation, no scratchpad, no retrieved
documents. `userMax` is read from AsyncStorage as an *input parameter*, the way an
app reads a settings toggle. It's not memory the system reasons over.

### Move 3 — the principle

Statelessness is a feature when it's available: it makes behavior reproducible,
testable, and trivially cacheable. Add memory only when the task genuinely needs
information that isn't in the current request — and when you do, the hard part is
retrieval, not storage. flattr needs none, so it stays pure.

## In this codebase

**NOT YET EXERCISED.** flattr has no agent and therefore no agent memory — no
short-term scratchpad, no long-term store, no retrieval. Each route compute is
stateless: identical inputs always yield identical paths.

The lone persistence is `userMax` in mobile AsyncStorage — a single user preference
threaded into `cost()`/`routeSummary` as a parameter, not a memory the system
recalls or reasons about. If an agent ever existed here, *that* preference plus past
routes could become long-term memory — but nothing retrieves or reasons over history
today. No attach point; flattr is a deterministic, stateless pipeline.

## See also
- `02-tool-calling.md` — tool results are what short-term memory holds
- `06-error-recovery.md` — retries depend on remembering prior attempts
- `../05-rag/` — long-term memory is retrieval; see the RAG section
