# 02 — Context and prompts

flattr runs no LLM, so it has no prompts and no context to manage. These
files teach the concepts as study material, then anchor each to flattr's
two real LLM seams: the **input seam** (`geocode`, `MapScreen.tsx:82/182`)
and the **output seam** (route-describe, `MapScreen.tsx:368`). The
recurring honest point: flattr's "context" is a typed struct
(`RouteSummary`), not a window of documents — which is exactly why the
window-management problems below never fire here.

## Files

- [01-context-window.md](01-context-window.md) — the finite token
  container. flattr's would-be prompt is tens of tokens with no history
  and no corpus, so there's nothing to budget — its context is a struct,
  not a window.
- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — positional
  attention bias in long context. N/A to flattr, but its mitigation
  principle ("surface the few relevant items") is already how
  `routeSummary()` shows `steepCount` instead of every edge.
- [03-prompt-chaining.md](03-prompt-chaining.md) — multi-step LLM
  pipelines. flattr's build pipeline is a *deterministic* chain; the one
  place an LLM chain would attach is the NL-parse step in front of
  `geocode()`.

## Reading order

Self-contained per concept. If reading straight through: context-window
(why there's no budget problem) → lost-in-the-middle (the "few not many"
instinct) → prompt-chaining (the input seam where an LLM would attach).
