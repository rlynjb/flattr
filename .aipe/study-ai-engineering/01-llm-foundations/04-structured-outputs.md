# Structured outputs

**Industry name(s):** structured outputs / constrained decoding / JSON
mode / tool-calling schemas. **Type:** Industry standard.

## Zoom out — where this would sit in flattr

You already have a typed contract at a boundary in flattr — you just
have it on the *wrong* side for AI. `RouteSummary` is a Zod-less but
fully-typed struct that crosses from the engine into the UI. Structured
outputs are the same idea applied to an LLM boundary: force the model to
return data shaped like a type, not free text.

```
  Zoom out — the typed boundary that already exists, + the one that doesn't

  ┌─ Core engine (features/routing/) ───────────────────────┐
  │  routeSummary() ──► RouteSummary { distanceM, climbM,   │
  │                                    steepCount }          │ ← typed today
  └───────────────────────────┬─────────────────────────────┘
                              │ summary.ts:5
  ┌─ UI (mobile/) ────────────▼─────────────────────────────┐
  │  RouteSummaryCard renders it as text (deterministic)     │
  │                                                          │
  │  ★ IF an LLM described the route, its OUTPUT would need  │
  │    a schema too: { headline: string, caution?: string } │
  └──────────────────────────────────────────────────────────┘
```

flattr has **no LLM**, so there is no structured-output call today. This
file teaches the pattern and names where the schema would live.

## Structure pass

- **Layers:** engine (produces `RouteSummary`) → UI (renders). A future
  LLM call would sit *between* them.
- **Axis — trust in the shape:** on the engine side the shape is
  guaranteed by TypeScript at compile time. On a (hypothetical) LLM
  side, the shape is *not* guaranteed — the model emits a token stream
  that you hope parses. The axis flips at the LLM boundary: compile-time
  guarantee → runtime hope.
- **Seam:** the boundary where you'd add a schema is exactly
  `MapScreen.tsx:368`, where `RouteSummary` is handed to the renderer.
  A prose-generating LLM would need its *own* output schema so the
  renderer still gets typed data.

## How it works

### Move 1 — the mental model

You know how `RouteSummary` guarantees `distanceM` is a `number` so
`RouteSummaryCard` can call `.toFixed(2)` without checking? Structured
output is that guarantee extended across the LLM boundary: you hand the
model a schema, and it returns JSON that validates against it — or it
errors. No hand-parsing prose.

```
  Pattern — schema constrains the model's output

  schema { headline: string, caution: string | null }
        │ passed as tool / JSON mode
        ▼
  ┌─────────────────────────────────┐
  │ LLM, decoding constrained to    │
  │ emit ONLY tokens that keep the  │
  │ JSON valid against the schema   │
  └────────────────┬────────────────┘
                   ▼
  { "headline": "Flat all the way, 2.3 km",
    "caution": null }            ← valid by construction
```

### Move 2 — the walkthrough

**The data you already have.** `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

This is the *input* to a route-describe prompt. The model reads these
three numbers and writes prose. **The output of that prompt also needs a
type** — otherwise you're back to hand-parsing, the exact thing
`RouteSummaryCard` avoids today.

**Where the schema attaches.** At `MapScreen.tsx:159` you compute
`summary`. At `:368` you pass it to `RouteSummaryCard`. A structured LLM
call would slot between: `summary → describeRoute(summary) →
{headline, caution} → RouteSummaryCard`. The renderer keeps reading a
typed object; only the *source* of the text changes.

```
  Layers-and-hops — schema on both sides of a future LLM call

  ┌─ engine ──┐ hop1: RouteSummary  ┌─ LLM boundary ─────┐
  │summary.ts │ ──────────────────► │ prompt(schema_in)  │
  └───────────┘                     │ JSON-mode(schema_out)│
                                    └─────────┬──────────┘
  ┌─ UI ──────┐ hop2: {headline,caution} ◄────┘
  │SummaryCard│  (typed — same contract as today)
  └───────────┘
```

**The boundary condition.** Without a schema, the model's phrasing drift
("Flat the whole way!" vs "No hills.") would break any string-matching
in the renderer. With JSON mode, you get `{headline}` every time. This
is why classifiers and structured outputs run at `temperature=0` and
through a schema — see
[03-sampling-parameters.md](03-sampling-parameters.md).

### Move 3 — the principle

A schema at an LLM boundary is the same engineering move as a TypeScript
interface at a function boundary: push validation to the edge so
everything downstream can assume the shape. flattr already does this for
`RouteSummary`; the LLM version just adds a runtime check because the
producer (a model) can't be trusted at compile time.

## Primary diagram

```
  Structured output — the full picture for flattr's would-be feature

  ┌─ engine ────────────────────────────────────────────────┐
  │ routeSummary() → RouteSummary {distanceM,climbM,steep}   │
  └────────────────────────────┬─────────────────────────────┘
                              schema_in
  ┌─ (NOT BUILT) LLM call ─────▼─────────────────────────────┐
  │ describeRoute(summary)  ── JSON mode → {headline,caution}│
  └────────────────────────────┬─────────────────────────────┘
                              schema_out (typed)
  ┌─ UI ───────────────────────▼─────────────────────────────┐
  │ RouteSummaryCard — renders typed object (unchanged)      │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Structured outputs solve the "the model changed its phrasing and my
parser broke" failure that every early LLM app hit. Modern providers
implement it as constrained decoding (the sampler is masked to only
allow tokens keeping the JSON valid) or via tool-calling, where the tool
signature *is* the schema. In your AdvntrCue work this is the
tool-calling layer; in flattr it's purely hypothetical until Seam 1 is
built.

## Project exercises

### B-SO.1 — typed route-describe output

- **Exercise ID:** B-SO.1
- **What to build:** a `describeRoute(summary: RouteSummary)` function
  with a typed output `{ headline: string; caution: string | null }`,
  stubbed (no real LLM) returning a template string, so the *contract*
  exists before any model.
- **Why it earns its place:** it makes the output → prompt seam concrete
  and keeps `RouteSummaryCard` reading a typed object.
- **Files to touch:** new `features/routing/describe.ts`;
  `mobile/src/MapScreen.tsx:159` (call it); `RouteSummaryCard.tsx`
  (read `headline`/`caution`).
- **Done when:** the renderer reads only the new typed object and the
  template stub passes a unit test.
- **Estimated effort:** 1–2 hrs.

## Interview defense

**Q: Where would a schema live in flattr if you added an LLM route
description?** Sketch the engine → LLM → UI hops. Answer: the *input*
schema is already there (`RouteSummary`, `summary.ts:5`); the new piece
is an *output* schema (`{headline, caution}`) so `RouteSummaryCard`
keeps its typed contract. The load-bearing part people forget: the
output needs its own schema, not just the input.

```
  RouteSummary (in) → [LLM, JSON mode] → {headline,caution} (out)
```

Anchor: *"flattr already has the input contract; structured output adds
the matching output contract at the LLM boundary."*

## See also

- [03-sampling-parameters.md](03-sampling-parameters.md) — why temp=0 for structured output.
- [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) — the full route-describe seam.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — schema as injection defense.
