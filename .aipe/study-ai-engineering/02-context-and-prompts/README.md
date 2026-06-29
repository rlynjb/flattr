# 02 · Context and Prompts

How a model's single finite working memory gets filled, where attention fails
inside it, and how to split work so no one call has to hold everything. Study
material for flattr — which runs **no LLM today**. Each file names the real seam
where a prompt *would* attach if the "Describe my route" or NL-destination
features were built.

```
THE ONE BOX, AND HOW WE MANAGE IT
        ┌── 01 context window ── the finite shared budget
prompt ─┼── 02 lost-in-middle ── attention sags in the center of that budget
        └── 03 prompt chaining ── split work so each box stays small & checkable
```

| # | File | Concept | flattr status |
|---|------|---------|---------------|
| 01 | [01-context-window.md](01-context-window.md) | Finite token budget shared by system/tools/history/retrieval/user | Not exercised — would-be input (`summary.ts:11`) is 3 numbers; window near-empty |
| 02 | [02-lost-in-the-middle.md](02-lost-in-the-middle.md) | Models attend to start/end, miss the middle; fix via retrieve→rerank→place | Not exercised — no retrieval, no long context, no needle to lose |
| 03 | [03-prompt-chaining.md](03-prompt-chaining.md) | One job per step; cheap model early, expensive on synthesis | Not exercised — but real design at seam 2 (`summary.ts:11` → narrate) |

**The seams referenced here:**
- output→prompt: `features/routing/summary.ts:11` → `mobile/src/MapScreen.tsx:159` → `RouteSummaryCard.tsx`
- input→prompt: `pipeline/geocode.ts:9` (user text to Nominatim)
- injection vector: `pipeline/geocode.ts:27,52,69` (untrusted OSM `display_name`)
