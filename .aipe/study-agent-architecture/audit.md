# Agent architecture audit — flattr

Every lens from the spec's catalog, walked against flattr's actual code.
flattr has **no LLM, no agent, no tool-calling, no multi-agent
orchestration** — so most lenses are `not yet exercised`, each with the
concrete attachment point named. The two lenses that *do* find something are
the control-loop contrast (the deterministic search loop) and the
router-as-tool seam. Those get cross-links to their deep-dive files; the rest
get one or two honest lines.

---

## SECTION A — Reasoning patterns

### Chains vs agents
**Found (boundary).** flattr is a workflow/chain codebase, and even the chain
has no model in it. Build pipeline = fixed chain of pure transforms; router =
control loop where code (A* rule) decides each step. No model owns any runtime
decision. → see `01-reasoning-patterns/01-chains-vs-agents.md`.

### Agent loop skeleton
**Found (contrast).** `search()` (`features/routing/astar.ts:48`) is a
control loop with the *exact* agent-loop skeleton — state, step, execute, two
terminations — but the step is the A* cost rule, not a model. The cleanest
teaching surface in the repo. → see
`01-reasoning-patterns/02-agent-loop-skeleton.md`.

### ReAct
**Not yet exercised.** No model-driven Thought→Action→Observation loop.
Attachment: the "plan a flat afternoon" feature would wrap router functions as
tools in one ReAct loop. ReAct *mechanics* live in `study-ai-engineering`.

### Plan-and-execute
**Not yet exercised.** No model planning phase. The closest deterministic
analog is the build pipeline (a fixed, engineer-written plan executed in
order) — but no model produces the plan.

### Reflexion / self-critique
**Not yet exercised.** No self-evaluation loop. flattr's honesty mechanism is
deterministic: `steepEdges` flags edges over `userMax` (`astar.ts:126-128`),
and `BLOCKED` stays large-finite so "no flat route" differs from "no route."
That's a correctness flag, not a model critiquing itself.

### Tree of Thoughts
**Not yet exercised.** No branching reasoning. (flattr *does* explore multiple
search frontiers via the priority queue, but that's deterministic A*
expansion, not scored reasoning branches.)

### Routing (reasoning-pattern sense)
**Not yet exercised as model routing.** flattr has no intent router. Note: the
*algorithm* progression (Dijkstra → A* → directional → bidirectional) is
selected by the engineer, not routed at runtime.

---

## SECTION B — Agentic retrieval

### Agentic RAG
**Not yet exercised.** No retrieval loop, no corpus, no embeddings. flattr
reads a single prebuilt `graph.json`; there is nothing to retrieve over.
Attachment: would require a document/knowledge store that does not exist.

### Self-corrective RAG
**Not yet exercised.** No retrieval, so no relevance grader.

### Retrieval routing
**Not yet exercised.** Single read-only data source (`graph.json`). No
multi-source routing. `geocode()` hits Nominatim, but that's a build/runtime
lookup, not retrieval into a model's context.

---

## SECTION C — Multi-agent orchestration

### When NOT to go multi-agent
**Found (the gate).** flattr is two rungs below the first agent. The gate
matters as transferable discipline; `bench/` is where trajectory evals would
attach. → see `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`.

### Supervisor-worker
**Not yet exercised.** No agents to supervise. Attachment: a planner agent
calling router tools would be single-agent, not supervisor-worker.

### Sequential pipeline (of agents)
**Not yet exercised.** flattr *has* a sequential pipeline
(`pipeline/run-build.ts`), but its stages are pure functions, not agents.

### Parallel fan-out
**Not yet exercised** as agents. Note: `bench/` could run search stages
concurrently, but those are deterministic calls, not fan-out agents.

### Debate / verifier-critic
**Not yet exercised.** No producer/critic agents.

### Swarm / handoff
**Not yet exercised.** No peer agents, so no handoff.

### Graph orchestration
**Not yet exercised** as agent orchestration. flattr's graph is a *data*
structure (the street graph), not an orchestration state machine.

### Shared state / message passing
**Not yet exercised.** No agents communicating. The search loop's shared state
(`open`/`g`/`came`/`closed`) is single-loop state, not inter-agent state.

### Coordination failure modes
**Not yet exercised — cannot occur.** Infinite handoff, tool-call cascade,
context bloat, synthesis failure, cost blowup are all multi-agent failures;
flattr has no agents. The deterministic analogs are bounded by construction
(finite graph + `closed` set guarantee termination).

---

## SECTION D — Agent infrastructure

### Context engineering
**Not yet exercised.** No model, no context window to curate.

### Agent memory tiers
**Not yet exercised.** No persistence — `graph.json` is read-only and there's
no session/episodic/long-term store. Attachment: would need a new storage
layer.

### Tool calling and MCP
**Not yet exercised as tool-calling**, but the tool *substrate* exists. The
router functions (`search`, `routeSummary`, `geocode`, `nearestNode`) are
already well-typed, single-purpose, mostly-pure — exactly the contract a tool
schema describes. → see `agent-patterns-in-this-codebase.md` (the seam).

### Agent evaluation
**Not yet exercised** for agents. flattr's `bench/` (`bench/run.ts`,
`bench/report.ts`) evaluates *algorithm* performance (nodes expanded, heap
pushes/pops per stage). That's the seam where trajectory/tool-call evals would
attach.

### Guardrails and control
**Not yet exercised as agent guardrails.** flattr's deterministic guards: A*
admissibility invariant, `penalty ≥ 0`, `BLOCKED` large-finite sentinel,
`PQueue` NaN-priority rejection (`pqueue.ts:24`). These bound the *search*;
the agent control envelope (iteration cap, cost budget, human gate) doesn't
apply because there's no autonomous loop.

---

## SECTION E — Production serving for agents

### Cross-turn caching
**Not yet exercised.** No agent turns. (No request-level caching either; the
graph is loaded once.)

### Fan-out backpressure
**Not yet exercised.** No concurrent agent calls. The one network call
(`geocode` → Nominatim) is rate-limited by policy (~1 req/sec, User-Agent
required) but that's an external-API courtesy, not agent backpressure.

### Per-tool circuit breaking
**Not yet exercised.** No tool loop. Attachment: if an agent called `geocode`
(the one network tool) in a loop, it would need a per-tool breaker — flattr's
`geocode` already throws on non-OK status (`geocode.ts:24`), which is the
failure signal a breaker would consume.

---

## Summary verdict

flattr exercises **zero** agent patterns. It is a deterministic
workflow/chain codebase with no LLM anywhere. Its value for studying agent
architecture is entirely *by contrast and by seam*:

- the **control loop** in `astar.ts` is the agent-loop skeleton with code in
  the decision slot — the budget exit it gets for free is the one agents must
  engineer;
- the **router functions** are pre-cut agent tools — well-typed, pure,
  single-purpose — so a future planner agent wraps them without changing the
  router.

Everything else is teaching material, marked above with its attachment point.
