# Prompt chaining — and the geocode (input→prompt) seam

**Industry name(s):** prompt chaining / multi-step LLM pipeline.
**Type:** Industry standard.

## Zoom out — no chains in flattr, but the input seam is `geocode()`

flattr runs no LLM chains. But the spec's second seam — natural-language
destination parsing — is a two-step chain that would *wrap*
`pipeline/geocode.ts`. Today the user types a literal address and it
goes straight to Nominatim. A query like *"flattest park near me, skip
the hill"* needs an LLM step first: parse intent → geocode the place →
set `userMax` from the constraint.

```
  Zoom out — the input seam (where an NL parse chain would wrap geocode)

  ┌─ UI (mobile/) ──────────────────────────────────────────┐
  │  AddressBar text  ──►  geocode(text)  [MapScreen.tsx:82] │
  └────────────────────────────┬─────────────────────────────┘
                  ★ a parse-chain would sit HERE, before geocode
  ┌─ Core engine (pipeline/) ──▼─────────────────────────────┐
  │  geocode() → Nominatim → { lat, lng, label }  geocode.ts:9│
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** UI text input → `geocode` → engine routing.
- **Axis — who interprets the input?** Today: nobody — the raw string is
  a Nominatim query verbatim. In an NL-parse chain: an LLM interprets it
  into `{place, constraints}` before geocoding. The axis (input
  interpretation) flips at the `geocode` call site.
- **Seam:** `MapScreen.tsx:82` (and `:182/:189`), where text reaches
  `geocode`. A chain wraps the call: `text → parse() → geocode(place)`.

## How it works

### Move 1 — the mental model

You know how flattr already runs a *deterministic* two-step pipeline at
build time (OSM → elevation → graph)? A prompt chain is the same shape
with an LLM as one step: each step has one job, output of step 1 feeds
step 2. For NL parsing: step 1 extracts `{place, maxGrade}`, step 2
geocodes `place` and pipes `maxGrade` into `userMax`.

```
  Pattern — two-step parse chain wrapping geocode

  "flattest park near me, skip the hill"
        │
        ▼ Chain 1: LLM parse (one job: extract intent)
   { place: "park near me", maxGrade: 3 }
        │ place
        ▼ Chain 2: geocode(place)  ← existing geocode.ts:9
   { lat, lng, label }
        │  + maxGrade → userMax
        ▼
   route + grade slider preset
```

### Move 2 — the walkthrough

**The existing geocode call (step 2 already exists).** `geocode.ts:9`:

```ts
export async function geocode(query: string, opts: { … } = {}): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
  …
  return { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon), label: rows[0].display_name };
}
```

This takes a clean place string and returns a coordinate. It is already
the second step of the chain — you don't change it.

**Where the chain wraps it.** `MapScreen.tsx:182`:

```ts
const a = await geocode(from, { viewbox });
```

A parse step inserts before: `const { place, maxGrade } = await
parseDestination(from); const a = await geocode(place, { viewbox });`.
Step 1 is new; step 2 is untouched.

```
  Layers-and-hops — wrapping geocode with one LLM step

  ┌─ UI ──────┐ hop1: raw NL text   ┌─ (NOT BUILT) parse ─┐
  │AddressBar │ ──────────────────► │ LLM → {place,grade} │
  └───────────┘                     └─────────┬───────────┘
                            hop2: clean place  │
  ┌─ engine ──┐ ◄──────────────────────────────┘
  │geocode.ts │  geocode(place) — UNCHANGED (geocode.ts:9)
  └───────────┘
```

**Boundary conditions.** Two. (1) The chain output must be
[structured](../01-llm-foundations/04-structured-outputs.md) — `{place:
string, maxGrade: number}` — or step 2 gets garbage. (2) `geocode`
returns `display_name` (`geocode.ts:27`), which is untrusted; if you
ever feed that label back into a *describe* prompt, you've opened the
injection vector
([prompt-injection](../06-production-serving/03-prompt-injection.md)).

### Move 3 — the principle

Chain steps isolate jobs and errors: parsing is one model's job,
geocoding is the engine's job, and a bad parse fails loudly before a
malformed query hits Nominatim. flattr already separates concerns this
way in its build pipeline; the NL-parse chain just adds an LLM as the
first link. The principle: keep each step single-purpose, and never let
the LLM step do the geocoding it should only *prepare*.

## Primary diagram

```
  NL destination parse — full chain over the geocode seam

  ┌─ UI ────────────────────────────────────────────────────┐
  │  AddressBar text (MapScreen.tsx:82/182/189)              │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ (NOT BUILT) Chain 1: parse ▼ ───────────────────────────┐
  │  LLM → { place: string, maxGrade: number }  (schema'd)   │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Chain 2: geocode (EXISTS) ▼─────────────────────────────┐
  │  geocode(place) → { lat, lng, label } [geocode.ts:9]     │
  └────────────────────────────┬─────────────────────────────┘
                  maxGrade → userMax; coords → router
```

## Elaborate

Chaining is the workhorse of LLM apps — most "agents" are really fixed
chains. The discipline that matters is single-purpose steps so you can
swap a cheap model into the parse step and keep the engine deterministic.
flattr's build pipeline already demonstrates the staged-pipeline
instinct; adding an LLM front-end is a small, contained extension.

## Project exercises

### B-CHAIN.1 — NL destination parse step

- **Exercise ID:** B-CHAIN.1
- **What to build:** `parseDestination(text): {place, maxGrade}` with a
  schema'd output, wrapping the existing `geocode` call so the engine is
  untouched.
- **Why it earns its place:** it makes the input→prompt seam concrete
  and demonstrates single-purpose chaining.
- **Files to touch:** new `pipeline/parse-destination.ts`;
  `mobile/src/MapScreen.tsx:182/189` (call parse before geocode).
- **Done when:** typing "flat park near me, max 3%" geocodes "park near
  me" and sets `userMax = 3`.
- **Estimated effort:** half a day with a stub model.

## Interview defense

**Q: How would natural-language search attach to flattr?** Answer: a
two-step chain at `MapScreen.tsx:182` — an LLM parse step extracting
`{place, maxGrade}`, then the *existing* `geocode(place)`
(`geocode.ts:9`) unchanged. Load-bearing point: the LLM only *prepares*
the query; geocoding and routing stay deterministic, so a bad parse
can't corrupt the route.

```
  NL text → [LLM parse] → place → geocode(place) [existing]
```

Anchor: *"the geocode step already exists; the chain just adds a
single-purpose parse step in front of it."*

## See also

- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — the parse output schema.
- [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) — the output (describe) seam.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — `display_name` from geocode is untrusted.
