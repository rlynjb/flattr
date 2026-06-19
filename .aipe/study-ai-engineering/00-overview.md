# AI Engineering — overview (flattr)

> Verdict first, no dancing around it: **this repo has no AI layer of any
> kind.** No LLM, no embeddings, no vector store, no RAG, no agents, no
> prompts, no model SDKs, no inference serving. Not "lightly used" — *zero*.
> The product spec says so on purpose: `docs/flattr-spec.md:254` —
> *"No LLM layer in v1."* — and names a natural-language destination parser
> as explicitly out of scope (`docs/flattr-spec.md:377`, §13).
>
> So this guide does not teach you a flattr AI system, because there isn't
> one. It does two honest jobs instead:
>   1. Walks every AI-engineering concern the generator spec enumerates and
>      marks each `not yet exercised` — the dominant, correct verdict here.
>   2. For each concern, names the **exact file and line range** where it
>      *would* attach if the spec's out-of-scope NL features were ever built.
>
> Everything in this folder is **future-state**. Read it as a map of seams,
> not a description of running code.

---

## What flattr actually is (so the "no AI" verdict makes sense)

flattr is a deterministic, hand-rolled, grade-aware A* routing engine in
TypeScript, plus an Expo / React Native app that renders it. It optimizes for
*flat, not fast*. Everything keys off one number — `userMax`, the steepest
uphill grade you're willing to climb.

Here's the whole system as layers, with the (empty) AI band drawn in where it
would sit if it existed:

```
  flattr — system layers, AI band marked EMPTY

  ┌─ UI layer (mobile/, Expo + RN) ───────────────────────────────┐
  │  MapScreen.tsx · AddressBar.tsx · GradeSlider.tsx              │
  │  Legend.tsx · RouteSummaryCard.tsx                            │
  └───────────────────────────┬───────────────────────────────────┘
                              │  calls (in-process, no network)
  ┌─ Engine layer (features/) ▼───────────────────────────────────┐
  │  routing/ : graph · astar · bidirectional · pqueue · cost      │
  │             nearest · summary                                  │
  │  grade/   : classify · zones                                   │
  │  map/     : geojson · tiles                                    │
  └───────────────────────────┬───────────────────────────────────┘
                              │  reads prebuilt artifact
  ┌─ Data layer ──────────────▼───────────────────────────────────┐
  │  mobile/assets/graph.json   (static, read-only at runtime)     │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Build-time pipeline (pipeline/, runs offline) ───────────────┐
  │  overpass → osm → split → elevation → grade → build-graph      │
  │  geocode (Nominatim address→coord)                            │
  └────────────────────────────────────────────────────────────────┘

  ┌╴ AI / Provider layer ╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶┐
  ┊                  (DOES NOT EXIST — empty band)                 ┊
  ┊  no LLM client · no embeddings · no vector DB · no agent loop  ┊
  └╴╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶┘
```

The dashed band is the entire subject of this study guide. It's empty. The
job below is to say *where each box would land* if someone built it.

### How I verified the verdict (do it yourself)

```
  grep -rEi 'openai|anthropic|@anthropic-ai|langchain|llama|mistral|
            cohere|ollama|gemini|embedding|vector|\bllm\b|\bprompt\b|
            huggingface|transformers|onnx|tensorflow|pytorch|mediapipe|
            inference|rerank|\brag\b' \
    --include='*.ts' --include='*.tsx' --include='*.json' \
    --exclude-dir=node_modules --exclude-dir=.aipe .
```

Hits: `docs/flattr-spec.md` (the line that says there's no LLM), an Android
design doc that lists the LLM parser as *out of scope*, and a transitive
`package-lock.json` substring. **Zero source files.** Both `package.json`s
carry no model SDK — the heaviest mobile dep is `@maplibre/maplibre-react-native`.
The verdict is not an opinion; it's what the tree contains.

---

## The concern walk — every AI area, marked, with its real seam

This is the heart of the guide. Each row is one concern area from the
AI-engineering spec. The verdict is the same everywhere (`not yet exercised`),
so the *useful* column is the last one: the concrete file + line range where
that concern would attach the day someone builds the out-of-scope NL features.

Two future features drive almost every seam, both lifted straight from the
spec's own "natural later add" note:

  - **Feature D — "describe my route":** an LLM turns a resolved route's
    numbers into a sentence. Reads `features/routing/summary.ts`.
  - **Feature P — NL destination parse:** an LLM turns *"the flat café near
    the marina"* into a geocoder query. Wraps `pipeline/geocode.ts` and the
    mobile `AddressBar.tsx` search.

### 01 — LLM foundations

| Concept | Verdict | Where it would attach |
|---|---|---|
| What an LLM is (IO model) | not yet exercised | No model call site exists. Feature D would add one consuming `features/routing/summary.ts:11` (`routeSummary`). |
| Tokenization / token economics | not yet exercised | The thing you'd count tokens on is the `RouteSummary` object (`summary.ts:5`) plus any OSM labels passed in — both tiny, so cost would be trivial. |
| Sampling parameters | not yet exercised | Feature D's "describe" call wants `temperature` low for factual consistency; no call site to set it on yet. |
| Structured outputs | not yet exercised | Feature P should return a typed `{ query, viewbox? }` to hand to `geocodeSuggest` (`pipeline/geocode.ts:31`). That schema is the structured-output contract. |
| Streaming | not yet exercised | Only Feature D (a sentence to a user) would stream, into `RouteSummaryCard.tsx`. |
| Heuristic-before-LLM | not yet exercised | This one *already exists in spirit*: `AddressBar.tsx` does plain string geocode today. The LLM parse would be the fallback when the string geocode returns nothing — heuristic-first is the natural shape. See `02-nl-destination-parse-seam.md`. |
| Provider abstraction | not yet exercised | No `getModel()` factory. Would be a new `features/describe/` or `pipeline/` module. |
| User-override locks | not yet exercised | flattr's editable user value is the From/To text and `userMax`; an LLM-suggested destination would need an "I picked this myself" lock before any re-parse overwrote it. |

→ Deep walk of the describe-route seam: **`01-describe-route-llm-context-seam.md`**

### 02 — Context and prompts

| Concept | Verdict | Where it would attach |
|---|---|---|
| Context window | not yet exercised | A route summary + a handful of OSM labels is a few hundred tokens. Window pressure is a non-issue here — worth saying plainly rather than inventing a management strategy. |
| Lost-in-the-middle | not yet exercised | Only relevant if Feature D stuffed every edge of a long route into context. The fix is upstream: `summary.ts` already *aggregates* edges into three numbers, so there's nothing to lose in the middle. |
| Prompt chaining | not yet exercised | A two-step "summarize route → phrase for tone" chain would sit between `summary.ts:11` and `RouteSummaryCard.tsx`. Single-call is enough; chaining would be over-engineering at this scale. |

### 03 — Retrieval and RAG

| Concept | Verdict | Where it would attach |
|---|---|---|
| Embeddings / model choice | not yet exercised | flattr retrieves by *geometry* (lat/lng + haversine in `lib/geo.ts`), not by semantic similarity. There is no corpus to embed. |
| Chunking / vector DB / dense-sparse / hybrid / rerank | not yet exercised | No documents, no chunks, no vectors. `mobile/assets/graph.json` is a graph, not a knowledge base. RAG has nothing to attach to. |
| Query rewriting / HyDE | not yet exercised | The *closest* analog is Feature P rewriting *"flat café near marina"* into a Nominatim query — that's query rewriting in spirit, attaching at `pipeline/geocode.ts:31`. See `02-nl-destination-parse-seam.md`. |
| Stale embeddings / incremental indexing | not yet exercised | No embeddings to go stale. The freshness concern flattr *does* have is stale **elevation/OSM** data in `graph.json`, which is a pipeline-rebuild problem, not a re-embed problem. |
| RAG / GraphRAG | not yet exercised | The graph is a routing graph, not a GraphRAG knowledge graph. No traversal feeds an LLM. |

**Be blunt:** this is the area people most want to bolt onto a maps app, and
it's the *worst* fit. flattr's retrieval is spatial and exact. Adding RAG here
would be a solution hunting for a problem.

### 04 — Agents and tool use

| Concept | Verdict | Where it would attach |
|---|---|---|
| Agents vs chains | not yet exercised | If anything, flattr is a fixed **pipeline** (overpass→osm→split→elevation→grade→build-graph). No LLM decides the next step; `pipeline/run-build.ts` does. That's the control-flow seam an agent would invert. |
| Tool calling | not yet exercised | The cleanest hypothetical: route-finding and geocoding become *tools* an agent calls. `routeSummary`, `geocode`, and the A* entrypoint are the tool boundary. |
| ReAct / tool routing / memory / error recovery | not yet exercised | No loop exists. An agent would wrap `features/routing/` + `pipeline/geocode.ts` as its hands; today those are called directly by `MapScreen.tsx`. |

Cross-link: `.aipe/study-agent-architecture/` covers the agent-loop mechanics
in depth.

### 05 — Evals and observability

| Concept | Verdict | Where it would attach |
|---|---|---|
| Eval set types / methods | not yet exercised (for LLM) — **but the deterministic analog already exists** | `bench/run.ts` is a real eval harness: it runs Dijkstra / A* / bidirectional / gradeAstar over fixed fixture pairs and prints a comparison table. An LLM-judge harness would be built *in its image*. |
| LLM-as-judge bias | not yet exercised | A "is this route description accurate?" judge would parallel the Dijkstra-vs-A* **oracle** the tests already use (Dijkstra is the ground-truth optimum A* is checked against). |
| LLM observability | not yet exercised | No token/cost/latency logging because no LLM calls. The pattern to copy is `bench/report.ts`'s table of per-run metrics. |

Cross-link: `.aipe/study-testing/` and `.aipe/study-performance-engineering/`
both walk the existing `bench/` harness and the Dijkstra oracle in detail —
that's where the eval-harness analog lives concretely.

### 06 — Production serving

| Concept | Verdict | Where it would attach |
|---|---|---|
| LLM caching / cost optimization | not yet exercised | No LLM calls to cache. flattr's caching is tile/graph caching (`mobile/src/useTileGraph.ts`), a different concern. |
| Prompt injection | not yet exercised — **but the injection vector is already in the data** | The single most important future-state security fact in this repo: OSM `display_name` strings (`pipeline/geocode.ts:27,52` and `pipeline/osm.ts` tag text) are **attacker-controllable free text**. Anyone can edit OpenStreetMap. The moment any of that text reaches a prompt (Feature D citing a street name, Feature P echoing a place label), it's a first-class prompt-injection vector. |
| Rate limiting / backpressure / retry | not yet exercised (for LLM) | flattr *does* already respect Nominatim's ~1 req/sec policy (`pipeline/geocode.ts:1-2`). That's the same discipline an LLM provider would need; the pattern transfers. |

Cross-link: `.aipe/study-security/` owns the prompt-injection-via-OSM-data
thread. This guide names the vector; that guide hardens it.

### 07 — System-design templates (interview reframes)

`not yet exercised`. The generic "tech-support chatbot" / "search ranking"
templates don't map onto a deterministic router. The honest reframe flattr
*does* support is "design a grade-aware routing service" — which is a
**systems**-design question, covered in `.aipe/study-system-design/`, not an
AI one.

### 08 — Machine learning (classical)

`not yet exercised`. No supervised pipeline, no features-from-data, no
train/val/test, no model artifacts. flattr's "cost model" (`features/routing/cost.ts`)
is a hand-written grade penalty, *not* a learned function. There is a real
future-ML idea — *learn* the comfort cost curve from user behavior instead of
hand-tuning it — but nothing in the repo touches it today.

### 09 — ML system-design templates

`not yet exercised`. No recommender, no anomaly detection, no CV. The grade
heatmap (`features/grade/classify.ts`, `zones.ts`) is deterministic
classification by threshold, not a trained classifier.

---

## What to actually read in this folder

The concern walk above is the deliverable. On top of it, two seams are
interesting enough to deserve a full `format.md`-shape concept file with a
real diagram — both heavy on Move 2.5 (current state vs future state), because
everything here is future state:

  - **`01-describe-route-llm-context-seam.md`** — the "describe my route"
    feature, anchored to `features/routing/summary.ts`. The cleanest, most
    likely first LLM call flattr would ever make.
  - **`02-nl-destination-parse-seam.md`** — the natural-language destination
    parser, anchored to `pipeline/geocode.ts` and `mobile/src/AddressBar.tsx`.
    Heuristic-first, LLM-fallback; and the place where untrusted OSM text
    first meets a prompt.

Plus the two per-codebase honesty files the spec requires:

  - **`ai-features-in-this-codebase.md`** — "there are none," stated properly.
  - **`ml-features-in-this-codebase.md`** — same, for ML.

---

## The principle to carry out of here

The most senior move in AI engineering is knowing when *not* to add it. flattr
is a deterministic algorithm with a provable optimum (A* with an admissible
heuristic, checked against a Dijkstra oracle). Bolting an LLM into the hot path
would trade that guarantee for a probabilistic one — strictly worse for the
core product. The only honest seams are at the *edges*: turning numbers into a
sentence for a human (`summary.ts`), and turning a human's fuzzy phrase into a
precise query (`geocode.ts`). Everything between those edges should stay
deterministic. Recognizing that is the lesson; the empty AI band in the
diagram above is the right design, not a gap to fill.
