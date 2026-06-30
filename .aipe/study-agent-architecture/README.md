# study-agent-architecture — index

Agent architecture, studied against flattr. flattr has **no LLM agent** —
this guide teaches the agent loop by contrasting it with flattr's
deterministic A* control loop, and names the one concrete seam where
flattr would grow a real agent (the "plan a flat afternoon" feature
wrapping the existing router functions as tools).

Start with `00-overview.md` for the verdict and the two anchors
(CONTRAST + SEAM).

## Files

```
  00-overview.md                       verdict, shape, the two anchors
  README.md                            this index
  agent-patterns-in-this-codebase.md   the honest per-repo audit

  01-reasoning-patterns/               A — how one model thinks
    01-chains-vs-agents.md             pipeline = chain; router = loop
    02-agent-loop-skeleton.md          ★ THE CONTRAST — astar.ts:48
    03-react.md                        baseline pattern (not exercised)
    04-plan-and-execute.md             (not exercised)
    05-reflexion-self-critique.md      (not exercised)
    06-tree-of-thoughts.md             (not exercised)
    07-routing.md                      ★ THE SEAM front-door (not exercised)

  02-agentic-retrieval/                B — retrieval as a control loop
    01-agentic-rag.md                  (not exercised — no LLM, no docs)
    02-self-corrective-rag.md          (not exercised)
    03-retrieval-routing.md            (not exercised)

  03-multi-agent-orchestration/        C — above one agent (new ground)
    01-when-not-to-go-multi-agent.md   the gate (always generated)
    02-supervisor-worker.md            (not exercised)
    03-sequential-pipeline.md          flattr's pipeline/ is the no-LLM cousin
    04-parallel-fan-out.md             (not exercised)
    05-debate-verifier-critic.md       (not exercised)
    06-swarm-handoff.md                (not exercised)
    07-graph-orchestration.md          (not exercised)
    08-shared-state-and-message-passing.md  (not exercised)
    09-coordination-failure-modes.md   (not exercised)

  04-agent-infrastructure/             D — cross-cutting disciplines
    01-context-engineering.md          (not exercised)
    02-agent-memory-tiers.md           (not exercised)
    03-tool-calling-and-mcp.md         ★ the router functions as tools
    04-agent-evaluation.md             ★ attachment point: bench/
    05-guardrails-and-control.md       budget exit lives here

  05-production-serving/               E — serving a loop / topology
    01-cross-turn-caching.md           (not exercised)
    02-fan-out-backpressure.md         (not exercised)
    03-per-tool-circuit-breaking.md    ★ geocode() = the breaker boundary

  06-orchestration-system-design-templates/  F — interview templates
    01-multi-agent-research-assistant.md
    02-agentic-support-system.md
    03-agentic-coding-system.md
```

★ = grounded in flattr's real code (the rest is study material with the
attachment point named).

## Recommended order

A → B → C → D → E → F, but for this repo specifically:

1. `00-overview.md`
2. `01-reasoning-patterns/02-agent-loop-skeleton.md` — the contrast that
   makes the whole topic click against code you can read.
3. `agent-patterns-in-this-codebase.md` — what flattr actually is.
4. `01-reasoning-patterns/07-routing.md` + `04-agent-infrastructure/03-tool-calling-and-mcp.md`
   — the seam: the "plan an afternoon" feature.
5. `05-production-serving/03-per-tool-circuit-breaking.md` — the one
   side-effect tool.
6. Everything else as study material.

## Cross-links to sibling guides

- `study-dsa-foundations` — A*, priority queue, the closed set: the
  search internals this guide treats as one "step."
- `study-runtime-systems` — the loop as an execution model; bounded work.
- `study-system-design` — the pipeline build chain, the static-artifact
  data flow.
- `study-software-design` — `search()` as a deep module / clean tool seam.
- `study-ai-engineering` — single-agent mechanics (ReAct, tool calling,
  RAG) this guide cross-references rather than re-teaches.
- `study-prompt-engineering` — the step-function prompt, if flattr grew one.
- `study-networking` — Nominatim/Overpass HTTP, the geocode failure path.
- `study-performance-engineering` — `bench/`, where trajectory evals attach.
- `study-testing` — `bench/` and the `*.test.ts` suite as the eval seam.
- siblings also: `database-systems`, `data-modeling`, `security`,
  `distributed-systems`, `debugging-observability`, `frontend-engineering`.
