# 03 — Multi-agent orchestration

Everything above one agent. flattr has **zero agents**, so the only file that
earns its place here is the escalation gate — the decision to *not* go
multi-agent, which is the most important multi-agent decision and the one that
transfers to the reader's other work.

1. [`01-when-not-to-go-multi-agent.md`](01-when-not-to-go-multi-agent.md) —
   the escalation ladder. flattr sits two rungs below the first agent;
   `bench/` is where trajectory evals would attach if it ever climbed.

Not generated (flattr matches none of these shapes — skipped per spec, not
stubbed): supervisor-worker, sequential pipeline of agents, parallel fan-out,
debate/verifier-critic, swarm/handoff, graph orchestration, shared
state/message passing, coordination failure modes. All walked in
`../audit.md` — the coordination failure modes **cannot occur** in a system
with no agents, and the deterministic analogs are bounded by construction.
