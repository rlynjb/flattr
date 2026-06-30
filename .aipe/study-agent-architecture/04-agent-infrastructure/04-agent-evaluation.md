# Agent evaluation

**Industry names:** trajectory eval · agent eval · tool-call accuracy.
**Type:** Industry standard. **In this codebase:** agent evals are **Not
yet implemented** (no agent) — but the *attachment point is real and
specific*: `bench/` is already a trajectory-comparison harness.

> Evaluating an agent is harder than evaluating one call, because the unit
> is the *trajectory*, not the final output. flattr's `bench/` already
> evaluates trajectories — of a deterministic search — which is precisely
> where agent trajectory evals would attach.

---

## Zoom out, then zoom in

**Zoom out.**

```
  LLM eval (one call):       Agent eval (a trajectory):
  ┌──────────────┐           ┌──────────────────────────┐
  │ input        │           │ was the right tool called?│
  │ → output     │           │ in the right order?       │
  │ → score      │           │ did it recover from errors│
  └──────────────┘           │ how many steps / $ / ms?  │
                             │ was the final output good?│
                             └──────────────────────────┘
```

**Zoom in.** Agent eval scores the *path*, not just the destination: right
tool, right order, error recovery, step/cost/latency efficiency, plus final
quality. The metrics: task success rate, tool-call accuracy, trajectory
efficiency, recovery rate.

---

## How it works

### Move 1 — the mental model

flattr's `bench/` already does trajectory evaluation — for the
deterministic router. `bench/run.ts` runs each search stage (Dijkstra → A*
→ gradeAstar → directedAstar → bidirectional) over fixed start/goal pairs
and compares them on `nodesExpanded`, `pushes`, `pops` (the metrics tracked
in `astar.ts:35-37`).

```
  bench/ — trajectory eval of a deterministic agent (already shipped)

  fixed (start, goal) pairs           ← the "golden tasks"
       │
       ▼
  run each stage → SearchResult       ← the "trajectory"
       │            { nodesExpanded, pushes, pops, path }
       ▼
  formatTable (report.ts)             ← compare trajectories across stages
```

`nodesExpanded`/`pushes`/`pops` are *trajectory efficiency* metrics —
"how much work to reach the goal" — exactly the agent metric "how many
steps / $ / ms to completion."

### Move 2 — what attaches here for an agent

An agent eval would extend `bench/` with three things it doesn't track yet,
because flattr's deterministic loop doesn't need them:

```
  bench/ today (deterministic)     agent eval adds
  ────────────────────────────     ───────────────
  nodesExpanded/pushes/pops        tool-call ACCURACY (right tool? right
  (trajectory efficiency ✓)        args? right order?)
  path correctness (exact)         task SUCCESS rate (fuzzy — did it
                                   actually answer?)
  (no failures — deterministic)    RECOVERY rate (handled a failed
                                   geocode/tool?)
```

The evaluator paradox — using an LLM to grade an LLM's trajectory — is the
new risk; the controls are **frozen golden trajectories** (which `bench/`
already has, as fixed pairs), iteration caps, and human spot-checks.
flattr's fixed-pair golden set is the half of agent eval that's already
built.

### Move 3 — the principle

Agent eval scores the trajectory, not just the output — and flattr's
`bench/` is the trajectory-eval harness already, measuring work-to-goal on
a deterministic loop. The agent version adds tool-call accuracy, fuzzy task
success, and recovery rate, with frozen golden trajectories as the control
— a discipline `bench/`'s fixed pairs already model.

---

## Interview defense

**Q: How would you eval an agent built on flattr, and what's already there?**

The unit is the trajectory, not the output — tool-call accuracy, order,
recovery, steps/cost, plus final quality. flattr's `bench/` is already half
of that: it runs fixed (start,goal) golden pairs through each search stage
and compares `nodesExpanded`/`pushes`/`pops` — trajectory efficiency. The
agent eval extends `bench/` with tool-call accuracy and recovery rate, and
keeps the frozen-golden-trajectory control that `bench/`'s fixed pairs
already give.

Anchor: *"flattr's `bench/` already evaluates trajectories — fixed golden
pairs, work-to-goal metrics — so agent evals attach there, adding tool-call
accuracy and recovery."*

---

## See also

- `../01-reasoning-patterns/02-agent-loop-skeleton.md` (the metrics:
  pushes/pops as trajectory)
- `05-guardrails-and-control.md`
- Sibling guides `study-performance-engineering`, `study-testing` —
  `bench/` and the eval seam.
- Mechanics (cross-ref): `study-ai-engineering`'s evals sub-section
  (output-quality eval, LLM-as-judge bias)
