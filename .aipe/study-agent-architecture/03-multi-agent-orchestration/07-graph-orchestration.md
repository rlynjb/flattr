# Graph orchestration

**Industry names:** graph orchestration · stateful agent graph (LangGraph-
style). **Type:** Industry standard. **In this codebase: Not yet
implemented** — but flattr's whole domain *is* graph traversal, so the
shape is maximally familiar.

> Control flow as an explicit state machine — nodes, edges, checkpointed
> state. Makes the other topologies inspectable. Lead with the shape.

---

## Zoom out, then zoom in

**Zoom out — the topology (Move 1 shape):**

```
  ┌──────┐    ┌──────┐    ┌──────┐
  │ node │───►│ node │───►│ node │
  │  A   │    │  B   │    │  C   │
  └──────┘    └──┬───┘    └──────┘
                 │ conditional edge
                 ▼
              ┌──────┐
              │ node │  (loop back / branch)
              │  D   │
              └──────┘
```

**Zoom in.** Express the orchestration as a state machine: nodes are
steps, edges are transitions (some conditional), state is checkpointed so
you can pause for human review and resume. Supervisor-worker, pipeline,
and debate can all be expressed this way. The win: debuggability and
human-in-the-loop pauses. The cost: up-front structure.

---

## How it works

### Move 1 — the mental model

flattr already traverses a graph with explicit nodes, edges, and a
checkpointable frontier — `astar.ts`. The difference: flattr's graph is the
*problem domain* (streets), and the traversal rule is `g+h`. Graph
orchestration's graph is the *control flow* (which agent runs next), and
the transition rule is a model or a condition.

```
  two graphs, same shape

  flattr's graph (astar.ts)        orchestration graph (LangGraph-style)
  ─────────────────────────        ────────────────────────────────────
  nodes = street intersections     nodes = agent steps
  edges = streets (weighted)       edges = transitions (conditional)
  state = open/g/came/closed       state = shared agent context
  transition = g+h (code)          transition = model or condition
  frontier = PQueue (resumable)    checkpoint = pause/resume for human
```

### Move 2 — what flattr's traversal already proves

The reader has built graph traversal with a resumable frontier (the
`PQueue`, `pqueue.ts`). Graph orchestration is that instinct applied to
control flow: the `open` frontier becomes a checkpoint you can serialize,
pause on (human review), and resume. flattr's `came` back-pointers
(`astar.ts:32`) are the trajectory record — the same thing a graph
orchestrator checkpoints so it can show "how did we get to this state?"
A frontend state machine for a multi-step form is the same shape: states
+ transitions, except the state is the shared agent context.

### Move 3 — the principle

Graph orchestration makes agent control flow inspectable by making it an
explicit state machine — the same explicitness that lets flattr's A* be
paused, resumed, and traced via its frontier and back-pointers. You trade
up-front structure (defining the graph) for debuggability and
human-in-the-loop pauses.

---

## Interview defense

**Q: Why express agent orchestration as a graph?**

Because an explicit state machine — nodes, conditional edges, checkpointed
state — is inspectable and pausable, where a freewheeling model isn't. The
reader already builds this: flattr's A* traverses an explicit graph with a
resumable `PQueue` frontier and `came` back-pointers recording the
trajectory. Graph orchestration applies that to control flow — the
frontier becomes a checkpoint you pause on for human review.

Anchor: *"flattr's A* already is graph traversal with a resumable frontier
and a trajectory record (`came`) — graph orchestration is that shape
applied to which-agent-runs-next."*

---

## See also

- `02-supervisor-worker.md` · `08-shared-state-and-message-passing.md`
- `../04-agent-infrastructure/05-guardrails-and-control.md` (the
  human-in-the-loop pause graph orchestration enables)
- Sibling guide `study-dsa-foundations` — the graph + priority queue.
