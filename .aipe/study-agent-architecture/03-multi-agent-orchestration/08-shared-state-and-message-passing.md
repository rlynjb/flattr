# Shared state and message passing

**Industry names:** blackboard vs message passing · shared context vs
scoped context. **Type:** Industry standard. **In this codebase: Not yet
implemented** (no multi-agent communication).

> How agents communicate. Two models, one tradeoff. flattr's `g`/`came`
> maps are a single-loop blackboard — the degenerate one-actor case.

---

## Zoom out, then zoom in

**Zoom out — the two models (Move 1 shape):**

```
  Shared state (blackboard):       Message passing:
  ┌──────────────────────┐        agent A ──msg──► agent B
  │   shared context     │        agent B ──msg──► agent C
  │  (all agents read     │        (each agent sees only
  │   and write here)     │         what's passed to it)
  └──────────────────────┘
   ▲      ▲       ▲
   A      B       C
```

**Zoom in.** Shared state (blackboard): every agent reads and writes one
context. Message passing: each agent sees only what's handed to it. The
tradeoff: blackboard is simple but every agent sees everything (context
bloat, lost-in-the-middle scaling with agent count); message passing is
scoped (cheaper, less noise) but you must decide what to pass.

---

## How it works

### Move 1 — the mental model

flattr's search has a blackboard — `g`, `came`, `closed`, `open`
(`astar.ts:30-33`) — that the loop reads and writes throughout. With one
actor (the loop), there's no bloat problem: there's no second reader to
overwhelm. The blackboard's cost only shows up at *multiple* agents.

### Move 2 — why the tradeoff bites at N agents

```
  blackboard cost scales with reader count

  flattr (1 actor):   g/came/closed shared, no contention, no bloat
  multi-agent:        N agents all read the blackboard → each one's
                      context fills with the others' writes →
                      lost-in-the-middle, token cost ↑ with N
```

The production answer is message passing / context routing: pass each
agent role-specific context, not the whole board. That's a direct
application of context engineering
(`../04-agent-infrastructure/01-context-engineering.md`). The risk it adds:
a bug in *what you pass* means an agent acts on missing information — the
blackboard never has that bug (everyone sees everything).

### Move 3 — the principle

Shared state is simple but doesn't scale past a few agents (context bloat);
message passing scopes context (cheaper) but you own deciding what to pass.
flattr's single-loop blackboard is the case where shared state is free —
one actor, no contention — which is exactly why the tradeoff only appears
once you add agents.

---

## Interview defense

**Q: Shared state or message passing for multi-agent?**

Shared state is simplest but every agent sees everything — context bloat
and lost-in-the-middle that scales with agent count. Message passing
scopes each agent's context but adds a "did I pass the right thing?" bug.
flattr's loop has a blackboard (`g`/`came`/`closed`) with *one* actor, so
no bloat — which is the tell: shared state is free at one actor and costs
you at N. Production routes role-specific context per agent.

Anchor: *"flattr's `g`/`came`/`closed` is a one-actor blackboard with no
bloat — shared state's cost is purely a function of reader count, which is
why message passing wins at N agents."*

---

## See also

- `02-supervisor-worker.md` · `07-graph-orchestration.md` ·
  `09-coordination-failure-modes.md`
- `../04-agent-infrastructure/01-context-engineering.md` (context routing)
