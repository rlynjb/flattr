# Agent memory tiers

**Industry names:** working / episodic / long-term memory · agent memory.
**Type:** Industry standard. **In this codebase: Not yet implemented** — no
agent, no cross-session state. flattr's run state is purely working-tier and
discarded when `search()` returns.

> Memory as a dedicated component, separate from the context window.
> flattr's `g`/`came`/`closed` are working memory in the strictest sense —
> they exist only for one run, then vanish.

---

## Zoom out, then zoom in

**Zoom out — the tiers:**

```
  ┌─ Working (in-context) ─────────────────────────┐
  │  The current task's context. Lives in the run. │
  │  Gone when the run ends.                        │
  └─────────────────────────────────────────────────┘
  ┌─ Episodic (recent sessions) ───────────────────┐
  │  Summaries of past runs. Retrieved by relevance.│
  └─────────────────────────────────────────────────┘
  ┌─ Long-term (persistent knowledge) ─────────────┐
  │  Durable facts/preferences. Vector DB / graph. │
  └─────────────────────────────────────────────────┘
```

**Zoom in.** Three tiers by lifespan. Working lives in the run; episodic
summarizes recent runs; long-term is durable, retrieved when relevant. The
load-bearing problem is retrieval — long-term memory only works if the right
thing comes back at the right time (RAG inside the agent).

---

## How it works

### Move 1 — the mental model

flattr is *all working tier, zero persistence*. Every `search()` call builds
fresh `g`/`came`/`closed`/`open` maps (`astar.ts:30-33`) and discards them on
return. There's no episodic ("last time you routed here…") and no long-term
("you prefer flatter routes") — each run is independent.

```
  flattr's memory: working only, no carry-over

  run 1: build g/came/closed → return Path → DISCARD all state
  run 2: build g/came/closed → return Path → DISCARD all state
         (run 2 knows NOTHING about run 1 — amnesiac across runs)
```

### Move 2 — the tiers an agent flattr would add

The reader has shipped the storage-layering instinct this needs — the
local-canonical-plus-retrieved-context shape from a local-first app (per
`me.md`: dryrun, buffr). Applied to an agent:

```
  flattr tier today          what an agent would add
  ─────────────────          ───────────────────────
  working: g/came/closed     episodic: "routes you took this session"
  (per-run, discarded)       long-term: "you set userMax=6, prefer parks"
                             → stored in a vector DB, retrieved by relevance
```

The load-bearing one is long-term: it only works if retrieval surfaces the
right preference at the right time — which is RAG inside the agent
(`../02-agentic-retrieval/01-agentic-rag.md`). A long-term store that
retrieves the wrong memory is worse than none.

### Move 3 — the principle

Memory is tiered by lifespan, and the hard tier is long-term, because it's a
retrieval problem — RAG inside the agent. flattr is the pure working-tier
case: fast, stateless, amnesiac across runs — which makes vivid that
episodic and long-term are *additions*, each with its own retrieval cost.

---

## Interview defense

**Q: What memory does flattr have, and what would an agent add?**

Working tier only — `g`/`came`/`closed` built fresh per `search()` and
discarded on return, so runs are amnesiac. An agent would add episodic
(recent routes) and long-term (durable preferences like a habitual
`userMax`), the latter stored in a vector DB and retrieved by relevance. The
hard part is long-term: it's a retrieval problem, RAG inside the agent, and
surfacing the wrong memory is worse than none.

Anchor: *"flattr is pure working memory — `g`/`came`/`closed` per run,
discarded — so episodic and long-term are clean additions, each a retrieval
problem."*

---

## See also

- `01-context-engineering.md` · `../02-agentic-retrieval/01-agentic-rag.md`
- Mechanics (cross-ref): `study-ai-engineering`'s agent-memory file
  (short/long split)
- Sibling guide `study-data-modeling` — the storage layering this maps onto.
