# ReAct — the baseline single-agent pattern

**Industry names:** ReAct (Reason + Act) · Thought-Action-Observation loop.
**Type:** Industry standard. **In this codebase: Not yet implemented** —
flattr has no LLM loop; the seam where ReAct would live is `07-routing.md`.

> This file is *placement*, not mechanics. The Thought-Action-Observation
> mechanics are in `study-ai-engineering`'s ReAct file. Here: where ReAct
> sits in the pattern family, and why it's the default you start from.

---

## Zoom out, then zoom in

**Zoom out.** ReAct is the default fill for the step slot in
`02-agent-loop-skeleton.md` — the most common way a model decides the
next action.

```
  Zoom out — ReAct is one fill for the loop's step slot

  ┌─ the agent loop (02-agent-loop-skeleton.md) ───────────────┐
  │  state → ★ STEP ★ → execute → terminate                    │
  │            │                                                │
  │            └─ ReAct fills it: Thought → Action → Observation│ ← here
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in.** ReAct interleaves a reasoning trace with tool calls: the
model writes a *thought*, picks an *action* (tool call), reads the
*observation* (result), and loops. It's the baseline because it's simple,
debuggable, and good enough for most tasks. The escalation rule: **start
here, measure, escalate only on a specific failure.**

---

## How it works

### Move 1 — the mental model

If flattr grew the "plan a flat afternoon" feature (`07-routing.md`),
ReAct is the loop you'd reach for first. The step is a model call that
emits one tool invocation among flattr's four functions.

```
  ReAct — the Thought→Action→Observation loop

  ┌─────────────────────────────────────────────────┐
  │ Thought:  "I need coords for 3 coffee shops"    │
  │ Action:   geocode("coffee near me")              │ ← tool call
  │ Observation: {lat, lng, label}                   │ ← result back
  │ → loop (next thought) or stop (final route)      │
  └─────────────────────────────────────────────────┘
```

### Move 2 — placement (the escalation ladder)

The mechanics are cross-referenced. The agent-architecture-specific point
is *when to use it* — and the strong prior is to start here:

```
  Default to ReAct.
    │
    ├─ measure: success rate, tool-call accuracy, latency, cost
    │
    └─ escalate ONLY when a specific failure ReAct can't fix appears
         ↓                    ↓                    ↓
   structured task?      self-checkable?      decomposable into
   → plan-and-execute    → reflexion           specialties?
   (04)                  (05)                  → multi-agent (C)
```

flattr would attach a ReAct loop in a new `features/plan/` module, with
the four router functions as tools. Evals would attach in `bench/`
(trajectory comparison — see `../04-agent-infrastructure/04-agent-evaluation.md`).

### Move 3 — the principle

Most teams jump past ReAct prematurely. The senior answer is "I built a
ReAct baseline, measured it, and escalated only when [specific failure]" —
not "I reached for multi-agent." flattr's discipline already models this:
it built Dijkstra → A* → directional → bidirectional as *measured*
escalation (see `bench/`), each stage justified by a metric. Same instinct,
applied to reasoning patterns.

---

## Interview defense

**Q: Why start with ReAct?**

It's the simplest fill for the step slot, it's debuggable (the
thought-action-observation trace is readable), and most tasks don't need
more. I escalate on a *named* failure, not a hunch — the same way flattr's
router progression (Dijkstra→A*→bidirectional) escalated on measured
metrics in `bench/`, not on vibes.

Anchor: *"ReAct is the default step-slot fill; escalate on a measured
failure — flattr's own `bench/`-driven router progression is that
discipline applied to search."*

---

## See also

- `02-agent-loop-skeleton.md` · `04-plan-and-execute.md` ·
  `05-reflexion-self-critique.md` · `07-routing.md`
- Mechanics (cross-ref): `study-ai-engineering`'s
  `04-agents-and-tool-use/03-react-pattern.md`
