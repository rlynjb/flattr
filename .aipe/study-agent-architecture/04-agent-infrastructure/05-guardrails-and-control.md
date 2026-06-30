# Guardrails and control

**Industry names:** the control envelope · agent guardrails. **Type:**
Industry standard. **In this codebase:** the *budget exit* is real (flattr
gets it free); model-facing guardrails are **Not yet implemented** (no model).

> The controls that bound an autonomous loop. flattr's loop is bounded
> *structurally* (finite graph + closed set), which is exactly the guarantee
> a model-driven loop has to engineer. This file carries the budget exit
> from the skeleton into a full control envelope.

---

## Zoom out, then zoom in

**Zoom out — the control points:**

```
  ┌─ Input guardrail (validate / sanitize) ───────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
                             ▼
  ┌─ Agent loop ──────────────────────────────────────────────┐
  │   • iteration cap (max steps)                             │
  │   • token / cost budget (halt at ceiling)                 │
  │   • human-in-the-loop pause (gated actions)               │
  └──────────────────────────┬─────────────────────────────────┘
                             ▼
  ┌─ Output guardrail (schema, safety; never let agent output ┐
  │  trigger side effects directly — go through your code)    │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** An agent without caps loops silently and burns tokens; an
agent whose output triggers side effects directly is a prompt-injection
liability. The envelope is: validate in, cap the loop, gate dangerous
actions, validate out.

---

## How it works

### Move 1 — the mental model

The middle control — the iteration cap — is the budget exit from
`../01-reasoning-patterns/02-agent-loop-skeleton.md`. flattr gets it for
free: the `while (!open.isEmpty())` guard (`astar.ts:48`) plus the `closed`
set (`astar.ts:61`) guarantee the loop halts. A model loop has no such
guarantee, so the cap is mandatory, not optional.

```
  the cap: free in flattr, engineered in an agent

  flattr:  finite graph + closed set → loop MUST halt (astar.ts:48,61)
  agent:   unbounded actions → add max-steps + cost ceiling explicitly
```

### Move 2 — the three controls flattr can't model, walked

flattr has no model, so input/output guardrails and human gates have no
analogue — but they're the controls that matter once a model is in the
loop:

```
  ┌─ input guardrail ───────────────────────────────────────┐
  │ validate/sanitize user intent before the model sees it  │
  │ (prompt-injection defense — cross-ref study-ai-eng)     │
  ├─ iteration/cost cap ────────────────────────────────────┤
  │ the budget exit — flattr's FREE, an agent's engineered  │
  ├─ human-in-the-loop pause ───────────────────────────────┤
  │ gate irreversible/high-stakes actions; graph            │
  │ orchestration (07-graph) makes the pause/resume possible│
  ├─ output guardrail ──────────────────────────────────────┤
  │ NEVER let model output trigger a side effect directly — │
  │ route through your code. flattr's geocode is the only   │
  │ side effect; an agent must not let the model call it     │
  │ unmediated.                                              │
  └──────────────────────────────────────────────────────────┘
```

The output guardrail maps onto flattr's one side effect: `geocode`
(`geocode.ts`). In an agent, the model emits `{tool: geocode, args}` and
*the harness* calls it — the model never holds the network. That's the same
proposer/disposer split from the skeleton, now framed as safety.

### Move 3 — the principle

The control envelope is validate-in, cap-the-loop, gate-actions,
validate-out. The cap is the load-bearing one — flattr proves it's
*structural* (a finite, cycle-free loop has it free), which is exactly why
a model loop, having neither finiteness nor a closed set, must add it by
hand.

---

## Interview defense

**Q: What's the minimum control envelope, and which part is non-negotiable?**

Validate in, cap the loop (max steps + cost ceiling), gate dangerous
actions for a human, validate out. The non-negotiable is the cap — without
it an agent loops silently and burns tokens to nothing. flattr shows why
it's structural, not a nicety: its A* loop halts for free because the graph
is finite and the `closed` set prevents cycles. A model loop has neither,
so the cap *is* the skeleton, not hardening.

Anchor: *"the iteration cap is the budget exit flattr gets free via finite
graph + closed set — a model loop has neither guarantee, so the cap is
mandatory."*

---

## See also

- `../01-reasoning-patterns/02-agent-loop-skeleton.md` (the budget exit)
- `07-graph-orchestration.md`'s human-in-the-loop pause
- `../05-production-serving/03-per-tool-circuit-breaking.md`
- Cross-ref: `study-ai-engineering`'s prompt-injection + error-recovery files
