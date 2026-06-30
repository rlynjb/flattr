# Agent patterns in flattr

> The honest per-repo audit. Read `00-overview.md` first for the framing.

## The headline

**flattr does not currently use any autonomous agent loop.** There is no
LLM in the codebase, no tool-calling, no ReAct, no multi-agent topology. The
patterns in this guide are covered as study material; the system-design
templates in `06-orchestration-system-design-templates/` identify the
topologies flattr *could* adopt and the refactor each would require.

What flattr *does* have is the deterministic skeleton an agent loop is built
on, plus four functions already shaped like agent tools. That's the value of
this guide: contrast and seam, not a description of agents flattr runs.

## The agent patterns table

flattr's features mapped to the *nearest* pattern — with the honest caveat
that none use a model:

```
  ┌────────────────────┬──────────────────────┬───────────────────────────┐
  │ Feature            │ Nearest pattern      │ Why / the honest caveat   │
  ├────────────────────┼──────────────────────┼───────────────────────────┤
  │ features/routing/  │ agent-loop SKELETON  │ same kernel (state·step·  │
  │ astar.ts search()  │ (deterministic)      │ execute·terminate) — but  │
  │                    │                      │ CODE fills step (g+h),    │
  │                    │                      │ not a model. astar.ts:48  │
  ├────────────────────┼──────────────────────┼───────────────────────────┤
  │ pipeline/          │ sequential PIPELINE  │ fixed chain of pure stages│
  │ run-build.ts       │ (no LLM)             │ osm→elev→split→grade→graph│
  ├────────────────────┼──────────────────────┼───────────────────────────┤
  │ summarizePath /    │ verifier / CRITIC    │ grades route vs userMax   │
  │ steepEdges         │ (deterministic rule) │ (steepCount) — reports,   │
  │                    │                      │ doesn't loop. astar.ts:126│
  ├────────────────────┼──────────────────────┼───────────────────────────┤
  │ MapScreen.tsx flow │ ROUTING (hand-coded) │ geocode→nearestNode→search│
  │                    │                      │ — fixed order, no model   │
  ├────────────────────┼──────────────────────┼───────────────────────────┤
  │ bench/run.ts       │ trajectory EVAL      │ stage comparison on       │
  │                    │ (deterministic)      │ pushes/pops/nodesExpanded │
  └────────────────────┴──────────────────────┴───────────────────────────┘
```

None of these is an agent. Each is the deterministic cousin of an agent
pattern — which is exactly why flattr teaches the contrast so cleanly.

## The one control loop, with its envelope

flattr's `search()` (`astar.ts:22`) is a real control loop. Its structure:

```
  ┌─ control loop: features/routing/astar.ts ──────────────────┐
  │  STATE      open · g · came · closed         (:30-33)       │
  │  STEP       g + costFn + heuristicFn          (:68-72)       │
  │             ↑ CODE decides — a model would fill this slot   │
  │  EXECUTE    expand adjacency                  (:64-67)       │
  │  TERMINATE  success: current === goal         (:52)         │
  │             budget:  open.isEmpty()           (:48,:77)      │
  └─────────────────────────────────────────────────────────────┘

  control envelope (all FREE — structural, not engineered):
    • iteration bound — finite graph + closed set → guaranteed halt
    • no cost ceiling needed — deterministic, µs per step, no tokens
    • no guardrails needed — no model, no untrusted output in the loop
```

The lesson the envelope teaches: every control an *agent* loop must add by
hand (iteration cap, cost ceiling, output guardrail) flattr gets for free
because there's no model — the loop is finite, deterministic, and trusted.

## The shape verdict

```
  Workflow / chain ── flattr is closest to this, but WITHOUT an LLM.
                      pipeline/ is a pure chain; the router is a
                      code-decides loop. Not the workflow-with-LLM shape
                      the spec names — there's no LLM.

  Single-agent ────── NOT present. (Would arrive via the "plan an
                      afternoon" feature — 07-routing.md + template 01.)

  Multi-agent ─────── NOT present, and not justified.
                      (Two steps away — see 03/01-when-not-to-go-multi-agent.)
```

## If flattr grew an agent — the one seam

The single concrete path to a real agent (detailed in
`01-reasoning-patterns/07-routing.md` and template 01): a new
`features/plan/` module with one ReAct loop, registering the four existing
functions as tools, for a "plan a flat afternoon with 3 coffee stops"
feature. Crucially, **`features/routing/` doesn't change** — the router
becomes a tool the agent calls. `geocode` is the one tool needing a circuit
breaker and rate-limit (`05-production-serving/03`); trajectory evals attach
at `bench/` (`04-agent-infrastructure/04`).

## Where to read the grounded contrasts

- The loop contrast: `01-reasoning-patterns/02-agent-loop-skeleton.md`
- The chain vs loop: `01-reasoning-patterns/01-chains-vs-agents.md`
- The tool seam: `01-reasoning-patterns/07-routing.md` +
  `04-agent-infrastructure/03-tool-calling-and-mcp.md`
- The breaker boundary: `05-production-serving/03-per-tool-circuit-breaking.md`
- The eval attachment: `04-agent-infrastructure/04-agent-evaluation.md`
