# Template — multi-agent research assistant

The closest fit of the three. flattr's "plan a flat afternoon with 3 coffee
stops" feature (`../01-reasoning-patterns/07-routing.md`) is structurally a
research-assistant: decompose → gather from sources → synthesize.

- **The prompt:** "Design a system that answers a complex request by
  gathering from multiple sources and synthesizing." (For flattr: "plan a
  flat multi-stop afternoon.")

- **Standard architecture:** supervisor decomposes the request → parallel
  worker agents each retrieve from a source (agentic RAG per worker) →
  supervisor synthesizes with citations.

```
  ┌─ supervisor: decompose "flat afternoon, 3 cafes" ─────────┐
  └───────┬───────────────┬───────────────┬───────────────────┘
          ▼ (fan-out)     ▼               ▼
   geocode cafe A   geocode cafe B   geocode cafe C   (independent)
          └───────────────┼───────────────┘
                          ▼ (pipeline — order-dependent)
        nearestNode → search legs in order → routeSummary
                          ▼
              supervisor synthesizes → one flat loop + climb summary
```

- **Data model:** source registry (graph + geocoder), per-leg route
  results, a shared findings store keyed by sub-question (which cafe →
  which coord → which leg), provenance (which leg came from which search).

- **Key components:** decomposition (supervisor), parallel geocoding
  (fan-out workers), sequential route legs (pipeline), synthesis (assemble
  the loop). Decision per component: tools-style delegation (flattr's pure
  functions favor it); shared state vs message passing (one planner → shared
  is fine at this scale).

- **Scale concerns:** at many stops, geocode fan-out hits Nominatim's ~1
  req/sec limit (`02-fan-out-backpressure`); at deep "find me a quiet flat
  loop" iteration, cap the loop; the supervisor stays the bottleneck — keep
  it the only expensive call.

- **Eval framing:** trajectory eval (did each leg call `search` with the
  right endpoints?), route validity (every leg connected, total under
  `userMax`), cost/latency per plan — attaches at `bench/`
  (`../04-agent-infrastructure/04-agent-evaluation.md`).

- **Common failure modes:** synthesis of a disconnected route (leg 2 doesn't
  start where leg 1 ended), an all-steep `BLOCKED` leg averaged into the
  plan instead of rejected, cost blowup from re-routing, lost-in-the-middle
  across many legs.

- **Applies to this codebase:** **partially.** flattr has the *tools* (the
  four router functions) and the *eval harness* (`bench/`) but no supervisor,
  no agent loop, no LLM — so the decomposition and synthesis don't exist yet.
  The shape fits; the agent doesn't exist.

- **How to make it apply:** add `features/plan/` with one supervisor
  (ReAct loop, model step) that registers `geocode`/`nearestNode`/`search`/
  `routeSummary` as tools, fans out the geocodes, pipelines the legs, and
  synthesizes the loop. No change to `features/routing/`. Add a circuit
  breaker on `geocode` and a concurrency cap at Nominatim's limit. Extend
  `bench/` with trajectory + route-validity evals. That refactor — and only
  that — lets you defend flattr as this template.
