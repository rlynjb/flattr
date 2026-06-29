# Agent architecture — overview

## The honest verdict, up front

flattr has **no LLM, no agent, no tool-calling, no multi-agent
orchestration.** There is nothing in this repo that hands a model a set of
tools and lets it decide what to do next. Don't go looking for a ReAct loop
or a supervisor — there isn't one, and this guide will not pretend there is.

So why does flattr get an agent-architecture guide at all? Because it
contains the two things that make this topic *click* when you finally do
build an agent:

1. **A control loop where CODE decides each step.** `search()` in
   `features/routing/astar.ts` is a textbook control loop — pop a frontier,
   expand, decide the next move, repeat until a termination condition. That
   is the *exact same skeleton* as an agent loop. The only difference is who
   fills in the `step` function: in flattr, deterministic code; in an agent,
   a model. Learn the loop here, where it's transparent and testable, and
   the agent loop is a one-line substitution away.

2. **A set of well-typed functions that are already shaped like agent
   tools.** `search()`, `routeSummary()`, `geocode()`, `nearestNode()` —
   each takes typed inputs, returns typed outputs, has no hidden side
   effects, and does one thing. That is the exact contract an LLM agent
   needs from a tool. A future "plan me a flat afternoon with three coffee
   stops" feature would wrap these as tools and let a model orchestrate
   them. The seam is already there; nothing in the router has to change.

This guide teaches agent architecture through those two anchors: the
**control-loop contrast** and the **router-as-tool seam.** Everything else
in the spec's catalog (agentic retrieval, multi-agent topologies, agent
memory, planning loops) is marked *not yet exercised* with the concrete
attachment point named.

## Where flattr sits on the three shapes

```
  The three agent shapes — where flattr lands

  ┌──────────────────┬───────────────────────────────┬─────────┐
  │ Shape            │ What it exercises             │ flattr? │
  ├──────────────────┼───────────────────────────────┼─────────┤
  │ Workflow / chain │ Engineer writes the steps;    │ ◄── THIS│
  │                  │ no autonomous loop. (flattr   │   (minus│
  │                  │ has a build PIPELINE + a       │   the   │
  │                  │ deterministic search loop)    │   LLM)  │
  ├──────────────────┼───────────────────────────────┼─────────┤
  │ Single-agent     │ One model loop with tools     │   no    │
  │                  │ (ReAct). Model picks tools.   │         │
  ├──────────────────┼───────────────────────────────┼─────────┤
  │ Multi-agent      │ Many agents in a topology.    │   no    │
  └──────────────────┴───────────────────────────────┴─────────┘
```

flattr is a workflow/chain codebase — except even the "chain" part has no
model in it. The build pipeline (`pipeline/run-build.ts`) is a fixed
sequence of pure steps (OSM fetch → split → elevation → grade →
build-graph). The runtime is a single deterministic search call. No slot in
either is filled by an LLM. That makes flattr the *cleanest possible
teaching surface* for the agent loop, because you can see the whole control
flow with no model hiding inside it.

## A note on Rein's portfolio

From `me.md`: the closest thing to agent-adjacent work in the portfolio is
**aipe itself** — this tooling. aipe is "describe → diagnose → act" layering
over markdown prompt templates and slash commands; it's prompt-orchestration
infrastructure, not a shipped autonomous agent. **AdvntrCue** ships
tool-calling and session memory (MemoRAG) — that's the single-agent surface,
and it's covered in `study-ai-engineering`, not here. **No multi-agent system
has shipped.** So SECTION C (multi-agent orchestration) is genuinely new
ground for the reader, and this guide teaches it as new ground — but anchored
to flattr's deterministic loop, which is the part the reader *has* built.

## Reading order

```
  00-overview.md                       ← you are here
  01-reasoning-patterns/
    01-chains-vs-agents.md             ← the boundary: written steps vs a loop
    02-agent-loop-skeleton.md          ← THE CONTRAST: search() IS the loop
  03-multi-agent-orchestration/
    01-when-not-to-go-multi-agent.md   ← the escalation gate (flattr: don't)
  06-orchestration-system-design-templates/
    01-multi-agent-research-assistant.md
    02-agentic-support-system.md
    03-agentic-coding-system.md
  agent-patterns-in-this-codebase.md   ← THE SEAM: router-as-tool, mapped
  audit.md                             ← every spec lens, honestly marked
```

Start with `01-chains-vs-agents.md` (where flattr's loop sits relative to a
real agent), then `02-agent-loop-skeleton.md` (the load-bearing contrast),
then `agent-patterns-in-this-codebase.md` (the tool seam, concretely mapped).

## Cross-links to sibling guides

- Deterministic A* search mechanics (the loop's internals): `study-dsa-foundations`
- The router as a system boundary, request flow: `study-system-design`
- Tool-calling / single-agent mechanics (the model side of the seam): `study-ai-engineering`
- Prompt-orchestration as agent-adjacent (aipe shape): `study-prompt-engineering`
- The pipeline as a fixed-order build chain: `study-runtime-systems`
