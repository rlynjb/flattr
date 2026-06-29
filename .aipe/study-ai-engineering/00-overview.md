# 00 — Overview

One page to orient. The verdict, the map, and the three seams.

## The verdict

flattr is a grade-aware routing engine. Its intelligence is **A* search
over a hand-built, grade-annotated street graph** — classical algorithms,
deterministic, every cost hand-coded in `features/routing/cost.ts`. There
is **no LLM, no embedding, no vector store, no RAG, no trained ML model,
no inference runtime** anywhere in the repo. The dependency tree confirms
it; the grep confirms it.

This guide's whole job: say that honestly, then point at the exact places
AI/ML *would* attach — grounded in real files, not invented.

## Where AI would sit (it doesn't yet)

```
flattr layers — the AI/ML band is empty (drawn as a gap)

┌─ Build pipeline (build-time) ─────────────────────────────┐
│ osm → overpass → elevation → geocode → split → grade →    │
│ build-graph  ⇒  mobile/assets/graph.json                  │
│   ◦ seam 1 lives here: pipeline/geocode.ts:9 (input→prompt)│
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ Core engine (pure TS) ───────────────────────────────────┐
│ routing: graph · astar · bidirectional · pqueue · cost     │
│ grade: classify · zones    map: geojson · tiles            │
│   ◦ seam 2 lives here: features/routing/summary.ts:11      │
│     (output→prompt)                                         │
│   ◦ ML opportunity: features/routing/cost.ts (learned cost)│
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ ✗ AI / ML band ──────────── EMPTY ───────────────────────┐
│   no LLM · no embeddings · no vector DB · no model         │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌─ Mobile app (Expo + MapLibre) ────────────────────────────┐
│ MapScreen · AddressBar · GradeSlider · RouteSummaryCard    │
│   ◦ seam 3 (injection): OSM display_name → any prompt above│
└────────────────────────────────────────────────────────────┘
```

## The three seams (the only AI attachment points)

| # | seam | file:line | concept |
|---|------|-----------|---------|
| 1 | input→prompt | `pipeline/geocode.ts:9` | NL destination parsing → structured output |
| 2 | output→prompt | `features/routing/summary.ts:11` | "describe my route" narration |
| 3 | injection vector | `pipeline/geocode.ts:27,52,69` | OSM `display_name` untrusted text |

And one ML attachment point, gated by flattr's admissibility invariant:
`features/routing/cost.ts` (learned edge cost, must stay `≥ 0`).

## How to read this guide

The two root files are the payload — read them first:

- [`ai-features-in-this-codebase.md`](ai-features-in-this-codebase.md)
- [`ml-features-in-this-codebase.md`](ml-features-in-this-codebase.md)

The numbered sub-sections (`01-` … `09-`) teach the AI/ML concepts as
study material. Each concept file is honest in its "In this codebase"
block: **not yet exercised**, with the precise seam where it would attach.
The concepts are real and worth knowing; flattr's usage is zero.

## Calibration

You've shipped the real versions of these patterns elsewhere — RAG in
AdvntrCue (pgvector + GPT-4), on-device Gemini Nano in dryrun, on-device
MediaPipe ML in contrl. So this guide doesn't re-teach you RAG; it tells you
*where in flattr* the patterns you already know would bolt on. The LLM
concepts move fast (you have the instincts); the ML section (`08-`) is
taught as newer ground, since classical supervised ML beyond contrl is the
named gap.
