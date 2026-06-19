# Study — AI Engineering (flattr)

**Verdict up front: this repo has no AI layer of any kind.** No LLM, no
embeddings, no vector store, no RAG, no agents, no prompts, no model SDKs, no
ML. The product spec says so on purpose (`docs/flattr-spec.md:254` — *"No LLM
layer in v1"*; §13 names the NL destination parser as out of scope).

This guide is therefore an **honest map of seams**, not a description of running
AI. It records each AI-engineering concern as `not yet exercised` and names the
exact file + line where it *would* attach if the spec's out-of-scope NL features
were built. Everything here is future-state.

## Reading order

1. **`00-overview.md`** — start here. The no-AI verdict, the verification grep,
   and the full concern walk: every AI/ML area marked `not yet exercised` with
   its real would-attach seam (file + line range).
2. **`01-describe-route-llm-context-seam.md`** — concept file: the "describe my
   route" data-to-text seam off `features/routing/summary.ts`. The cleanest,
   most likely first LLM call flattr would ever make. Safe seam (payload is
   pure numbers).
3. **`02-nl-destination-parse-seam.md`** — concept file: the natural-language
   destination parser off `pipeline/geocode.ts` + `mobile/src/AddressBar.tsx`.
   Heuristic-first / LLM-fallback; and where untrusted OSM text would become a
   prompt-injection vector.
4. **`ai-features-in-this-codebase.md`** — the honest per-repo file: there are
   none, stated and verified.
5. **`ml-features-in-this-codebase.md`** — same, for ML.

The two concept files follow `format.md`'s 11-block structure and lean on
Move 2.5 (current state vs future state) throughout, since everything is
future-state.

## Why only two concept files

Per the generator instructions: don't build dozens of fully-fleshed concept
files for machinery that doesn't exist. The overview's concern walk does the
honest enumeration. Only two seams are genuinely interesting enough to warrant a
real diagram and a full walkthrough — the two above. Both are grounded in real
files; both attach without rewriting the engine.

## Cross-links to sibling guides

- `.aipe/study-security/` — owns the **prompt-injection-via-OSM-data** thread.
  This guide names the vector (`pipeline/geocode.ts:52`, the OSM `display_name`
  label); that guide hardens it.
- `.aipe/study-testing/` — the **Dijkstra-vs-A\* oracle** and the `bench/`
  harness, the deterministic analog an LLM-judge eval would be built from.
- `.aipe/study-performance-engineering/` — the `bench/` measurement harness in
  depth (the eval-harness shape).
- `.aipe/study-prompt-engineering/` · `.aipe/study-agent-architecture/` —
  query-rewriting, tool-wrapping, and agent-loop mechanics referenced by the
  two seam files.
- `.aipe/study-system-design/` — `summary.ts` and the geocode/search flow as
  part of the routing system.
