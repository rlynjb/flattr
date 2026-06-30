# Supervisor-worker

**Industry names:** supervisor-worker · orchestrator-worker · manager-agent.
**Type:** Industry standard. **In this codebase: Not yet implemented** — no
agents. The closest analogue: the "plan an afternoon" feature
(`../01-reasoning-patterns/07-routing.md`) would have a supervisor calling
flattr's functions as worker-tools.

> The most common and most useful topology. Lead with the shape.

---

## Zoom out, then zoom in

**Zoom out — the topology (Move 1 shape):**

```
  ┌───────────────────────────────────────────────┐
  │              Supervisor agent                  │
  │   (decomposes task, delegates, synthesizes)   │
  └───────┬───────────────┬───────────────┬───────┘
          ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │worker 1│      │worker 2│      │worker 3│
      │(spec.) │      │(spec.) │      │(spec.) │
      └────┬───┘      └────┬───┘      └────┬───┘
           └───────────────┼───────────────┘
                           ▼
                  supervisor synthesizes → answer
```

**Zoom in.** A supervisor decomposes a task, delegates to specialized
workers, and synthesizes their results. It's a manager component
delegating to child components, each owning one responsibility, the parent
merging. The supervisor's core job is routing (`07-routing.md`) + synthesis.

---

## How it works

### Move 1 — the mental model

For the "flat afternoon, 3 coffee stops" feature, a supervisor would
decompose into legs and delegate each to a worker that calls flattr's
`search()`. The bridge: this is a manager React component calling child
components and merging their output — a shape the reader builds daily.

### Move 2 — the one decision, against flattr's tools

The decision to make explicit: does the supervisor call workers as *tools*
(stays in control) or *hand off* to them (control transfers)?

```
  tools-style (debuggable)            handoff-style (flexible)
  ────────────────────────            ────────────────────────
  supervisor calls search() as a      supervisor passes control to a
  tool, keeps the loop                "routing agent" that owns the rest
  → easy to trace                     → harder to trace
```

For flattr, tools-style is the obvious pick: `search`, `geocode`,
`nearestNode`, `routeSummary` are already pure typed functions
(`07-routing.md`), so the supervisor calls them and stays in control. The
synthesis step assembles the legs into one flat loop — and validates
worker outputs (a leg that's all-`BLOCKED`/steep) before merging, per
`09-coordination-failure-modes.md`.

### Move 3 — the principle

The supervisor is router + synthesizer. Tools-style keeps the topology
debuggable; handoff-style is flexible but harder to trace. flattr's
pre-cut tools make tools-style the natural choice — the supervisor never
gives up control, it just calls functions.

---

## Interview defense

**Q: How would a supervisor use flattr's existing code?**

Tools-style. The supervisor decomposes "flat afternoon, 3 stops" into legs
and calls `search()`/`geocode()` as tools, staying in control, then
synthesizes the legs into one loop — validating each leg (reject all-steep
`BLOCKED` legs) before merging. flattr's functions are already pure and
typed, so nothing in `features/routing/` changes.

Anchor: *"flattr's four router functions are pre-cut worker-tools — a
supervisor calls them tools-style and stays in control, no engine change."*

---

## See also

- `01-when-not-to-go-multi-agent.md` · `03-sequential-pipeline.md` ·
  `04-parallel-fan-out.md` · `08-shared-state-and-message-passing.md`
- `../01-reasoning-patterns/07-routing.md`
- `../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md`
