# study-ai-engineering — flattr

AI engineering + ML study guide, generated against the **flattr** repo
(grade-aware self-powered routing: hand-rolled A* over a grade-annotated
street graph, plus an Expo/React Native map app).

## Read this first

**flattr has no AI and no ML.** No LLM, no embeddings, no vector store,
no RAG, no trained model, no inference runtime. The dependency tree is
`tsx` / `typescript` / `vitest` (engine) and `maplibre-react-native` /
`expo` / `react-native` (mobile). Nothing else. The grep for
`openai|anthropic|langchain|embedding|llm|gpt-|claude-|rag|mediapipe|onnx`
returns zero real hits — the only `vector` in the tree is MapLibre's
*vector tiles*, which is cartography, not ML.

So this guide does two things, and only these two:

1. **States honestly what AI/ML work the repo does NOT contain.** That's
   the job of [`ai-features-in-this-codebase.md`](ai-features-in-this-codebase.md)
   and [`ml-features-in-this-codebase.md`](ml-features-in-this-codebase.md).
   Read those two first — they are the load-bearing files.

2. **Maps the concrete seams where AI *would* attach**, anchored to real
   flattr files with `file:line` grounding. There are exactly three worth
   naming, and they're covered in the honesty files and revisited in the
   concept sub-sections:
   - **output→prompt seam** — `features/routing/summary.ts:11`
     (`routeSummary` → a "describe my route" LLM call)
   - **input→prompt seam** — `pipeline/geocode.ts:9` (`geocode` →
     natural-language destination parsing)
   - **injection vector** — OSM `display_name` flows untrusted into any
     future prompt (`pipeline/geocode.ts:27`, `:52`, `:69`)

The numbered sub-section directories below teach the AI/ML *concepts* as
study material. Every concept's "in this codebase" block says
**not yet exercised** and points at the attachment seam. The concepts are
real; flattr's use of them is zero. Both halves are stated without flinching.

## Reading order

```
1. ai-features-in-this-codebase.md   ← what AI flattr does NOT do + the 3 seams
2. ml-features-in-this-codebase.md   ← what ML flattr does NOT do + where it'd attach
3. 00-overview.md                    ← the whole map in one diagram
4. 01-llm-foundations/ … 09-…/       ← concepts as study material (all "not yet exercised")
```

## Sub-sections

| dir | topic | flattr status |
|-----|-------|---------------|
| `01-llm-foundations/` | what an LLM is, tokens, sampling, structured output, streaming, cost, heuristic-before-LLM, provider abstraction, override locks | not exercised |
| `02-context-and-prompts/` | context window, lost-in-the-middle, prompt chaining | not exercised |
| `03-retrieval-and-rag/` | embeddings, chunking, vector DBs, hybrid, rerank, RAG, GraphRAG | not exercised |
| `04-agents-and-tool-use/` | agents vs chains, tool calling, ReAct, routing, memory, recovery | not exercised |
| `05-evals-and-observability/` | eval sets, eval methods, LLM-as-judge, observability | not exercised |
| `06-production-serving/` | caching, cost optimization, prompt injection, rate limiting, retry | not exercised (injection seam is real) |
| `07-system-design-templates/` | search/ranking, support chatbot — interview reframes | n/a |
| `08-machine-learning/` | supervised pipeline, features, train/val/test, on-device inference, drift, retraining | not exercised |
| `09-ml-system-design-templates/` | recommender, anomaly detection, object detection | n/a |

## Cross-links to sibling guides

flattr's real engineering is graphs, routing, and a build pipeline — not AI.
For the substance, read these siblings:

- `study-dsa-foundations/` — the A*, binary heap, bidirectional search that
  are the actual point of this repo
- `study-system-design/` — build-time pipeline → static `graph.json` → mobile reader
- `study-runtime-systems/`, `study-performance-engineering/` — the routing hot path
- `study-networking/`, `study-security/` — the Nominatim/Overpass/Open-Meteo
  HTTP boundaries (where the `display_name` injection vector also lives)
- `study-prompt-engineering/`, `study-agent-architecture/` — the AI siblings;
  same conclusion (no AI here), same seams referenced
- `study-data-modeling/`, `study-database-systems/`, `study-software-design/`,
  `study-frontend-engineering/`, `study-testing/`,
  `study-debugging-observability/`, `study-distributed-systems/` — round out
  the repo
