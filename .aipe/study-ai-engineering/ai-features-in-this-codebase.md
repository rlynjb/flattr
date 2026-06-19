# AI features in this codebase

**This codebase does not currently use any LLM-powered features.**

No LLM, no embeddings, no vector store, no RAG, no agents, no prompts, no model
SDKs, no inference serving — anywhere in the repo. This is by design, not
omission: `docs/flattr-spec.md:254` states *"No LLM layer in v1,"* and §13
(`docs/flattr-spec.md:377`) lists a natural-language destination parser as
explicitly out of scope.

## How to verify (don't take my word for it)

```
  grep -rEi 'openai|anthropic|@anthropic-ai|langchain|gemini|embedding|
            vector|\bllm\b|\bprompt\b|huggingface|transformers|onnx|
            inference|rerank|\brag\b' \
    --include='*.ts' --include='*.tsx' --include='*.json' \
    --exclude-dir=node_modules --exclude-dir=.aipe .
```

Source-file hits: **none.** The only matches are `docs/flattr-spec.md` (the
line saying there's no LLM), an Android design doc listing the LLM parser as
out of scope, and a transitive substring in `mobile/package-lock.json`. Neither
`package.json` (root or `mobile/`) declares a model SDK.

## What flattr is instead

A deterministic, hand-rolled grade-aware A* routing engine in TypeScript, plus
an Expo / React Native map app. Its "intelligence" is a classical graph
search with an admissible heuristic, checked against a Dijkstra oracle — a
*proof* of optimality, not a probabilistic guess. The grade heatmap is
threshold classification (`features/grade/classify.ts`), not a learned model.

## The AI concepts are covered as study material

The seams where AI *would* attach — if the spec's out-of-scope NL features were
ever built — are mapped in:

- `00-overview.md` — every AI-engineering concern, each marked `not yet
  exercised`, each with its real would-attach file + line range.
- `01-describe-route-llm-context-seam.md` — "describe my route" data-to-text,
  off `features/routing/summary.ts`.
- `02-nl-destination-parse-seam.md` — NL destination parser, off
  `pipeline/geocode.ts` + `mobile/src/AddressBar.tsx`; also where untrusted OSM
  text would become a prompt-injection vector.

The honest takeaway: the most senior AI-engineering call here is *not* adding
AI to the correctness path. The only defensible seams are at the human-facing
edges (numbers→sentence, fuzzy phrase→query). Everything in between should stay
deterministic.
