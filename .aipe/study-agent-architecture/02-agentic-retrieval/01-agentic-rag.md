# Agentic RAG

**Industry names:** agentic RAG · iterative retrieval. **Type:** Industry
standard. **In this codebase: Not yet implemented** — no LLM, no corpus,
no embeddings. flattr's `search()` is a deterministic control loop, not an
agentic retrieval loop.

> The shift from retrieval as a one-shot pipeline step to retrieval as a
> loop the model drives. flattr has no model and no documents, so this is
> pure study material — but the *loop* shape is the same one in
> `01-reasoning-patterns/02-agent-loop-skeleton.md`.

---

## Zoom out, then zoom in

**Zoom out.**

```
  Static RAG (one shot):
    query → retrieve top-k → stuff → generate   (no eval, no second try)

  Agentic RAG (a loop):
  ┌─ decompose query into sub-questions ──────────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
                             ▼
  ┌─ retrieve for each (route to the right source) ───────────┐
  └──────────────────────────┬─────────────────────────────────┘
                             ▼
  ┌─ evaluate: enough to answer? ─────────────────────────────┐
  │   ├─ no  → re-retrieve (refine query) → loop (cap it)     │
  │   └─ yes → generate                                       │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** This is ReAct whose primary tool is retrieval. The reframe:
*all agentic RAG is agentic AI; not all agentic AI does retrieval.* flattr
is the latter case inverted — it has neither.

---

## How it works

### Move 1 — the mental model

It's the agent loop (`02-agent-loop-skeleton.md`) with the step =
"retrieve and check if it's enough." flattr's `search()` loops too, but
its "is it enough?" check is `current === goalId` (`astar.ts:52`) — a hard
equality, not a model judging sufficiency.

```
  flattr's loop check        agentic RAG's loop check
  ───────────────────        ────────────────────────
  current === goalId         LLM("is this enough to answer?")
  (exact, code)              (judgment, model)
```

### Move 2 — why flattr can't exercise it

Agentic RAG needs three things flattr lacks: a model to decide
sufficiency, a document corpus to retrieve from, and embeddings to
retrieve *by similarity*. flattr retrieves graph *nodes* by exact
adjacency, deterministically. The tradeoff agentic RAG pays — ~3-10x token
cost and 2-5x latency over static RAG — is the cost of putting a model in
the sufficiency-check slot; flattr's equality check is free.

**Attachment point:** if the "plan an afternoon" feature
(`01-reasoning-patterns/07-routing.md`) indexed POI/trail descriptions,
agentic RAG would live in `features/plan/`, looping geocode/search/corpus
lookups until it had enough to assemble a route.

### Move 3 — the principle

Use the retrieval loop only when one-shot retrieval *measurably* fails on
multi-step or cross-source queries — the above-threshold rule, hard.
flattr never retrieves documents at all, so the question never arises; the
lesson it teaches is the contrast: a deterministic loop's sufficiency
check is free and exact, a model's is expensive and fuzzy.

---

## Interview defense

**Q: Does flattr do RAG?**

No — no model, no corpus, no embeddings. Its `search()` is a control loop
that retrieves graph nodes by exact adjacency, with an equality
sufficiency check (`current === goalId`), not a model judging "is this
enough." Agentic RAG puts a model in that check and pays 3-10x tokens for
it; flattr's check is free because it's exact.

Anchor: *"flattr loops to a goal with an equality check; agentic RAG loops
to sufficiency with a model check — same loop, expensive slot."*

---

## See also

- `02-self-corrective-rag.md` · `03-retrieval-routing.md`
- `../01-reasoning-patterns/02-agent-loop-skeleton.md`
- Mechanics (cross-ref): `study-ai-engineering`'s `03-retrieval-and-rag/`
