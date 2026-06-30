# Tokenization

**Industry name(s):** tokenization / BPE / subword encoding / the
tokenizer. **Type:** Industry standard primitive.

## Zoom out — where this would sit in flattr

Before a model sees text it gets chopped into integer *tokens* — usually
subword chunks, not words. "steepCount" might be three tokens; "km" might
be one. Tokens are the unit you pay for and the unit the context window is
measured in. flattr feeds text to **no model at all**, so it tokenizes
nothing today. The only string that would ever cross a tokenizer is the
tiny route-describe prompt built from `RouteSummary` — three numbers and a
template, a handful of tokens.

```
  Zoom out — the only text that would ever be tokenized in flattr

  ┌─ engine ────────────────────────────────────────────────┐
  │ routeSummary() ─► RouteSummary {distanceM,climbM,steep}  │
  └────────────────────────────┬─────────────────────────────┘
                              │ summary.ts:5
  ┌─ ★ would-be prompt ───────▼─────────────────────────────┐
  │ "Route is {distanceM}m, {climbM}m climb, {steepCount}    │
  │  steep edges. Describe in one sentence."                 │
  │            │ tokenizer (text → ints)                     │
  │            ▼  ~25-40 tokens — trivially small            │
  └──────────────────────────────────────────────────────────┘
```

flattr has **no tokenizer and no model**. This file teaches what
tokenization is and shows that flattr's only model-bound string is small
by construction — which is good news for cost and latency.

## Structure pass

- **Layers:** engine (numbers) → prompt template (text) → tokenizer
  (ints) → model.
- **Axis — cost unit:** above the tokenizer you think in domain values
  (meters, counts); below it you think in *tokens*, the thing you're
  billed for and the thing that fills the context window. The axis flips
  at the tokenizer.
- **Seam:** the flip would happen wherever you `JSON.stringify` or
  template `RouteSummary` into a prompt string — adjacent to
  `MapScreen.tsx:159`. There is no such code today.

## How it works

### Move 1 — the mental model

You know `Array.from("café")` splits into characters, and UTF-8 splits
into bytes. A tokenizer is a *learned* split into subword pieces chosen so
common chunks are one token. The model never sees letters — it sees a
sequence of integer ids from a fixed vocabulary.

```
  Pattern — text becomes a fixed-length-ish integer sequence

  "2.3 km, 45 m climb"
        │ BPE / subword tokenizer
        ▼
  [ "2", ".", "3", " km", ",", " 45", " m", " climb" ]
        │ vocab lookup
        ▼
  [ 17, 13, 21, 6042, 11, 2548, 296, 8851 ]   ← what the model consumes
```

### Move 2 — the walkthrough

**flattr's numbers are not text-for-models.** `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

These are JS `number`s rendered by `RouteSummaryCard` with templates and
`.toFixed`. No tokenizer touches them — the UI is deterministic string
formatting, not generation.

```
  Layers-and-hops — where a tokenizer would (and wouldn't) appear

  ┌─ engine ──┐ numbers      ┌─ template ──┐ string   ┌─ tokenizer ─┐
  │routeSummary│ ──────────► │ prompt str  │ ───────► │ text→ints   │
  └───────────┘              └─────────────┘          └──────┬──────┘
                                                       ~30 tokens
                              (everything left of the tokenizer = no model)
```

**The prompt would be tiny.** Three numbers plus an instruction is on the
order of 25–40 tokens. Compare a RAG app that stuffs documents into the
prompt — thousands of tokens. flattr's describe-route prompt is *bounded*
because its input is structurally three numbers, not free text. That
bound is a property worth defending: it keeps cost negligible
([06-token-economics.md](06-token-economics.md)) and latency low.

**The untrusted-text caveat.** The one place flattr *does* hold
free-form text is geocoding: `geocode.ts:27` and `:52` return
`rows[0].display_name` straight from Nominatim/OSM — arbitrary,
attacker-influenceable strings. If a future prompt ever embedded a place
label, *that* text would be tokenized too, and its length is **not**
bounded by you. That is both a token-budget concern and an injection
vector (see [04-structured-outputs.md](04-structured-outputs.md) and the
prompt-injection note). Today no prompt exists, so neither risk is live.

### Move 3 — the principle

Tokens are the model's atoms and your billing unit. Designing the input to
be small and structured — three numbers, not pasted prose — is a
tokenization decision made *before* any model exists. flattr's
`RouteSummary` already has that shape; an OSM `display_name` does not.

## Primary diagram

```
  Tokenization — flattr's bounded prompt vs. the unbounded risk

  ┌─ BOUNDED (good) ────────────────────────────────────────┐
  │ RouteSummary {3 numbers} ─► template ─► ~30 tokens       │
  │ summary.ts:5 — cost & context trivially small            │
  └──────────────────────────────────────────────────────────┘
  ┌─ UNBOUNDED (watch out) ─────────────────────────────────┐
  │ geocode display_name (OSM) ─► arbitrary length tokens    │
  │ geocode.ts:27,:52 — untrusted, not length-controlled     │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Practical tokenizer facts that bite: token counts are not word counts
(numbers and rare strings cost more); non-English and code tokenize less
efficiently; whitespace and punctuation are tokens. Providers ship a
token-counting endpoint so you can measure before you send. In flattr the
measurement is almost a no-op because the input is three numbers — the
engineering win is *upstream*, in having kept the model input structured.

## Project exercises

### B-TOK.1 — count the would-be prompt

- **Exercise ID:** B-TOK.1
- **What to build:** a script that templates a `RouteSummary` into the
  describe-route prompt string and counts tokens (any open BPE library),
  printing the count so the "tiny prompt" claim is measured, not assumed.
- **Why it earns its place:** it turns the token-budget argument into a
  number and documents the bound at the seam.
- **Files to touch:** new `features/routing/describe.ts` (template);
  `summary.ts:5` (the type it reads).
- **Done when:** the script prints a token count under ~50 for a typical
  summary.
- **Estimated effort:** 1 hr.

### B-TOK.2 — bound the untrusted label

- **Exercise ID:** B-TOK.2
- **What to build:** a `truncateLabel(label, maxTokens)` helper to be
  applied to any OSM `display_name` *before* it could enter a prompt, so
  attacker-controlled length can't blow the token budget.
- **Why it earns its place:** it pre-empts the unbounded-input risk at the
  exact untrusted seam.
- **Files to touch:** `pipeline/geocode.ts:27,:52` (where labels return).
- **Done when:** any label is clamped to a max token count with a test.
- **Estimated effort:** 1 hr.

## Interview defense

**Q: How big is flattr's model input, and what controls that?** Answer:
There's no model today, but the only string that would cross a tokenizer
is the route-describe prompt built from `RouteSummary` — three numbers, so
~30 tokens, bounded by construction. The one *unbounded* text in the app
is the OSM `display_name` from geocoding (`geocode.ts:27`), which is
untrusted and length-uncontrolled; if it ever entered a prompt I'd
truncate it first.

```
  RouteSummary → template → ~30 tokens (bounded)
  display_name → ??? tokens (untrusted, must clamp)
```

Anchor: *"flattr's would-be prompt is three numbers — tiny and bounded;
the only unbounded text is the untrusted OSM label at geocode.ts:27."*

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the function tokens feed.
- [06-token-economics.md](06-token-economics.md) — tokens as the billing unit.
- [04-structured-outputs.md](04-structured-outputs.md) — display_name as injection text.
