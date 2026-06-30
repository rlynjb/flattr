# Coordination failure modes

**Industry names:** multi-agent failure modes · coordination tax. **Type:**
Industry standard (production scar tissue). **In this codebase: Not yet
implemented** — flattr has no coordination, so none of these failures exist
in it. Several map onto guarantees flattr gets *structurally*.

> The failures that don't exist in single-agent systems. This is where the
> "2-5x overhead" claim becomes concrete. Each one has a mitigation — and
> for several, flattr's deterministic loop shows the guarantee for free.

---

## Zoom out, then zoom in

**Zoom out — the failure table:**

```
  ┌──────────────────────┬──────────────────────────┐
  │ Failure              │ Mitigation               │
  ├──────────────────────┼──────────────────────────┤
  │ Infinite handoff     │ Handoff counter; force   │
  │ (A→B→A→B…)            │ stop or escalate to human│
  ├──────────────────────┼──────────────────────────┤
  │ Tool-call cascade    │ Per-agent + global       │
  │ (one agent triggers  │ iteration caps; budget   │
  │ a storm of calls)    │ ceiling that halts the run│
  ├──────────────────────┼──────────────────────────┤
  │ Context bloat as      │ Message passing / context│
  │ agents accumulate     │ routing, not a shared    │
  │ shared state         │ blackboard               │
  ├──────────────────────┼──────────────────────────┤
  │ Synthesis failure    │ Validate worker outputs  │
  │ (merge contradictory │ against a schema before  │
  │ results)             │ synthesis; surface       │
  │                      │ conflicts, don't average │
  ├──────────────────────┼──────────────────────────┤
  │ Cost blowup          │ Per-run token budget;    │
  │ (2-5x compounds      │ cheap workers, expensive │
  │ silently)            │ supervisor only          │
  └──────────────────────┴──────────────────────────┘
```

**Zoom in.** These are the specific ways multi-agent overhead shows up,
and the specific controls that bound it.

---

## How it works

### Move 1 — the mental model

Three of these five map directly onto guarantees flattr's A* has
structurally — which is the cleanest way to *remember* them: the failure is
"what you lose when you don't have flattr's structural guarantee."

```
  failure ←→ the flattr guarantee it's the absence of

  infinite handoff   ←  closed set: each node expanded once (astar.ts:61)
                        → no cycles, FREE
  tool-call cascade  ←  finite graph + closed set → frontier drains
                        → bounded work, FREE (the budget exit)
  context bloat      ←  one actor → no cross-agent context accumulation
  synthesis failure  ←  one decider → no contradictory results to merge
  cost blowup        ←  deterministic step (µs, no tokens) → no $ to blow
```

### Move 2 — the two that need real engineering, walked

**Infinite handoff & tool-call cascade** are both non-termination — the
thing flattr's `closed` set + finite graph prevent for free
(`06-swarm-handoff.md`, `../01-reasoning-patterns/02-agent-loop-skeleton.md`).
Multi-agent has neither, so it engineers them: a handoff counter and
per-agent + global iteration caps with a budget ceiling.

**Synthesis failure** is the genuinely *new* one with no flattr analogue:
when a supervisor merges contradictory worker results. The mitigation is
strict — validate worker outputs against a schema before synthesis, and
*surface conflicts, don't average them.* (For flattr's supervisor case,
that's rejecting an all-steep `BLOCKED` leg rather than blending it into
the route — `02-supervisor-worker.md`.)

### Move 3 — the principle

Multi-agent's 2-5x overhead is these five failures plus their controls.
The fastest way to hold them: each is the absence of a guarantee flattr's
deterministic loop has structurally — a finite, cycle-free, single-actor,
deterministic loop has none of them, and every control you add to a
multi-agent system is buying back one of those guarantees.

---

## Interview defense

**Q: Name the multi-agent failure modes and how flattr relates.**

Five: infinite handoff, tool-call cascade, context bloat, synthesis
failure, cost blowup. Three are the absence of guarantees flattr's A* has
for free — the `closed` set prevents cycles (infinite handoff), finiteness
bounds work (cascade/cost), one actor avoids context bloat. Synthesis
failure is the genuinely new one — merging contradictory results — fixed by
schema-validating worker outputs and surfacing conflicts instead of
averaging. The "2-5x overhead" is exactly the cost of buying back those
guarantees by hand.

Anchor: *"each multi-agent failure is the absence of a guarantee flattr's
finite, cycle-free, single-actor A* loop has structurally — the
coordination tax is buying them back."*

---

## See also

- `01-when-not-to-go-multi-agent.md` (the 2-5x overhead, where it's introduced)
- `06-swarm-handoff.md` · `08-shared-state-and-message-passing.md`
- `../05-production-serving/03-per-tool-circuit-breaking.md` (cascade control)
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` (the budget exit)
