# Study — agent architecture (flattr)

**flattr has no LLM, no agent, no tool-calling, no multi-agent
orchestration.** This guide is honest about that. Its value is two things
flattr *does* have:

1. **The control-loop contrast** — `search()` in `features/routing/astar.ts`
   is the agent-loop skeleton with *code* in the decision slot instead of a
   model. Learn the agent loop here, where every step is testable.
2. **The router-as-tool seam** — `search`/`routeSummary`/`geocode`/
   `nearestNode` are already shaped like agent tools. A future planner agent
   wraps them without changing the router.

Everything else (agentic retrieval, multi-agent topologies, agent memory,
planning loops) is marked *not yet exercised* with the attachment point named.

## Reading order

1. [`00-overview.md`](00-overview.md) — the honest frame + where flattr sits
2. [`01-reasoning-patterns/01-chains-vs-agents.md`](01-reasoning-patterns/01-chains-vs-agents.md) — is there a loop at all?
3. [`01-reasoning-patterns/02-agent-loop-skeleton.md`](01-reasoning-patterns/02-agent-loop-skeleton.md) — **the contrast** (code-decides vs model-decides)
4. [`03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`](03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) — the escalation gate
5. [`agent-patterns-in-this-codebase.md`](agent-patterns-in-this-codebase.md) — **the seam** (router-as-tool, mapped)
6. [`06-orchestration-system-design-templates/`](06-orchestration-system-design-templates/) — interview templates
7. [`audit.md`](audit.md) — every spec lens, honestly marked

## File list

```
  00-overview.md
  README.md                            ← you are here
  audit.md                             ← Pass 1: every lens, honest
  agent-patterns-in-this-codebase.md   ← the router-as-tool seam
  01-reasoning-patterns/
    01-chains-vs-agents.md
    02-agent-loop-skeleton.md          ← THE control-loop contrast
  03-multi-agent-orchestration/
    01-when-not-to-go-multi-agent.md
  06-orchestration-system-design-templates/
    01-multi-agent-research-assistant.md   (Applies: no)
    02-agentic-support-system.md           (Applies: partially — the seam)
    03-agentic-coding-system.md            (Applies: no — chain contrast)
```

Note: SECTIONS B (agentic retrieval), D (agent infrastructure), and E
(production serving for agents) generate **no concept files** — flattr matches
none of those shapes at all, so per the spec those patterns are skipped (not
stubbed). They are walked in `audit.md` with attachment points instead.

## Cross-links to sibling guides

- `study-dsa-foundations` — A* search mechanics inside the control loop
- `study-system-design` — router + pipeline as system boundaries
- `study-ai-engineering` — tool-calling / single-agent mechanics (model side)
- `study-prompt-engineering` — aipe as agent-adjacent prompt orchestration
- `study-runtime-systems` — the build pipeline as a fixed-order chain
- `study-testing` — `bench/` as the seam where agent trajectory evals attach
