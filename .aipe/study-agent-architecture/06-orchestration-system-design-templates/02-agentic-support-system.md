# Template — agentic support / task system

Generic interview template (nine-bullet shape). This is the **closest
template to flattr's actual seam** — the "plan a flat afternoon" feature is an
agentic task system over flattr's router tools.

- **The prompt:** "Design an agent that resolves user requests by taking real
  actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools (ReAct)
  → guardrails (input sanitize, action gating, output schema) → human
  escalation on low confidence or gated actions.

```
  input → router → ┌─ ReAct loop ──────────────────┐ → output guardrail
                   │  step = model.decide(state)    │   (schema check)
                   │  tools: search/geocode/summary │
                   │  budget: iteration cap          │
                   │  escalate on low confidence     │
                   └─────────────────────────────────┘
```

- **Data model:** conversation/run history with tool calls and confidence per
  turn, escalation log, tool registry, action audit trail.

- **Key components:** routing, the agent loop, guardrails, escalation gate,
  audit logging. Decision: which actions require human approval (irreversible
  / high-stakes) vs auto-execute.

- **Scale concerns:** tool-call cascade under load, cost per resolved request,
  escalation queue as the human bottleneck.

- **Eval framing:** resolution rate without escalation, tool-call accuracy,
  adversarial set (prompt injection, out-of-scope), action-safety (no
  unauthorized side effects).

- **Common failure modes:** prompt injection in user input, agent taking an
  unsafe action directly, infinite loop on an unsolvable request, hallucinated
  tool results.

- **Applies to this codebase:** **Partially — this is flattr's one real agent
  seam.** flattr has no agent today, but it already has the tool layer this
  template needs: `search()`, `routeSummary()`, `geocode()`, `nearestNode()`
  are well-typed, single-purpose, mostly-pure functions (see
  `../agent-patterns-in-this-codebase.md`). A "plan me a flat afternoon with
  three coffee stops" feature is precisely an agentic task system over those
  tools. flattr's actions are all *read-only* (routing, geocoding) — there's
  no irreversible side effect — which makes the action-safety story unusually
  simple.

- **How to make it apply:** Concrete refactor: (1) add a tool-schema wrapper
  around each of the four router functions (input/output JSON schemas — the
  signatures are already typed, so this is thin); (2) add a ReAct loop in a
  new `features/planner/` module using the skeleton from
  `../01-reasoning-patterns/02-agent-loop-skeleton.md`; (3) the control
  envelope — an explicit iteration cap (the budget exit flattr's `search()`
  gets free but an agent must engineer), a per-tool circuit breaker on
  `geocode` (the one network tool, which already throws on failure at
  `pipeline/geocode.ts:24`), and output-schema validation before returning
  the model's plan. The router itself does not change — that's the payoff of
  the pre-cut tool seam.

## See also
- `../agent-patterns-in-this-codebase.md` — the seam mapped in detail
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop to wrap the tools in
- `01-multi-agent-research-assistant.md` · `03-agentic-coding-system.md`
