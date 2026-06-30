# 02 · Structured outputs via tool calling and schemas

> Industry name: structured outputs / tool calling / response schema · Type label: Industry standard

> **Status: seam, not feature.** flattr enforces structured shapes *in TypeScript* (`RouteSummary`, `GeocodeResult`), never at an LLM boundary. This file maps schema-first prompting onto Seam 2 (`pipeline/geocode.ts`), where free text would become a typed struct.

## Zoom out — where this concept lives

flattr already lives and dies by typed contracts — it's strict-mode TypeScript with no `any`. The thing it doesn't have is a typed contract *across a model boundary*, where the producer is a model that might hand you anything. That's the seam:

```
  Zoom out — structured output at Seam 2 (NL-destination parse)

  ┌─ UI (mobile) ────────────────────────────────────────────────┐
  │  AddressBar.tsx  →  "somewhere flat near the water"          │
  └─────────────────────────┬────────────────────────────────────┘
                            │  free text
  ┌─ Parse (SEAM 2) ────────▼────────────────────────────────────┐
  │  LLM call with a SCHEMA  ★ THIS FILE ★                       │ ← we are here
  │  declare GeocodeQuery {placeText, near?, preferFlat?}        │
  │  provider enforces → validate at boundary → retry on fail    │
  └─────────────────────────┬────────────────────────────────────┘
                            │  typed struct
  ┌─ Existing code ─────────▼────────────────────────────────────┐
  │  pipeline/geocode.ts  geocode(query) → GeocodeResult         │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **you don't ask the model to "respond in JSON" in prose — you declare a schema, make the provider enforce it, validate the parse at your boundary, and retry on failure.** The prose-instruction version is how it was done in 2022. The schema-enforced version is how it's done now. Let me build the difference.

## Structure pass

**Layers.** Three: the *schema declaration* (what shape you want), the *provider enforcement* (the model is constrained to emit that shape), and the *boundary validation* (you re-check the shape on receipt because enforcement is not a guarantee). flattr's existing `geocode` has only the third layer — it casts `await res.json()` to `NominatimRow[]` and trusts it.

**Axis — guarantees (promised vs best-effort).** Trace it down the layers:

```
  One axis — "is the output shape guaranteed?" — down the layers

  ┌─ schema declaration ─────────┐  → INTENT only (you asked)
  └──────────────────────────────┘
      ┌─ provider enforcement ───┐  → BEST-EFFORT (model usually obeys)
      └──────────────────────────┘
          ┌─ boundary validation ┐  → GUARANTEED (you enforce or reject)
          └──────────────────────┘

  the guarantee only becomes real at the bottom layer — that's the seam
```

**Seam.** The load-bearing boundary is *between provider enforcement and your validation*. People assume "JSON mode" means guaranteed JSON. It means *very-likely* JSON. The guarantee only exists where you parse-and-validate. Skip that layer and you've built on best-effort while believing it's guaranteed — which is the bug that takes two weeks to find.

## How it works

### Move 1 — the mental model

You know `await res.json()` followed by a type cast `as NominatimRow[]` — that cast is a lie the compiler believes. The network could return anything; TypeScript just *asserts* the shape. Structured output is the same situation at the LLM boundary, except the producer is even less reliable than an HTTP API. So the pattern adds the step the cast skips: actually validate.

```
  The structured-output kernel — declare, enforce, validate, retry

  declare schema  ─────►  call with schema  ─────►  parse + validate
        ▲                                                  │
        │                                          ┌───────┴───────┐
        │                                       valid?           invalid?
        │                                          │                │
        │                                       return         retry (stricter)
        └──────────────────────────────────────────────────────────┘
                          bounded: max N retries, then fail loudly
```

### Move 2 — the step-by-step walkthrough

**Declare the schema — not in prose, in a schema language.** For Seam 2 you want the model to turn "somewhere flat near the water" into a struct. In flattr's stack that's a Zod schema (TS-native), the shape that feeds `geocode`:

```ts
// future: pipeline/parse-destination.ts
const GeocodeQuery = z.object({
  placeText: z.string(),              // → goes to geocode(query)
  near: z.string().optional(),        // "the water" → a landmark hint
  preferFlat: z.boolean(),            // "flat" → routing knob
});
// existing target, pipeline/geocode.ts:9
//   geocode(query: string) → GeocodeResult { lat, lng, label }
```

The schema *is* the prompt's output contract. You don't write "return JSON with placeText, near, and preferFlat" in the system prompt — you hand the provider the schema and let it constrain generation. This is the line internet advice gets wrong: "respond only in JSON" as a sentence in the prompt is strictly worse than schema-enforced generation, because the sentence is a suggestion and the schema is a constraint.

**Let the provider enforce.** Tool calling / response-schema mode constrains the model's token sampling to only produce schema-conformant output. Three flavors you'll meet: tool calling (the model "calls a function" whose parameters are your schema — most portable), JSON mode (model promises valid JSON but not *your* JSON), and `response_format`/structured-output mode (provider validates against your schema server-side). For Seam 2, tool calling is the right default — `parse_destination(placeText, near, preferFlat)` reads as a function the model fills in.

**Validate at the boundary — this is the layer flattr's `geocode` skips.** Look at the existing cast:

```ts
// pipeline/geocode.ts:25-27 — the existing pattern, trust-by-cast
const rows = (await res.json()) as NominatimRow[];   // ← cast, not validated
if (!rows.length) return null;
return { lat: parseFloat(rows[0].lat), ... };
```

That `as NominatimRow[]` is fine against Nominatim (a stable API). Against a model it's the bug. The structured-output version replaces the cast with a parse:

```ts
// future: the boundary check the cast skips
const parsed = GeocodeQuery.safeParse(modelOutput);  // ← actual validation
if (!parsed.success) { /* retry path */ }
```

**Retry on schema fail — bounded.** When validation fails, re-call with a stricter system prompt ("your last output failed validation: <error>; return ONLY the schema"). Bounded: max 2-3 retries, then fail loudly and log. The thing nobody mentions in blog posts: **log the schema-fail rate to your metrics dashboard.** A schema-fail rate that climbs from 0.5% to 8% overnight is your early warning that the model got upgraded under you (see `03-prompts-as-code.md`).

```
  Hops — the retry loop, bounded

  ┌─ Parse ──────┐  call+schema  ┌─ Provider ─┐
  │ attempt n    │ ────────────► │ LLM        │
  │              │ ◄──────────── │ output     │
  └──────┬───────┘   output      └────────────┘
         │ validate
    ┌────┴────┐
    │ valid?  │── yes ──► return GeocodeQuery → geocode()
    └────┬────┘
         │ no, n < 3
         ▼ re-call with stricter prompt + the validation error
    (n ≥ 3 → throw + log schema_fail_rate metric)
```

**The specific bug — courteous models and markdown fences.** I have shipped six features on structured output and every one broke at least once because a model, trying to be helpful, wrapped schema-conformant JSON inside a ```` ```json ```` fence. The JSON was *correct*; the fence broke the parser. Two defenses: use real schema-enforced mode (which doesn't fence) rather than "respond in JSON" prose, and make your boundary parser strip fences before validating. Both. Defense in depth at the parser is cheap.

### Move 2.5 — current state vs future state

```
  Phase A (today)              Phase B (Seam 2 built)
  ───────────────              ──────────────────────
  geocode(query: string)      parseDestination(text) → GeocodeQuery
    query must be a literal      free text → schema-enforced struct
    address                      validated, retried, logged
  res.json() as NominatimRow[]  GeocodeQuery.safeParse(output)
    cast, trusted (fine —        validated (required — producer is
    Nominatim is stable)         a model, not stable)
```

What *doesn't* have to change: `geocode()` itself. Seam 2 sits *in front* of it. The model parses free text into a `query` string and the existing `geocode(query)` runs unchanged. That's the payoff of single-purpose chains (`06`) — you bolt the LLM step on without rewriting the deterministic step.

### Move 3 — the principle

Structured output is not "ask nicely for JSON." It's a four-step contract: declare schema → provider enforces → you validate → you retry-and-log. The guarantee lives only at *your* validation step; everything above it is best-effort. Build on best-effort while believing it's guaranteed and you've shipped the bug that fails 5% of the time. **When to NOT use it:** open-ended generation. Seam 1's *route description* is prose — you don't want a schema strangling "mostly flat, one short climb" into fields. Structured output is for input parsing (Seam 2) and classification, not for the creative output.

## Primary diagram

The full Seam 2 structured-output flow, every layer and the validation seam labeled.

```
  Seam 2 — NL destination → typed struct → existing geocode

  ┌─ UI (mobile) ────────────────────────────────────────────────┐
  │ AddressBar.tsx → "somewhere flat near the water"             │
  └─────────────────────────┬────────────────────────────────────┘
                            │ free text + GeocodeQuery schema
  ┌─ Parse (Seam 2) ────────▼────────────────────────────────────┐
  │ ┌── declare ──┐   ┌── enforce ──┐   ┌── validate ──┐ ★seam★   │
  │ │ Zod schema  │ ► │ tool call   │ ► │ safeParse    │          │
  │ │ {placeText, │   │ (provider   │   │ valid? retry │          │
  │ │  near,flat} │   │  constrains)│   │ if not (≤3)  │          │
  │ └─────────────┘   └─────────────┘   └──────┬───────┘          │
  └─────────────────────────────────────────── │ ─────────────────┘
                                               │ GeocodeQuery {placeText}
  ┌─ Existing (unchanged) ──────────────────────▼─────────────────┐
  │ pipeline/geocode.ts:9  geocode(placeText) → GeocodeResult     │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Provider variance is real and lives here, not in its own concept (per the spec's scope). OpenAI's `response_format: { type: "json_schema", strict: true }` validates server-side; Anthropic enforces via tool-use `input_schema`; Google's Gemini has `responseSchema`. The portable pattern that survives all three is tool calling — a named function with typed parameters — which is why I anchored Seam 2 to it. The canonical reference is the OpenAI cookbook's structured-output recipes and Anthropic's tool-use docs. The thing that survives provider upgrades is your *boundary validation*: it doesn't care which provider produced the output.

## Project exercises

### EX-STRUCT-1 — Schema-first destination parser

- **Exercise ID:** EX-STRUCT-1
- **What to build:** `parseDestination(text): Promise<GeocodeQuery>` with a Zod schema, tool-calling enforcement, `safeParse` validation, bounded retry, and a logged `schema_fail` counter.
- **Why it earns its place:** Builds all four layers, including the two flattr's `geocode` skips (enforcement + validation). The fence-stripping defense is a real production reflex you only learn by hitting it.
- **Files to touch:** new `pipeline/parse-destination.ts`; consumes `GeocodeResult` from `pipeline/geocode.ts`.
- **Done when:** a malformed model output (fenced JSON, extra field) is caught by `safeParse` and triggers exactly one retry; the fail counter increments.
- **Estimated effort:** 3-4 hours.

## Interview defense

**Q: "Respond only in JSON" in the prompt — what's wrong with it?**

It's a suggestion, not a constraint. The model usually obeys and occasionally wraps the JSON in a markdown fence to be helpful, breaking your parser. Use schema-enforced mode (tool calling / response_format) which constrains sampling, and validate at the boundary regardless.

```
  prose "respond in JSON"  →  best-effort, fence risk
  schema-enforced mode     →  constrained sampling
  + boundary safeParse     →  the actual guarantee
```

Anchor: flattr's `geocode` does `res.json() as NominatimRow[]` — a cast, fine for a stable API, fatal at a model boundary where you must `safeParse`.

**Q: Where does the "guarantee" of structured output actually live?**

At your validation step, not the provider's. Provider enforcement is best-effort; the guarantee is the `safeParse` + retry you own. Skip it and you've built on best-effort believing it's guaranteed — the 5%-failure bug.

## See also

- `01-anatomy.md` — the context section the schema constrains
- `03-prompts-as-code.md` — logging schema-fail rate to catch model upgrades
- `06-single-purpose-chains.md` — why Seam 2 bolts onto `geocode` without rewriting it
- `07-output-mode-mismatch.md` — the parser-breaks-on-mode-mismatch failure
- `12-prompt-injection-defense.md` — output schema as an injection defense
