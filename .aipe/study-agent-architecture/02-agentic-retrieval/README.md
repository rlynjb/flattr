# 02 — Agentic retrieval

**Anchor:** single-agent (primary).

Retrieval as a *control loop the agent drives*, not a one-shot pipeline
step. **None of this is exercised in flattr** — there's no LLM, no
document corpus, no embeddings, no vector store. flattr's only "retrieval"
is graph search (`search()` in `astar.ts`), which is a control loop but
not *agentic* retrieval (no model decides to re-retrieve).

These files are study material. They do *not* re-teach retrieval
mechanics (embeddings, chunking, vector DBs, RAG) — those live in
`study-ai-engineering`'s `03-retrieval-and-rag/`. They cover only the
shift from one-shot retrieval to a retrieval *loop*.

## Files

1. `01-agentic-rag.md` — retrieve → evaluate → re-retrieve loop
2. `02-self-corrective-rag.md` — a relevance grader between retrieve and generate
3. `03-retrieval-routing.md` — route the query to the right source first

## The one honest anchor

flattr's `search()` is the closest thing to "retrieval as a loop" — it
loops, expanding the frontier until it finds the goal. But the loop is
*deterministic* (code decides each expansion), so it's the contrast from
`01-reasoning-patterns/02-agent-loop-skeleton.md`, not agentic retrieval.
Agentic RAG would be a *model* deciding "the chunks I got aren't enough,
retrieve again with a refined query" — flattr has no such decision.

The attachment point, if flattr ever indexed POIs/trail descriptions for
the "plan an afternoon" feature: a new `features/plan/` module would do
agentic retrieval over that corpus, calling `geocode`/`search` as tools.
