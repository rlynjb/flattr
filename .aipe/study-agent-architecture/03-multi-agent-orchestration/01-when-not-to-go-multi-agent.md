# When NOT to go multi-agent

**Industry names:** the single-agent-first rule · multi-agent escalation
gate. **Type:** Industry standard (production scar tissue). **In this
codebase:** flattr is two steps below this gate — no single agent yet.

> The single most important multi-agent decision is whether to be
> multi-agent at all. This file comes first by design. For flattr the
> answer is obvious — but the *gate* is the reusable lesson.

---

## Zoom out, then zoom in

**Zoom out — the escalation gate.**

```
  ┌───────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline      │
  │ 2. Measure: success, tool-call accuracy,      │
  │    latency, cost                              │
  │ 3. Identify the SPECIFIC failure single-agent │
  │    cannot fix                                  │
  │ 4. Is that failure decomposable into          │
  │    independent specialties?                   │
  │       ├─ no  → stay single-agent, fix the      │
  │       │        prompt / tools / retrieval      │
  │       └─ yes → escalate to the SPECIFIC        │
  │                topology that addresses it      │
  └───────────────────────────────────────────────┘
```

**Zoom in.** Crossing this gate costs ~2-5x coordination overhead and a
much larger debugging surface (you now debug the conversation between
agents, not one loop). The quality gain is often modest unless the problem
genuinely splits into specialties.

---

## How it works

### Move 1 — the mental model

flattr sits *below* the gate's first step: it has no agent at all. So the
honest reading isn't "single vs multi-agent" — it's "do you even need an
agent?" (`01-reasoning-patterns/01-chains-vs-agents.md`). The gate still
teaches the discipline: measure, then escalate on a *named* failure.

```
  flattr's position on the ladder

  deterministic router (TODAY)
       │ step 1: would adding a model help? (only the "plan an
       │         afternoon" feature needs it — 07-routing.md)
       ▼
  single agent (one ReAct loop over the existing tools)
       │ step 2: does single-agent hit a ceiling that splits
       │         into specialties? (almost certainly NOT for flattr)
       ▼
  multi-agent (NOT justified — no decomposable failure)
```

### Move 2 — flattr's measurement discipline already models the gate

flattr doesn't have agents, but it *has the escalation discipline* the
gate demands — in `bench/`. The router progression (Dijkstra → A* →
directional → bidirectional) is escalation on *measured* failure: each
stage justified by a metric in `bench/run.ts`, not by reaching for the
fancier thing first. That's exactly the gate's logic — "I escalated only
when the measurement showed a specific need" — applied to search instead
of agents.

### Move 3 — the principle

Multi-agent earns its 2-5x overhead only when the problem genuinely splits
into independent specialties. The senior answer is often "I considered
multi-agent and chose not to, because the failure wasn't decomposable."
flattr can't even get to that sentence yet — it's pre-agent — but its
`bench/`-driven escalation is the same measure-then-escalate instinct the
gate codifies.

---

## Interview defense

**Q: Would flattr benefit from multi-agent?**

No — it's two steps below the gate. It has no agent at all, and the one
feature that would add one ("plan a flat afternoon") is a single ReAct
loop over the existing four tools, not a decomposable-into-specialties
problem. flattr already models the *discipline* the gate wants, though:
its router progression in `bench/` escalated Dijkstra→A*→bidirectional on
measured metrics, not on reaching for the fancier thing first.

Anchor: *"flattr's `bench/`-driven Dijkstra→A*→bidirectional progression
is the escalation gate applied to search — measure, then escalate on a
named failure."*

---

## See also

- `02-supervisor-worker.md` · `09-coordination-failure-modes.md`
- `../01-reasoning-patterns/01-chains-vs-agents.md` (the prior gate: agent
  at all?)
- `../06-orchestration-system-design-templates/` (the refactor toward an agent)
