# Prompt Engineering — flattr overview

> Industry name: prompt engineering / LLM application engineering · Type label: Industry standard

Let me say the load-bearing thing first, because everything in this folder depends on it being said plainly:

**flattr has no prompts. No LLM calls. No `anthropic`, no `openai`, no model client anywhere in the repo.** I checked. It is a TypeScript A\* router over a grade-annotated street graph. There is nothing here that talks to a model.

So why a prompt-engineering guide?

Because flattr is *exactly the kind of system that grows two LLM features next quarter*, and the seams where those features would attach already exist in the code today — typed, tested, and load-bearing. A working AI engineer doesn't learn prompt engineering on a greenfield toy. You learn it by looking at a real system, finding the three places a model would plug in, and asking "what would I have to get right here, and what would break if I got it wrong." That's what this guide does. Every concept is anchored to a real file in flattr and labeled honestly: **this is a seam, not a feature. Not built here. Here's exactly where and how it would be.**

## The three seams (memorize these — every file references them)

```
  flattr today (no LLM) → the three seams where one would attach

  ┌─ Build-time pipeline ────────────────────────────────────────┐
  │  osm.ts → elevation.ts → split.ts → grade.ts → build-graph.ts │
  │                    ▲                                          │
  │         ┌──────────┴───────────┐                             │
  │         │ pipeline/geocode.ts  │  ★ SEAM 2: NL-destination   │
  │         │ "flat near water" →  │     parse (input → prompt)  │
  │         │ structured geocode   │  ★ SEAM 3: injection vector │
  │         │ in. display_name out │     (display_name is        │
  │         └──────────────────────┘      attacker-editable)     │
  └──────────────────────────────────────────────────────────────┘
                            │  graph.json (static)
  ┌─ Runtime (routing) ─────▼────────────────────────────────────┐
  │  astar.ts → cost.ts(penalty) → summary.ts                    │
  │                                     │                        │
  │              ┌──────────────────────▼─────────────────┐      │
  │              │ features/routing/summary.ts             │      │
  │              │ RouteSummary {distanceM, climbM,        │      │
  │              │   steepCount} + Path.steepEdges         │      │
  │              │ ★ SEAM 1: "describe my route"           │      │
  │              │   (structured output → prompt)          │      │
  │              └──────────────────────────────────────────┘     │
  └──────────────────────────────────────────────────────────────┘
```

**Seam 1 — "describe my route" (output → prompt).** `features/routing/summary.ts:5` defines `RouteSummary { distanceM, climbM, steepCount }`. Combined with `Path.steepEdges` (`features/routing/types.ts:36`), this is a clean structured object that you would *template into a prompt* to get a natural-language route description: "Mostly flat, 2.1km, one short climb near the bridge — you flagged it." Structured data goes IN, prose comes OUT. This is the canonical output→prompt direction.

**Seam 2 — NL-destination parse (input → prompt).** `pipeline/geocode.ts:9` takes a `query: string` and hands it straight to Nominatim. Today that string must be a literal address. The future feature is a free-text query — "somewhere flat near the water" — that an LLM parses into structured geocode input *before* it reaches Nominatim. Free text goes IN, structured fields come OUT. This is the input→prompt direction.

**Seam 3 — injection defense (trust boundary).** `pipeline/geocode.ts:27` returns `display_name` straight from OSM. OSM is a wiki — anyone can edit a place's name. The moment Seam 1 or Seam 2 interpolates a `display_name` into a prompt, that string is an *injection vector*: an attacker can edit an OSM place name to read `Ignore previous instructions and...`. This file teaches the author-side defenses before that line of code is ever written.

## Real anchors used as teaching substrate

These exist today and do real work; the prompt-engineering files borrow them:

| Anchor | File:line | Used to teach |
|---|---|---|
| `RouteSummary` + `Path.steepEdges` | `features/routing/summary.ts:5`, `types.ts:36` | structured-output→prompt (Seam 1), few-shot, CoT thinking-field |
| `geocode(query)` | `pipeline/geocode.ts:9` | input→prompt parse (Seam 2), structured outputs, single-purpose chains |
| `display_name` | `pipeline/geocode.ts:27` | injection defense (Seam 3) |
| `fixtures.ts` golden graphs | `features/routing/fixtures.ts:46` | eval golden-set substrate, few-shot example source |
| `penalty(g, max, k1, k2)` | `features/routing/cost.ts:16` | chain-of-thought (multi-step decision), self-critique |
| `Path` / `Edge` types | `features/routing/types.ts:10,31` | token-budget trap (geometry polylines), output-mode mismatch |

## Reading order

Operational discipline first, specific techniques after. If you read top to bottom you build the muscle before the tricks:

1. `01-anatomy.md` — the four sections of a prompt
2. `02-structured-outputs.md` — the seam where flattr's types become contracts
3. `03-prompts-as-code.md` — versioning prompts the way flattr versions `graph.json`
4. `04-token-budgeting.md` — the `Edge.geometry` polyline trap
5. `05-eval-driven-iteration.md` — `fixtures.ts` as your golden set
6. `06-single-purpose-chains.md` — one chain, one job
7. `07-output-mode-mismatch.md` — JSON vs markdown at the parser
8. `08-few-shot.md` — examples beat instructions
9. `09-chain-of-thought.md` — `penalty()` as the multi-step decision
10. `10-self-critique.md` — checking the model's own route description
11. `11-meta-prompting.md` — using a model to draft prompts
12. `12-prompt-injection-defense.md` — `display_name` as the attack surface
13. `13-forbidden-patterns.md` — stopping every route description sounding the same

## A note on honesty

I have shipped features that depend on every concept in this folder. flattr has shipped none of them. I'm not going to pretend a `penalty()` function is "basically a chain-of-thought prompt" — it isn't, it's a pure numeric function. What I *am* going to do is show you that `penalty()` is the exact shape of multi-step decision that, *if you handed it to a model instead of coding it*, would need chain-of-thought to get right. The mapping is honest: **here is a real decision in your code; here is what teaching a model to make that decision would require.** Label everything future/seam. Invent nothing.

## Cross-links

- `study-ai-engineering` — the runtime-serving side of these seams (where the LLM call actually executes, retries, streams)
- `study-agent-architecture` — if Seam 2's parse grows into a tool-calling loop over geocode
- `study-security` — the trust-boundary audit that Seam 3's injection defense complements
- `study-system-design` — where these seams sit in flattr's pipeline/runtime split
