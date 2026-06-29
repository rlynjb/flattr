# AI features in this codebase

**Verdict first: flattr does not currently use any LLM-powered features.**
No model is called, no prompt is constructed, no provider SDK is installed.
The AI engineering concepts in the numbered sub-sections of this guide are
covered as study material; the project exercises below identify the features
that *could* be added and the exact files they'd attach to.

This is not a hedge. It's the result of reading the whole dependency tree
and grepping the source.

## What's actually here (and why none of it is AI)

```
flattr — where the work actually lives (no AI band exists)

┌─ Build pipeline (Node, build-time only) ──────────────────┐
│  pipeline/osm.ts · overpass.ts · elevation.ts · geocode.ts │
│  → split.ts → grade.ts → build-graph.ts                    │
│  output: a static mobile/assets/graph.json                 │
└───────────────────────────┬───────────────────────────────┘
                            │ ships one JSON artifact
┌─ Core engine (pure TS, no framework) ────▼────────────────┐
│  features/routing/  graph · astar · bidirectional · pqueue │
│  features/grade/    classify · zones                       │
│  features/map/      geojson · tiles                        │
│  → deterministic graph algorithms. NO model anywhere.      │
└───────────────────────────┬───────────────────────────────┘
                            │ imported by
┌─ Mobile app (Expo / React Native + MapLibre) ▼────────────┐
│  MapScreen · AddressBar · GradeSlider · RouteSummaryCard   │
│  reads graph.json, runs A*, draws colored route. NO model. │
└────────────────────────────────────────────────────────────┘

       ↑ there is no LLM band, no embedding band, no inference band ↑
```

The intelligence in flattr is **algorithmic, not learned**. The "smart"
part is A* with an admissible haversine heuristic and a signed
directed-grade cost function (`features/routing/cost.ts`). That's classical
shortest-path search, decided by hand-written rules, not by a model.

### Dependency audit (the proof)

| where | dependencies | AI/ML? |
|-------|--------------|--------|
| root `package.json` | `tsx`, `typescript`, `vitest`, `@types/node` | none |
| `mobile/package.json` | `@maplibre/maplibre-react-native`, `expo`, `expo-location`, `react`, `react-native`, async-storage, slider | none |

`grep -rniE 'openai\|anthropic\|langchain\|embedding\|llm\|gpt-[0-9]\|claude-[0-9]\|rag\|gemini\|onnx\|mediapipe'`
over `*.ts`/`*.tsx` (excluding `node_modules`/lockfiles) returns **zero**
matches. The word `vector` appears only as MapLibre **vector tiles**.

## You've shipped AI elsewhere — here's where it'd attach here

You're pivoting into AI engineering, and your portfolio already proves the
patterns:

- **AdvntrCue** — classic RAG: pgvector + GPT-4 + Drizzle on Netlify
  Functions, with tool-calling and session memory (MemoRAG). You've built
  retrieve → augment → generate end to end.
- **dryrun** — on-device Gemini Nano with API fallback.
- **contrl** — real-time on-device ML (MediaPipe pose-landmark → rep counter)
  inside a frame-rate latency budget.

So this guide doesn't teach you RAG from scratch. It does the useful thing:
points at **exactly where in flattr** each of those patterns would bolt on.
There are three seams, and only three worth naming.

## The three seams

```
The three places AI attaches to flattr — and nowhere else

  USER TEXT ──────────────► [ geocode() ]      seam 1: input→prompt
   "the flat way to the                        pipeline/geocode.ts:9
    coffee shop on 15th"

  ROUTE RESULT ───────────► [ routeSummary() ] seam 2: output→prompt
   {distanceM, climbM,                         features/routing/summary.ts:11
    steepCount}

  OSM display_name ───────► (any prompt above)  seam 3: injection vector
   untrusted server text                        geocode.ts:27,52,69
```

### Seam 1 — input→prompt: natural-language destination parsing

**Where:** `pipeline/geocode.ts:9` — `geocode(query, opts)`.

Today `geocode` takes a `query` string and hands it straight to Nominatim
as `q=`. It's a literal pass-through: whatever the user types in the
`AddressBar` (`mobile/src/AddressBar.tsx`, wired at
`mobile/src/MapScreen.tsx:82,182,189`) goes verbatim to the geocoder.

The seam: wrap that call. Instead of sending raw text to Nominatim, send
it to an LLM first to extract a clean destination from a fuzzy phrase —
"the flat way to that bakery near Greenlake" → `{ destination: "bakery,
Greenlake, Seattle" }` → then `geocode` that. The signature doesn't change;
you insert one transform before line 14's `URLSearchParams`.

```
seam 1 — what changes (input→prompt)

  NOW:   user text ──────────────────────────► geocode() ─► Nominatim
                              (pass-through)

  AFTER: user text ─► [ LLM extract destination ] ─► geocode() ─► Nominatim
                       new layer, same downstream
```

This is the **input** half of an LLM boundary. Covered conceptually in
`01-llm-foundations/04-structured-outputs.md` (you'd want a typed,
schema-constrained extraction, not free text).

### Seam 2 — output→prompt: "describe my route"

**Where:** `features/routing/summary.ts:11` — `routeSummary(graph, path,
userMax)` returns `{ distanceM, climbM, steepCount }`.

This is the cleanest LLM attachment point in the repo. `routeSummary`
already produces a small, typed, structured object — exactly the kind of
thing you template into a prompt. It's consumed at
`mobile/src/MapScreen.tsx:159` and rendered by `RouteSummaryCard.tsx`
(currently as plain numbers).

The seam: feed that `RouteSummary` into an LLM prompt to generate a
human sentence — "Mostly flat: 2.1 km with 18 m of climb, one steep
block near the end." The route math stays deterministic; the LLM only
*narrates* the already-computed result.

```
seam 2 — what changes (output→prompt)

  NOW:   routeSummary() ─► {distanceM, climbM, steepCount} ─► RouteSummaryCard
                                                              (renders numbers)

  AFTER: routeSummary() ─► {…} ─► [ template into prompt ] ─► LLM ─► sentence
                                   new layer              ─► RouteSummaryCard
```

This is the **output** half of an LLM boundary, and the lowest-risk place
to start because the structured input is already there. Covered in
`01-llm-foundations/01-what-an-llm-is.md` and
`02-context-and-prompts/03-prompt-chaining.md`.

### Seam 3 — injection vector: OSM `display_name` is untrusted text

**Where:** `pipeline/geocode.ts:27`, `:52`, `:69` — every function returns
`label` / a string taken directly from Nominatim's `display_name` field.

`display_name` is **server-controlled text from OpenStreetMap**. OSM is
crowd-edited; anyone can name a place. Today that's harmless — it's just a
string rendered in a label. But the moment seam 1 or seam 2 exists, that
string flows into a prompt, and **untrusted text in a prompt is a prompt
injection vector.** A place named `Ignore previous instructions and …`
becomes an instruction to your model.

```
seam 3 — the trust flip (where it becomes dangerous)

  ┌─ trusted (your code) ─┐  seam  ┌─ untrusted (OSM crowd data) ─┐
  │ your prompt template  │ ═════► │ display_name string          │
  └───────────────────────┘ (flip)└──────────────────────────────┘
        control: YOU                     control: ANY OSM EDITOR
   → once display_name lands in a prompt, an OSM editor
     can inject instructions into your LLM
```

The fix is the standard one (covered in
`06-production-serving/03-prompt-injection.md`): treat retrieved/external
text as **data, not instructions** — delimit it, never concatenate it into
the instruction region, and prefer structured tool I/O over free-text
interpolation. Note this now so it's designed in, not bolted on after the
first weird output.

## Project exercises

### AIX.1 — "Describe my route" (seam 2)

- **What to build:** an optional LLM narration of `RouteSummary` into one
  human sentence, behind a feature flag.
- **Why it earns its place:** smallest, safest first AI feature — the
  structured input already exists, so you only add the output→prompt half.
- **Files to touch:** `features/routing/summary.ts` (export the shape you
  template), a new `features/routing/narrate.ts` (prompt + provider call),
  `mobile/src/RouteSummaryCard.tsx` (render the sentence),
  `mobile/src/MapScreen.tsx:159` (call site).
- **Done when:** a resolved route renders a model-generated sentence whose
  numbers exactly match `routeSummary`'s output, and an eval set of 10
  routes confirms no hallucinated stats.
- **Estimated effort:** 0.5–1 day (provider already familiar from AdvntrCue).

### AIX.2 — Natural-language destination parsing (seam 1 + seam 3 defense)

- **What to build:** an LLM pre-parser in front of `geocode` that extracts
  a structured destination from fuzzy phrasing, with injection-safe handling
  of any text it later sees.
- **Why it earns its place:** exercises structured outputs (input→prompt)
  *and* forces you to design the `display_name` injection defense (seam 3)
  before it bites.
- **Files to touch:** new `pipeline/parse-destination.ts`,
  `pipeline/geocode.ts:9` (call site), `mobile/src/AddressBar.tsx`,
  `mobile/src/MapScreen.tsx:82,182,189`.
- **Done when:** "flat way to the bakery near Greenlake" resolves to a real
  coordinate, and an adversarial set including a malicious `display_name`
  ("Ignore previous instructions…") never changes the model's behavior.
- **Estimated effort:** 1–2 days.

## See also

- [`ml-features-in-this-codebase.md`](ml-features-in-this-codebase.md) — the ML half (also: none)
- [`01-llm-foundations/01-what-an-llm-is.md`](01-llm-foundations/01-what-an-llm-is.md)
- [`06-production-serving/03-prompt-injection.md`](06-production-serving/03-prompt-injection.md)
