# Plan-and-execute

**Industry names:** plan-and-execute · planner-executor. **Type:** Industry
standard. **In this codebase: Not yet implemented** (no LLM loop).

> Separate planning from doing. An expensive model builds the full plan
> once; cheap models run each step. flattr's static `pipeline/` is a
> *pre-planned* chain — a fixed plan with no planner — which is the
> degenerate case that makes the contrast crisp.

---

## Zoom out, then zoom in

**Zoom out.**

```
  Zoom out — plan-and-execute splits one loop into two phases

  ┌─ Plan phase (expensive model, once) ──────────────────────┐
  │  build the full step list + dependencies                  │
  └──────────────────────────┬─────────────────────────────────┘
                  plan: [step1, step2, step3]
                             ▼
  ┌─ Execute phase (cheap model, per step) ───────────────────┐
  │  run each step; no re-planning per step                   │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** ReAct re-decides the whole approach every loop. Plan-and-
execute decides the strategy *once* (one expensive call) and grinds
through it (many cheap calls). Better on structured tasks where the path
is predictable; brittle when an assumption breaks mid-execution.

---

## How it works

### Move 1 — the mental model

flattr's build pipeline is the *static* version of this: `run-build.ts`
is a fixed plan (`osm→elevation→split→grade→graph`) with no planner —
the engineer was the planner, at code-time. Plan-and-execute moves the
planner to runtime and lets a model write the plan.

```
  flattr pipeline (static plan)      plan-and-execute (dynamic plan)
  ────────────────────────────       ──────────────────────────────
  engineer wrote the steps           model writes the steps at runtime
  no re-plan ever                    re-plan trigger when execution
                                     diverges from the plan
```

### Move 2 — the split, and where flattr would attach it

For "plan a flat afternoon," a planner call would emit:
`[geocode 3 cafes, snap each, search legs between them, summarize]` — then
cheap executors run each leg by calling flattr's `search()`. The tradeoff
is brittleness: if `search()` returns "no flat route" (a `BLOCKED`
all-steep path, per the project's large-finite convention), the plan has
no branch for it. **Mitigation: a re-plan trigger** when a step fails —
exactly the branch flattr's static pipeline lacks (it just propagates the
failure).

```
  Plan phase → [step list] → Execute each → step fails?
                                              ├─ no  → next step
                                              └─ yes → RE-PLAN (cap re-plans)
```

### Move 3 — the principle

Decouple strategy (one expensive call) from grunt work (many cheap
calls), and don't re-decide the whole approach every loop. Pick
plan-and-execute for structured tasks (the path is knowable);
pick ReAct for exploratory ones (the path isn't).

---

## Interview defense

**Q: ReAct or plan-and-execute for the flat-afternoon planner?**

Plan-and-execute — the task is structured (geocode → snap → search legs →
summarize), so I plan once with an expensive model and run legs with a
cheap one, instead of re-deciding the strategy each loop. The risk is a
leg with no flat route; I'd add a re-plan trigger — the branch flattr's
static `pipeline/` deliberately omits because its plan is fixed.

Anchor: *"flattr's `run-build.ts` is a static plan with no planner;
plan-and-execute is that chain with a model writing the plan at runtime
and a re-plan branch on failure."*

---

## See also

- `03-react.md` · `05-reflexion-self-critique.md` ·
  `../03-multi-agent-orchestration/03-sequential-pipeline.md`
- `../06-orchestration-system-design-templates/03-agentic-coding-system.md`
