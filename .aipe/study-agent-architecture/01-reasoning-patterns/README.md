# 01 — Reasoning patterns

**Anchor:** single-agent (primary) · workflow (secondary).

How one decider thinks through a task. This is the substrate every
multi-agent topology sits on. **The load-bearing file of the whole guide
lives here:** `02-agent-loop-skeleton.md`, which teaches the agent loop by
contrasting it with flattr's deterministic A* control loop (`astar.ts`).

## Reading order

1. `01-chains-vs-agents.md` — is there an autonomous loop at all?
   (flattr: no — `pipeline/` is a chain, the router is a code-decides loop)
2. `02-agent-loop-skeleton.md` — ★ THE CONTRAST. The four-part kernel
   (state · step · execute · terminate) walked line-for-line against
   `astar.ts:30-77`. The budget exit is the lesson — flattr gets it free.
3. `03-react.md` — the default step-slot fill (not exercised; placement only)
4. `04-plan-and-execute.md` — plan once, execute cheap (not exercised)
5. `05-reflexion-self-critique.md` — critic loop (flattr's `steepCount` is
   the deterministic analogue)
6. `06-tree-of-thoughts.md` — scored branching (flattr's A* IS this, cheaply)
7. `07-routing.md` — ★ THE SEAM. Where flattr grows an agent: the four
   router functions as pre-cut tools.

## What's grounded here

`02`, `01`, `07` are anchored in flattr's real code. `03`–`06` are study
material — each names its flattr analogue (where one exists) and the
attachment point. None re-teaches mechanics covered in
`study-ai-engineering`; those are cross-referenced.
