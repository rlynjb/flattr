# Context engineering

**Industry names:** context engineering · context curation. **Type:**
Industry standard. **In this codebase: Not yet implemented** — no model, no
context window to engineer.

> The discipline RAG and prompt engineering are subsets of: everything the
> model sees at inference time. flattr has no model, so this is study
> material — but it's the discipline that decides *which agent sees what*,
> which the "plan an afternoon" feature would need.

---

## Zoom out, then zoom in

**Zoom out — the superset:**

```
  ┌───────────────────────────────────────────────┐
  │            Context engineering                │
  │  (everything the model sees at inference time)│
  │   ┌──────────┐ ┌──────┐ ┌────────┐ ┌────────┐ │
  │   │ prompt   │ │ RAG  │ │ memory │ │ tool   │ │
  │   │ eng.     │ │      │ │        │ │ outputs│ │
  │   └──────────┘ └──────┘ └────────┘ └────────┘ │
  │   ┌──────────┐ ┌─────────────┐                │
  │   │ history  │ │ user profile│                │
  │   └──────────┘ └─────────────┘                │
  └───────────────────────────────────────────────┘
```

**Zoom in.** Most agent failures are *context* failures, not model
failures — stale retrieval, lost-in-the-middle on a bloated window, no user
state loaded, the wrong tool outputs in the window. Bigger windows don't fix
this; they make room for more noise. The job is curating what fills the
window for the next step.

---

## How it works

### Move 1 — the mental model

flattr has a deterministic version of "curate the working set." The id→edge
index (`astar.ts:12`) and the `byId.get(edgeId)` lookups (`astar.ts:65`)
load *only the edges adjacent to the current node* into the expansion — not
the whole graph. That's the same instinct: bring into the working step only
what the step needs.

```
  flattr's deterministic "curate the working set"

  the whole graph (thousands of edges)
       │  but the step only needs...
       ▼
  graph.adjacency[current] → a handful of edge ids   ← astar.ts:64
       │  resolved O(1) via the index                ← astar.ts:12
       ▼
  the expansion sees ONLY the relevant edges (no bloat)
```

### Move 2 — what an agent version curates

For the "plan an afternoon" agent, context engineering decides what goes in
the window each step: the user's `userMax`, the current leg's endpoints, the
cafes found so far — *not* the entire graph or every prior tool output. In a
multi-agent version, it decides *which agent sees what* (the message-passing
side of `../03-multi-agent-orchestration/08-shared-state-and-message-passing.md`).
The failure flattr avoids structurally — loading the whole graph into one
step — is exactly the context-bloat failure an agent has to curate against.

### Move 3 — the principle

Prompt engineering gets the first good output; context engineering keeps the
thousandth. The job is curating what fills the window for the *next* step —
and flattr's adjacency-only expansion is the deterministic proof that
loading only what the step needs is what keeps work bounded.

---

## Interview defense

**Q: What's context engineering, and does flattr have an analogue?**

It's curating everything the model sees per step — most agent failures are
context failures, not model failures, and bigger windows just hold more
noise. flattr's analogue is structural: its A* expansion pulls only
`graph.adjacency[current]` — the relevant edges — not the whole graph, via
the O(1) id→edge index. Same instinct: the step sees only what it needs.

Anchor: *"flattr's adjacency-only expansion loads just the edges the step
needs — context engineering is that curation discipline applied to the
model's window."*

---

## See also

- `02-agent-memory-tiers.md` · `03-tool-calling-and-mcp.md`
- `../03-multi-agent-orchestration/08-shared-state-and-message-passing.md`
- Mechanics (cross-ref): `study-ai-engineering`'s context-window +
  lost-in-the-middle files
