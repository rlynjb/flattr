# 07 — System-Design Templates

**Generic AI-system-design interview reframes — with honest, flattr-grounded applicability bullets.**

These are the canonical "design an X" whiteboard questions, written as reusable templates: the standard architecture, the data model, the scale concerns. flattr has **no LLM and no model**, so the architecture/data/scale sections are generic study material. What's *not* generic is the **"Applies to this codebase"** section in each file — those bullets are answered about flattr's real files only, and the answer is mostly *"it doesn't apply; here's the nearest real seam."*

Read these to rehearse the templates, and to practice the harder skill: saying precisely *why* a famous architecture has no home in a given codebase, and where the one honest analog (if any) lives.

## Files

| # | Template | flattr verdict |
|---|----------|----------------|
| [01](01-search-ranking.md) | Search + ranking | Partial — `AddressBar.tsx` + `geocode.ts geocodeSuggest` is a real search UI, but it's a pass-through to Nominatim with no flattr-side ranker. A* "ranks" routes by explicit cost (`cost.ts`), not learning. |
| [02](02-tech-support-chatbot.md) | LLM support chatbot | Not at all — no chat, no support corpus, no model. Only thread: a route-explanation assistant over `summary.ts:11` would be a *different product*. Out of scope. |

## Real seams (verified)

The only points where flattr touches anything an LLM pipeline would care about:

- **output→prompt:** `features/routing/summary.ts:11` — route totals (distance/climb/steep), the natural thing a model would describe.
- **input→prompt:** `pipeline/geocode.ts:9` — address query resolution; the entry point for user-typed text.
- **injection vector:** `pipeline/geocode.ts:27,52,69` — OSM `display_name` is untrusted and would need escaping before ever entering a prompt.

## Bottom line

flattr is a grade-aware routing engine: a hand-rolled A* over a grade-annotated street graph, plus an Expo/RN map app. It has no learned ranker and no chatbot. These templates are worth knowing cold for interviews — the value here is the disciplined *no*, anchored to the three real seams above.
