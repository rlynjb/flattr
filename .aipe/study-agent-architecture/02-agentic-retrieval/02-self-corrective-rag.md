# Self-corrective RAG

**Industry names:** CRAG · self-corrective RAG · relevance-graded RAG.
**Type:** Industry standard. **In this codebase: Not yet implemented** —
no LLM, no retrieved documents to grade.

> Add a relevance grader between retrieval and generation, with a fallback
> path. The point: *retrieval success (a chunk came back) is not answer
> success (the chunk is relevant).* flattr has a deterministic cousin —
> the `steepEdges` grade between "a path came back" and "the path is flat."

---

## Zoom out, then zoom in

**Zoom out.**

```
  retrieve → ┌─ grade each chunk: relevant? grounded? ─┐
             └──────────────┬──────────────────────────┘
              ┌─────────────┴─────────────┐
              ▼ relevant                  ▼ not relevant
          generate                  fall back: rewrite query /
                                    widen search / escalate
```

**Zoom in.** A grader gates between retrieval and generation. If the
chunks aren't relevant, don't generate on them — fall back. The gate
catches the gap between "I got results" and "the results answer the
question."

---

## How it works

### Move 1 — the mental model

flattr already has this gate shape, deterministically. `search()` returns
a path (the "retrieval"), and `summarizePath()` (`astar.ts:110`) grades it
— flagging `steepEdges` where `directedGrade > userMax` (`astar.ts:126`).
"A path came back" ≠ "the path is actually flat." The `steepEdges` grade
is the gate.

```
  flattr's deterministic relevance gate

  search() → Path        ← "retrieval succeeded" (a path exists)
       │
       ▼
  summarizePath() grades each edge against userMax   ← astar.ts:126
       │
       ├─ steepEdges empty → the path is flat (good)
       └─ steepEdges > 0   → "retrieved but not relevant" — needs fallback
                              (re-search looser, or report "no flat route")
```

### Move 2 — the gap flattr makes concrete

The `BLOCKED` convention (large-finite, not Infinity — a must-not-change
constraint) is exactly the self-corrective insight in graph form: a steep
path is *returned but flagged*, distinct from "no path at all." That's CRAG's
distinction between "irrelevant chunk retrieved" and "nothing retrieved" —
flattr encodes it numerically so the two stay separable. A model grader
would replace the `> userMax` rule with "is this chunk relevant and
grounded?"; flattr's rule is exact on its one axis.

### Move 3 — the principle

Retrieval success is not answer success; a grader is the gate that catches
the difference. flattr's `steepEdges` + `BLOCKED` convention is that gate,
built from a hard rule — perfectly reliable on grade, where a model grader
generalizes across relevance at the cost of reliability.

---

## Interview defense

**Q: What's the self-corrective idea, and does flattr have an analogue?**

The grader catches that "a result came back" isn't "the result is good."
flattr's analogue is exact: `search()` returns a path, then `summarizePath`
grades it against `userMax` and flags `steepEdges` — and `BLOCKED` being
large-finite (not Infinity) keeps "steep path returned" distinct from "no
path." That's CRAG's relevant-vs-nothing distinction, in graph form.

Anchor: *"flattr's `steepEdges` + the large-finite `BLOCKED` convention is
a deterministic relevance gate: a path can come back yet be flagged
not-flat — exactly retrieval-success ≠ answer-success."*

---

## See also

- `01-agentic-rag.md` · `03-retrieval-routing.md`
- `../01-reasoning-patterns/05-reflexion-self-critique.md` (the same
  critic shape, on output)
- Mechanics (cross-ref): `study-ai-engineering`'s `03-retrieval-and-rag/`
