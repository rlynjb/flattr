# 03 — Multi-agent orchestration

**Anchor:** multi-agent (primary). The load-bearing *new* material in the
spec — taught as new ground per `me.md`.

Everything above one agent: topologies that coordinate many agents.
**flattr exercises none of it** — there's one router loop, no agents, no
coordination. These files are study material. Each leads with the topology
*shape* (the spec requires the topology diagram as the Move 1 mental
model), then names flattr's analogue where one exists.

The one real anchor: flattr's `pipeline/` (`osm→elevation→split→grade→
graph`) is the **no-LLM cousin of the sequential pipeline** — a fixed
chain of single-purpose stages. See `03-sequential-pipeline.md`.

## Reading order

1. `01-when-not-to-go-multi-agent.md` — ★ the gate. Read first, always.
   For flattr the answer is trivially "stay single-process" — it's not even
   single-*agent* yet.
2. `02-supervisor-worker.md` — the most common topology
3. `03-sequential-pipeline.md` — flattr's `pipeline/` is the deterministic cousin
4. `04-parallel-fan-out.md` — `Promise.all()` over independent agents
5. `05-debate-verifier-critic.md` — producer + critic
6. `06-swarm-handoff.md` — peer-to-peer control transfer
7. `07-graph-orchestration.md` — control flow as an explicit state machine
8. `08-shared-state-and-message-passing.md` — how agents communicate
9. `09-coordination-failure-modes.md` — the failures that don't exist in
   single-agent systems (where "2-5x overhead" becomes concrete)

## Honest framing

flattr is nowhere near needing any of this. The escalation gate
(`01`) exists precisely to say: don't reach for multi-agent before
single-agent hits its quality ceiling — and flattr has no single agent
yet. The system-design templates (SECTION F) name the refactor that would
take flattr from "deterministic router" to "single agent" — multi-agent is
two steps away, not one.
