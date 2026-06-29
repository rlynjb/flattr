# 01 — Reasoning patterns

How one model thinks through a task. flattr has **no model**, so these files
teach the patterns *by contrast* with flattr's deterministic control loop.

Reading order (self-contained, but this order builds):

1. [`01-chains-vs-agents.md`](01-chains-vs-agents.md) — the boundary: is there
   an autonomous loop at all? (flattr: no — engineer owns all control.)
2. [`02-agent-loop-skeleton.md`](02-agent-loop-skeleton.md) — **the
   load-bearing contrast.** `search()` in `astar.ts` IS the agent-loop
   skeleton with code in the decision slot. The budget exit flattr gets free
   is the one agents must engineer.

Not generated (flattr exercises none, and they're covered mechanically in
`study-ai-engineering`): ReAct, plan-and-execute, reflexion, tree-of-thoughts,
model routing. See `../audit.md` for each, with its attachment point.
