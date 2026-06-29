# Template — multi-agent research assistant

Generic interview template (nine-bullet shape). The standard-architecture
bullets are generic; the last two bullets are answered about flattr only.

- **The prompt:** "Design a system that answers a complex research question
  by gathering from multiple sources and synthesizing."

- **Standard architecture:** supervisor decomposes the question → parallel
  worker agents each retrieve from a source (agentic RAG per worker) →
  supervisor synthesizes with citations.

```
  ┌──────── supervisor (decompose) ────────┐
  ▼              ▼              ▼
  worker 1       worker 2       worker 3       (parallel, agentic RAG each)
  source A       source B       source C
  └──────────────┼──────────────┘
                 ▼
         supervisor synthesizes → cited answer
```

- **Data model:** source registry, per-worker retrieval indices, a shared
  findings store keyed by sub-question, citation provenance.

- **Key components:** decomposition (supervisor), parallel retrieval
  (workers, fan-out), synthesis (merge agent), citation tracking. Decision
  per component: tools-style vs handoff-style delegation; shared state vs
  message passing.

- **Scale concerns:** at many sources, fan-out cost; at deep questions,
  iteration blowup (cap it); at high volume, the supervisor becomes the
  bottleneck (cheap workers, expensive supervisor only).

- **Eval framing:** trajectory eval (did each worker hit the right source?),
  answer groundedness (every claim cites a retrieved chunk), cost/latency per
  question.

- **Common failure modes:** synthesis of contradictory sources, citation
  hallucination, cost blowup from deep loops, lost-in-the-middle across many
  worker results.

- **Applies to this codebase:** **No.** flattr has one read-only data source
  (`graph.json`), no corpus to research, no model, and no decomposable
  research question. This template is the furthest from flattr's shape — it's
  a multi-agent retrieval system; flattr is a deterministic single-source
  router.

- **How to make it apply:** This would be a different product, not a refactor.
  You'd need (1) a knowledge corpus about routes/neighborhoods/POIs with
  embeddings, (2) multiple sources to route between (the street graph + a POI
  store + live data like weather or closures), and (3) a question genuinely
  needing decomposition ("find me the three flattest scenic loops in
  Capitol Hill under 5km with coffee near the midpoint"). Only then does the
  supervisor-worker fan-out earn its 2-5x overhead — and even then, measure a
  single-agent baseline first (see
  `../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`).

## See also
- `../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`
- `02-agentic-support-system.md` — the closer template for flattr's seam
