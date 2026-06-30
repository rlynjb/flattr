# Query rewriting and HyDE — N/A, but the closest seam is the NL-parse at geocode

**Industry name(s):** query rewriting / HyDE (Hypothetical Document Embeddings).
**Type:** Industry standard.

## Zoom out — flattr rewrites no queries, but its input seam is where one would attach

Query rewriting and HyDE both improve *retrieval* by reshaping the user's
query before it hits an index — rewrite expands it into retrievable
terms, HyDE generates a hypothetical answer and embeds that. flattr has
no index to retrieve from, so neither applies. The nearest structural
cousin is the input seam: the raw address string the user types, which
goes straight to `geocode` (`MapScreen.tsx:82`). An LLM could *reshape*
that string before geocoding — which is query rewriting's shape, pointed
at a geocoder instead of a vector index.

```
  Zoom out — the closest "query reshape" seam is in front of geocode

  ┌─ UI (mobile/) ──────────────────────────────────────────┐
  │  AddressBar text ──► geocode(text) [MapScreen.tsx:82]    │
  │  ★ an LLM rewrite would sit HERE, before geocode —       │
  │     reshape "flat park near me" → "park near me"          │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ engine (pipeline/) ───────▼─────────────────────────────┐
  │  geocode() → Nominatim → { lat, lng, label }  geocode.ts:9│
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** UI text → `geocode` → routing.
- **Axis — is the user's input reshaped before lookup?** Today: no — the
  raw string is a Nominatim query verbatim. With a rewrite step: an LLM
  cleans/expands it first. The axis (raw vs reshaped input) would flip at
  the `geocode` call site.
- **Seam:** `MapScreen.tsx:82` (and `:182/:189`). This is the same input
  seam the NL-parse chain uses — query rewriting and that parse step are
  the *same insertion point*, differing only in what the LLM emits.

## How it works

### Move 1 — the mental model

Query rewriting is "fix the user's question before you go looking" —
short, vague queries get expanded into terms a corpus actually contains.
HyDE goes further: generate a fake ideal answer, embed *that*, and
retrieve docs near it, because answers look more like documents than
questions do. Both reshape the query to close the gap between how users
ask and how data is stored. flattr's gap isn't query↔corpus (there's no
corpus) — it's *raw NL ↔ clean geocoder input*.

```
  Pattern — reshape the query before lookup

  rewrite: "fix auth thing" → "debug auth token verification errors" → retrieve
  HyDE:    "fix auth thing" → fake answer → embed answer → retrieve near it
  flattr's cousin: "flat park near me, skip hills" → "park near me" → geocode
                    (reshape NL → clean place string, then geocode)
```

### Move 2 — the walkthrough

**The raw query flattr passes today.** `MapScreen.tsx:182`:

```ts
const a = await geocode(from, { viewbox });   // raw user text, verbatim
```

`from` is whatever the user typed, handed straight to Nominatim. No
reshaping. If the user writes "flattest park near me, skip the hill,"
Nominatim gets the literal sentence — and a geocoder is poor at intent.

**Where a rewrite step would attach.** The same place the NL-parse chain
attaches: an LLM step before `geocode` that extracts a clean place string
(and, in flattr's case, the grade constraint). The geocode call itself —
`geocode.ts:9` — stays untouched; only its *input* is reshaped.

```
  Layers-and-hops — rewrite the NL query, then geocode (unchanged)

  ┌─ UI ──────┐ hop1: raw NL text   ┌─ (NOT BUILT) rewrite ─┐
  │AddressBar │ ───────────────────►│ LLM → clean place str │
  └───────────┘                     └─────────┬─────────────┘
                        hop2: "park near me"   │
  ┌─ engine ──┐ ◄──────────────────────────────┘
  │geocode.ts │  geocode(place) — UNCHANGED (geocode.ts:9)
  └───────────┘
```

**The boundary condition.** Two. (1) HyDE specifically is the wrong tool
even hypothetically — it generates a hypothetical *document* to embed, and
flattr has nothing to embed; the only viable cousin is plain rewriting
that emits a place string. (2) The rewrite output feeds a geocoder, so it
must be a clean query, not free text — which makes it the same
[structured-output](../01-llm-foundations/04-structured-outputs.md)
discipline as the NL-parse chain. This is really *one* seam, described two
ways.

### Move 3 — the principle

Query rewriting and HyDE both exist to close the gap between how users
express intent and how the lookup system expects it. flattr's lookup is a
geocoder, not a vector index, so HyDE is structurally inapplicable and the
only relevant move is reshaping NL into a clean place string — which is
exactly the input-seam parse step. The principle: a "reshape the query"
step belongs in front of *whatever* lookup you have; for flattr that
lookup is `geocode`, and the reshape is a parse, not an embedding trick.

## Primary diagram

```
  flattr's closest cousin to query rewriting

  ┌─ UI ────────────────────────────────────────────────────┐
  │ AddressBar text (MapScreen.tsx:82/182/189)               │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ (NOT BUILT) rewrite/parse ▼ ────────────────────────────┐
  │ LLM → clean place string (+ grade)  ·  NOT HyDE          │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ geocode (EXISTS) ─────────▼─────────────────────────────┐
  │ geocode(place) → { lat, lng, label } [geocode.ts:9]      │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Query rewriting and HyDE are retrieval-quality tools — they live or die by
whether they improve measured recall over a corpus, the kind of tuning
you'd do in **AdvntrCue**. flattr has no corpus, so HyDE is out entirely
and "rewriting" collapses into the NL-parse step at the input seam. The
transferable insight: a query-reshape step attaches in front of *any*
lookup, but the technique has to match the lookup — embedding tricks for
a vector index, plain parsing for a geocoder.

## Project exercises

### B-QR.1 — NL query rewrite in front of geocode

- **Exercise ID:** B-QR.1
- **What to build:** an LLM step that rewrites a messy NL destination
  into a clean place string before `geocode`, with schema-validated
  output. (This is the same insertion point as the NL-parse chain — build
  one, get both.)
- **Why it earns its place:** it makes the "reshape the query before
  lookup" pattern concrete against flattr's real geocoder, and keeps
  `geocode` untouched.
- **Files to touch:** new `pipeline/rewrite-query.ts` (or reuse
  `parse-destination.ts`); `mobile/src/MapScreen.tsx:182/189`.
- **Done when:** "flattest park near me" geocodes "park near me" instead
  of the literal sentence.
- **Estimated effort:** half a day with a stub model.

## Interview defense

**Q: Would query rewriting or HyDE help flattr's retrieval?** Answer:
HyDE no — it embeds a hypothetical document and flattr has nothing to
embed. Plain query rewriting has a real home, but not over a corpus: it's
the input seam in front of `geocode` (`MapScreen.tsx:182`), where an LLM
reshapes messy NL into a clean place string. That's the same insertion
point as the NL-parse chain, and `geocode.ts:9` stays unchanged.
Load-bearing point: match the reshape technique to the lookup — parse for
a geocoder, embedding tricks for a vector index.

```
  raw NL → [LLM rewrite] → clean place → geocode (unchanged). No HyDE.
```

Anchor: *"flattr's only query-reshape seam is in front of geocode — a
parse, not HyDE, because there's no index to embed against."*

## See also

- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the same NL-parse input seam.
- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — the rewrite output must be schema'd.
- [01-embeddings.md](01-embeddings.md) — why HyDE is structurally inapplicable.
