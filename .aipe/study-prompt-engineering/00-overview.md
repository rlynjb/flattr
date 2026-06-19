# Prompt engineering in flattr — overview

> **Verdict first: this repo has no prompts.** No LLM calls, no
> provider SDK, no system message, no completion, no AI layer at all.
> I greped for `prompt`, `openai`, `anthropic`, `llm`, `completion`,
> `gpt-`, `claude-`, `langchain`, `gemini`, `generativeai` across the
> TypeScript, the mobile app, and both `package.json` files. Zero hits
> in application code. The design spec says so on purpose:
> `docs/flattr-spec.md:254` — *"No LLM layer in v1"* — and `:380`
> lists *"the LLM destination parser. All later."* as explicitly out
> of scope.
>
> So this is **not** a prompt-engineering guide for a system that has
> prompts. It's an honest map of where prompts *would* live the day
> the spec's out-of-scope NL features get built — grounded in the real
> files that already exist, with line numbers — and a flat statement
> that everything else is `not yet exercised`.

I'm writing this in the working-AI-engineer voice (the persona for
this topic), not the staff-engineer teacher voice. The most useful
thing I can do here is *not* invent a prompt system. The most useful
thing is to tell you exactly which seams are load-bearing for prompts
later, so when you build "describe my route" you already know which
function's output you're templating and which input is attacker-
controlled.

---

## What flattr actually is

A grade-aware A* router. One user knob — `userMax` (max comfortable
uphill grade) — drives a hand-rolled shortest-path search over a
grade-annotated street graph, plus a grade heatmap. Pure TypeScript
core under `features/` / `pipeline/` / `lib/`; an Expo / React Native
app under `mobile/`. The graph is a prebuilt static artifact
(`mobile/assets/graph.json`). There is no backend, no database, and
no model.

```
  Where an AI layer would sit — and the fact that it doesn't

  ┌─ UI layer (mobile/, Expo + RN) ───────────────────────────┐
  │  AddressBar (text inputs)   RouteSummaryCard (totals)      │
  └───────────────┬───────────────────────────┬───────────────┘
                  │ search string              │ RouteSummary
  ┌─ Engine layer (features/, pipeline/) ──────▼───────────────┐
  │  geocode()    A* router    cost / grade    summary()       │
  └───────────────┬────────────────────────────────────────────┘
                  │ HTTPS (build-time + geocode)
  ┌─ Provider layer ───────────────────────────────────────────┐
  │  Nominatim (OSM)    Open-Meteo (elevation)                 │
  │                                                            │
  │  ┌──────────────────────────────────────────────────┐     │
  │  │  ★ PROMPT / LLM LAYER ★   ← does not exist (v1)   │     │  planned,
  │  │  no provider, no SDK, no prompt template          │     │  not built
  │  └──────────────────────────────────────────────────┘     │
  └────────────────────────────────────────────────────────────┘
```

The starred box is empty. That's the whole finding. Everything below
names where it *would* fill in.

---

## Concept inventory — all 13, all `not yet exercised`

The prompt-engineering spec defines 13 concepts. In a repo with
prompts, each gets a full concept file anchored to real prompt code.
Here, none has prompt code to anchor to, so the honest verdict on
every one is the same: **`not yet exercised`**. I'm not going to pad
13 empty files for machinery that doesn't exist. Instead, here's the
inventory with the concrete seam where each *would* land:

| # | Concept | Verdict | Would-live-here seam (real file:line) |
|---|---------|---------|----------------------------------------|
| 1 | Anatomy of a production prompt | not yet exercised | The "describe my route" prompt would template `features/routing/summary.ts:11` output (`RouteSummary`) as its context-injection section → see `01-describe-my-route-seam.md` |
| 2 | Structured outputs (tool calling / schemas) | not yet exercised | A NL destination parser would emit a typed `{lat,lng,label}` — the shape `pipeline/geocode.ts:3` already defines (`GeocodeResult`) |
| 3 | Prompts as code (versioning / observability) | not yet exercised | No prompt files exist to version. Would live beside engine modules under `features/` as version-controlled templates |
| 4 | Token budgeting / context window | not yet exercised | A route description prompt's context is bounded by `RouteSummary` (3 numbers) — trivially small; budgeting only matters if you stuff the full path geometry |
| 5 | Eval-driven iteration | not yet exercised | The repo evals routing with Vitest (`*.test.ts`); a prompt eval set would sit alongside, asserting on description outputs |
| 6 | Single-purpose chains | not yet exercised | Two candidate single-job chains: "parse destination" (geocode seam) and "describe route" (summary seam) — kept separate, never merged |
| 7 | Output mode mismatch | not yet exercised | If the parser returns JSON and `geocode()` callers expect `GeocodeResult`, the contract at `pipeline/geocode.ts:3` is the mismatch guard |
| 8 | Few-shot prompting | not yet exercised | A destination parser ("the coffee place near the park") would carry few-shot examples mapping phrasings → query strings fed to `geocode()` |
| 9 | Chain-of-thought | not yet exercised | Not warranted — both candidate features are lookups/templating, not multi-step reasoning. CoT would waste tokens here |
| 10 | Self-critique / self-consistency | not yet exercised | Not warranted at this stake level — route descriptions aren't high-stakes edits to user data |
| 11 | Meta-prompting | not yet exercised | No prompt-generating layer exists |
| 12 | Prompt injection defense (author side) | not yet exercised | **The real one.** OSM `display_name` strings (`pipeline/geocode.ts:27,52,69`) are attacker-influenceable free text that would flow into any such prompt → see `01-describe-my-route-seam.md` and cross-link `.aipe/study-security/` |
| 13 | Forbidden patterns / rotating formulas | not yet exercised | Would apply only if "describe my route" ran repeatedly for one user and the phrasings converged |

---

## The two real seams, named

There are exactly **two** places in this codebase where a prompt would
attach. Both already exist as plain deterministic code.

### Seam A — "describe my route" (output → prompt)

`features/routing/summary.ts:11` is `routeSummary(graph, path, userMax)`.
It returns `{ distanceM, climbM, steepCount }`. Today that struct flows
straight into `mobile/src/RouteSummaryCard.tsx`, which renders it as
*"3.2 km · +41 m climb"* with deterministic string templating. A
"describe my route" feature (spec `:254`) would take that same struct
and template it into a prompt instead of into JSX — the honesty output
*is* the context-injection section of the prompt. That's the one seam
worth a diagram, so it gets the single concept file in this guide:
`01-describe-my-route-seam.md`.

### Seam B — natural-language destination parser (input → prompt)

`mobile/src/AddressBar.tsx:68-94` are two `TextInput`s whose text feeds
`pipeline/geocode.ts` (`geocode` / `geocodeSuggest`). Today that text
goes verbatim as a Nominatim query string. The spec's out-of-scope NL
parser (`:380`) would sit *between* the input and `geocode()`: take
free text like "the bakery near the library," prompt an LLM to resolve
it to a query, then call `geocode()`. The output contract it must hit
already exists: `GeocodeResult { lat, lng, label }` at
`pipeline/geocode.ts:3`.

---

## The injection concern is real even before any prompt exists

This is the one thing I'd flag hard. `geocode()` returns
`display_name` from Nominatim/OSM (`pipeline/geocode.ts:27`, `:52`,
`:69`). OSM place names are user-editable, third-party data — anyone
can name a node. Today that's harmless: the label is only ever rendered
as text or used as a search string. **The moment** either future seam
puts an OSM `display_name` (or a route summary derived from
OSM-tagged edges) into a prompt, that untrusted string becomes a
prompt-injection vector — a place named
`Main St"). Ignore previous instructions and …` is a classic indirect
injection. That's a trust-boundary finding, so it cross-links the
security guide: `.aipe/study-security/`.

---

## Reading order

There's one concept file, because one seam earns a real diagram:

1. **`01-describe-my-route-seam.md`** — the single future-state
   concept file. Walks Seam A (and the injection concern on Seam B)
   using `format.md`'s structure with Move 2.5 (current state vs
   future state), since all of it is future-state.

If you build either NL feature later, this folder grows: re-run the
generator and the `not yet exercised` rows above become real concept
files anchored to the new prompt code.

## See also

- `.aipe/study-security/` — trust boundaries; OSM `display_name` as
  untrusted input, the runtime half of injection defense.
- `.aipe/study-ai-engineering/` — where the model call, serving, and
  output-validation seams would be audited if an AI layer is built.
- `.aipe/study-agent-architecture/` — reasoning/agent patterns;
  also `not yet exercised` here for the same reason.
