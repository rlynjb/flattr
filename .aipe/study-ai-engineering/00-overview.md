# AI engineering in flattr — overview

**Type label:** Guide orientation (per-codebase).

## The shape of AI work in flattr: none yet — but the seams are real

The spec names three shapes of AI codebase: LLM application engineering
(loopd), prompt-tooling (aipe), classical ML (contrl-mo). **flattr is
none of them.** It's a hand-rolled A\* router over a grade-annotated
street graph — graph search and geometry, no model anywhere. So this
guide is written in the spec's honest mode: it teaches each AI/ML
concept as study material, then anchors it to the one place in *this*
repo where that concept would attach if you built it. No invention, no
hedging.

```
  flattr today — one diagram

  ┌─ UI (mobile/, Expo + React Native) ─────────────────────┐
  │  AddressBar → geocode   GradeSlider → userMax            │
  │  MapScreen orchestrates   RouteSummaryCard renders       │
  └───────────────────────────┬─────────────────────────────┘
                              │ reads
  ┌─ Core engine (features/, pipeline/, lib/) ──────────────┐
  │  graph.json ─► astar.ts ─► summary.ts ─► RouteSummary    │
  │      ▲           ▲  uses cost.ts penalty()               │
  │      │           │                                       │
  │  build pipeline (OSM + elevation → graph.json)           │
  └─────────────────────────────────────────────────────────┘

  No provider layer. No model. No prompt. No embedding.
```

## The three seams (memorize these)

Everything in this guide points back to four real anchors:

1. **Output → prompt seam** — `features/routing/summary.ts:5`
   (`RouteSummary`), produced at `mobile/src/MapScreen.tsx:159`,
   consumed at `RouteSummaryCard` (`MapScreen.tsx:368`). A
   "describe my route" LLM feature attaches here.
2. **Input → prompt seam** — `pipeline/geocode.ts:9` (`geocode`),
   called at `MapScreen.tsx:82/182/189`. A natural-language destination
   parser wraps this.
3. **Trust boundary** — `geocode.ts:27/52` returns OSM `display_name`,
   untrusted text, the injection vector for any future prompt.
4. **ML attach point** — `features/routing/cost.ts:16` (`penalty()`).
   A learned edge cost goes here, constrained by A\* admissibility (≥ 0,
   monotone) and the finite-`BLOCKED` invariant.

## What's deliberately NOT claimed

Every LLM/embedding/eval/RAG/agent concept below is marked **not yet
exercised** with its precise attachment point. The two root files —
[ai-features-in-this-codebase.md](ai-features-in-this-codebase.md) and
[ml-features-in-this-codebase.md](ml-features-in-this-codebase.md) —
state the negatives plainly and kill the one tempting false positive
(`classify.ts` is a threshold table, not a classifier).

## How to read this guide

Start with the two root honesty files. Then read by seam:

- **Seam 1 (route-describe):** `01-llm-foundations/`, `02-context-and-prompts/`, `03-retrieval-and-rag/11-rag.md`.
- **Seam 3 (injection):** `06-production-serving/03-prompt-injection.md`.
- **ML attach point:** `08-machine-learning/`.
- **Interview synthesis:** `07-system-design-templates/`, `09-ml-system-design-templates/`.

See [README.md](README.md) for the full file index.
