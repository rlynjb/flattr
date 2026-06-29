# 00 — Overview: prompt engineering in a codebase with no prompts

*Type label: orientation*

Let me be blunt before we start, because nothing in this guide works if I'm
not. I grepped the whole tree. There is no `anthropic`, no `openai`, no
`@google/generative-ai`, no `langchain`, no model SDK, no `.prompt` file, no
string anywhere that gets handed to an LLM. flattr is a hand-rolled A* router
over a grade-annotated street graph. It is one of the cleanest "no AI in it"
codebases I've read.

So why a prompt-engineering guide? Because flattr has the *exact* shape that
grows a prompt layer. I've shipped four or five features that started life
as a deterministic pipeline and grew an LLM seam later — and the ones that
went badly went badly because nobody mapped the seam before bolting the model
on. This guide does that mapping work up front. Every concept is taught
against a **seam**: a real boundary in flattr's real code where a prompt
would attach. Nothing is invented. Nothing is claimed to exist.

## Zoom out — where prompts would sit in flattr

Here's the whole system, with the three seams marked in the bands where
they'd live. Two of them are at the edges (input and output); one is a trust
boundary that cuts across both.

```
  flattr today (all deterministic) + the three future prompt seams

  ┌─ UI layer (mobile/, Expo) ──────────────────────────────────────┐
  │  AddressBar.tsx   GradeSlider.tsx   RouteSummaryCard.tsx         │
  │       │                                      ▲                   │
  │  ★ SEAM 2 ★ free text in              ★ SEAM 1 ★ NL description  │
  └───────┼──────────────────────────────────────┼──────────────────┘
          │                                       │
  ┌─ Pipeline / engine (features/, pipeline/, lib/) ─────────────────┐
  │  geocode.ts ──► nearest.ts ──► astar.ts ──► summary.ts           │
  │       ▲                                          │               │
  │  parse "flat near water"             RouteSummary{...} out       │
  └───────┼──────────────────────────────────────────┼──────────────┘
          │                                           │
  ┌─ Provider layer (does not exist yet) ────────────────────────────┐
  │  ★ where an LLM call would live — NONE TODAY ★                   │
  │  ★ SEAM 3 ★ display_name from Nominatim flows in here untrusted  │
  └──────────────────────────────────────────────────────────────────┘
```

The provider band is empty. That emptiness is the honest center of this
whole guide. We are studying the sockets, not the plug.

## Zoom in — the three seams, named precisely

**Seam 1 — output→prompt (`features/routing/summary.ts:11`).**
`routeSummary()` returns `RouteSummary { distanceM, climbM, steepCount }`.
That is *already* a structured object. The "describe my route in plain
English" feature is the classic output→prompt move: take a structured result,
template it into a prompt, get prose back. The struct is the prompt's *input*.
This is the anchor for concepts 01, 02, 08, 09, 13.

**Seam 2 — input→prompt (`pipeline/geocode.ts:9`).** `geocode(query, opts)`
takes a `query` string and hits Nominatim. Today `query` must be a literal
address. The "type what you want in English" feature — *"somewhere flat near
the water"* — is the input→prompt move: an LLM parses free text into the
structured args `geocode()` and the router actually need. This is the anchor
for concepts 06, 07, 11.

**Seam 3 — the injection boundary (`pipeline/geocode.ts:27,52,69`).** Every
geocode call returns `display_name`, a string that comes from OpenStreetMap —
which means it's edited by the public. The moment that string is interpolated
into a prompt (and at Seam 1 it would be: "your destination is {label}"), it's
an injection vector. This is the anchor for concept 12.

## The structure pass — one axis across the seams

Pick **trust** as the axis and trace it across the three layers. Watch the
answer flip — that flip is exactly where the prompt work concentrates.

```
  axis = "can the model be trusted to follow instructions here?"

  ┌─ engine (deterministic) ─┐   trust = TOTAL — code does exactly
  │  astar.ts, summary.ts    │   what it says, every time
  └────────────┬─────────────┘
               │ seam: struct → prompt   ◄── trust FLIPS here
  ┌─ LLM call (future) ──────┐   trust = BEST-EFFORT — model usually
  │  prompt + model          │   follows, fails ~some% of the time
  └────────────┬─────────────┘
               │ seam: untrusted data → prompt   ◄── trust FLIPS again
  ┌─ external data (OSM) ────┐   trust = ZERO — attacker-influenceable
  │  display_name string     │   text that the model will read as words
  └──────────────────────────┘
```

The engine is total-trust: A* returns the same path for the same input
forever. The prompt is best-effort: it follows instructions *most* of the
time, which is the entire reason evals (concept 05) and structured outputs
(concept 02) exist. The external data is zero-trust: `display_name` is words
a stranger wrote, and the model can't tell words-that-are-data from
words-that-are-commands unless you build that boundary (concept 12).

Three layers, one axis, two flips. Every prompt-engineering concept in this
guide is a tool for managing one of those two flips. That's the map. Read
`01-anatomy.md` next — it walks the four sections of a prompt against Seam 1's
real `RouteSummary` struct.

## What this guide will NOT do

- Invent a prompt and pretend it's in the repo.
- Show you `anthropic.messages.create(...)` as if flattr calls it.
- Use marketing words. A prompt that "fails 4% of the time and regresses on a
  model upgrade" is the honest description; "robust AI solution" is not.

Where a concept genuinely has nothing to anchor to in flattr beyond the seam,
the file says so and the Project exercises block becomes the buildable target.
</content>
