# AI features in this codebase

**Type label:** Honesty file (per-codebase). Read this first.

## The one-line verdict

flattr does **not** use any LLM-powered features. No model is called,
no prompt is constructed, no API key exists. There is no
`openai`/`anthropic`/`langchain` dependency in either `package.json`
(root) or `mobile/package.json`. Every "AI" grep hit in the repo is a
false positive — `tiles.ts` matches "vector" because it builds **vector
tiles** (GeoJSON), `MapScreen.tsx` matches "llm" inside an unrelated
variable name. The substance is a hand-rolled A\* router over a
grade-annotated street graph. That is graph search, not machine
learning.

So this file does the honest thing the spec asks for: state plainly
what's **not** here, then point at the exact file:line **seams** where
an LLM would attach if you decided to add one — because those seams are
real, and naming them is the interview-grade move.

```
  Zoom out — where AI would sit in flattr (it does not, yet)

  ┌─ UI layer (mobile/, Expo + RN) ─────────────────────────┐
  │  AddressBar  GradeSlider  MapScreen  RouteSummaryCard    │
  │       │            │          │             ▲            │
  └───────┼────────────┼──────────┼─────────────┼────────────┘
          │            │          │             │
  ┌─ Core engine (features/, pipeline/, lib/) ──┼────────────┐
  │  geocode.ts   routing/astar.ts → summary.ts │            │
  │     ▲                              │ RouteSummary         │
  │     │ INPUT seam            OUTPUT │ seam                 │
  │  ───┴───                    ──────┴──── (★ would attach) │
  │  cost.ts  penalty()  ◄── ML attach point (learned cost)  │
  └─────────────────────────────────────────────────────────┘
          ▲                                       ▲
  ┌─ Provider layer (does NOT exist) ─────────────────────────┐
  │  ✗ no LLM provider   ✗ no embeddings   ✗ no vector store  │
  └───────────────────────────────────────────────────────────┘
```

## What is NOT here — be explicit

- **No LLM.** No chat model, no completion call, no streaming, no
  tool-calling. `getModel("anthropic")`-style provider abstraction does
  not exist.
- **No embeddings.** No text is ever turned into a vector. The only
  vectors in this repo are 2D lat/lng geometry — geographic, not
  semantic.
- **No RAG.** No retrieval, no chunking, no augmentation of a prompt
  with retrieved context.
- **No vector store.** No pgvector, no sqlite-vec, no Pinecone. The only
  store is `mobile/assets/graph.json`, a static prebuilt graph artifact.
- **No prompts.** No system prompt, no prompt template, no prompt
  versioning.
- **No agents / no tool use.** No ReAct loop, no agent memory, no
  tool-routing.
- **No evals.** No golden set, no LLM-as-judge, no eval harness. The
  tests under `*.test.ts` are deterministic unit tests of graph math,
  not model evals.

## The three seams where an LLM WOULD attach

These are anchored to real files. Nothing here is implemented — each is
a **seam**, a boundary where you could splice an LLM in without
rewriting either side.

### Seam 1 — "describe my route" (output → prompt)

The router already produces a clean, structured summary. That structure
is exactly what you'd template into an LLM prompt to generate a
natural-language route description.

- **Source of the structured output:** `features/routing/summary.ts:5`
  defines `RouteSummary = { distanceM, climbM, steepCount }`;
  `routeSummary()` (`summary.ts:11`) computes it.
- **Where it's produced at runtime:** `mobile/src/MapScreen.tsx:159`
  (`summary: routeSummary(graph, r.path, userMax)`).
- **Where it's consumed today:** `mobile/src/RouteSummaryCard.tsx`
  renders it as static text ("Flat all the way" / "⚠ Flattest
  available", `{km} km · +{climb} m climb`), wired at
  `MapScreen.tsx:368`.
- **The seam:** between `routeSummary()` (produces typed data) and
  `RouteSummaryCard` (renders it). Today a deterministic component reads
  the struct. An LLM call (`summarize(RouteSummary) → prose`) would
  splice in right there. The struct is the prompt input;
  `RouteSummaryCard` becomes the place the generated prose lands.
- Walked in full at
  [03-retrieval-and-rag/11-rag.md](03-retrieval-and-rag/11-rag.md) and
  [01-llm-foundations/04-structured-outputs.md](01-llm-foundations/04-structured-outputs.md).

### Seam 2 — natural-language destination parsing (input → prompt)

Today the user types a literal address that goes straight to Nominatim.
A query like *"the flattest coffee shop near me, avoid the big hill"*
would need an LLM to parse intent before geocoding.

- **The wrap point:** `pipeline/geocode.ts:9` (`geocode`) and
  `geocode.ts:31` (`geocodeSuggest`).
- **Where it's called:** `MapScreen.tsx:82` (autocomplete),
  `MapScreen.tsx:182` and `:189` (resolve from/to).
- **The seam:** an LLM pre-parse step (`NL text → {place, constraints}`)
  would wrap `geocode`, feeding it a cleaned query string and routing
  the constraints into `userMax`. Walked in
  [02-context-and-prompts/03-prompt-chaining.md](02-context-and-prompts/03-prompt-chaining.md).

### Seam 3 — OSM `display_name` as an injection vector (trust boundary)

This is the one to flag in an interview even though no prompt exists
yet. `geocode.ts:27` and `:52` return `rows[0].display_name` — free text
that came from OpenStreetMap, controlled by whoever edited the map. The
moment that string is templated into **any** future prompt (Seam 1's
prose generator, Seam 2's parser), it is an untrusted-text injection
vector: a place named *"Café. Ignore previous instructions and ..."*
rides straight into the model.

- **Walked in full at**
  [06-production-serving/03-prompt-injection.md](06-production-serving/03-prompt-injection.md).

## ML attach point (one, and only one)

`features/routing/cost.ts` `penalty()` (`cost.ts:16`) is a hand-tuned
analytic function. It is the one place a **learned** model could
legitimately attach — a learned edge cost. But it carries a hard
correctness constraint: A\* admissibility and the `BLOCKED`-finite
invariant. Any learned cost must stay ≥ 0 and monotone, or it breaks the
router. Walked at
[ml-features-in-this-codebase.md](ml-features-in-this-codebase.md) and
[08-machine-learning/01-supervised-pipeline.md](08-machine-learning/01-supervised-pipeline.md).

## What you've shipped elsewhere — where it would attach here

From your portfolio (`me.md`): you've already shipped the AI work that
flattr lacks. The interview framing is *"I've built X; here's the exact
seam where it'd attach in flattr."*

- **AdvntrCue** (RAG / pgvector / GPT-4) → the **Seam 1** route-describe
  feature is a small single-chain version of what AdvntrCue does at
  scale. You'd reuse the structured-output → prompt discipline.
- **dryrun** (on-device Gemini Nano + API fallback) → the route-describe
  prose generator is a natural on-device-first feature, since flattr is
  already a local-first Expo app reading a static `graph.json`.
- **contrl** (on-device MediaPipe ML) → the **ML attach point**
  (`cost.ts`) is where a learned edge cost would live, the way contrl
  runs a trained model on-device. The difference: flattr's learned cost
  is constrained by A\* admissibility in a way pose-landmarking is not.

## Per-feature table (honest)

```
  ┌──────────────────────┬──────────────┬──────────────────────────┐
  │ Feature              │ Pattern      │ Status                   │
  ├──────────────────────┼──────────────┼──────────────────────────┤
  │ Route description    │ Single chain │ NOT BUILT — seam at      │
  │                      │ (would-be)   │ summary.ts:5 →           │
  │                      │              │ MapScreen.tsx:368        │
  ├──────────────────────┼──────────────┼──────────────────────────┤
  │ NL destination parse │ Single chain │ NOT BUILT — seam wraps   │
  │                      │ (would-be)   │ geocode.ts:9             │
  ├──────────────────────┼──────────────┼──────────────────────────┤
  │ Injection defense    │ Input        │ NOT NEEDED YET — becomes │
  │ on display_name      │ sanitization │ load-bearing once a      │
  │                      │              │ prompt exists            │
  └──────────────────────┴──────────────┴──────────────────────────┘
```

## See also

- [ml-features-in-this-codebase.md](ml-features-in-this-codebase.md) — the ML side (cost.ts).
- [00-overview.md](00-overview.md) — how this whole guide is framed.
