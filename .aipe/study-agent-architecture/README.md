# Agent architecture — study guide for flattr

**Honest verdict: this repo has no LLM agent.** No reasoning loop, no
tool-calling, no multi-agent orchestration, no AI layer at all. The
"intelligence" is a deterministic hand-rolled **A\* graph search**
(`features/routing/astar.ts`), not an agent. The spec says so: *"No LLM layer
in v1"* (`docs/flattr-spec.md` §8, line 254); the NL/agent features are out of
scope (§13, line 380).

So every agent-architecture concept is **`not yet exercised`**, and this guide
is proportionate to that — an honest overview plus two focused files where a
real diagram earns its place. No padded concept tree for machinery that doesn't
exist.

## Reading order

1. **[`00-overview.md`](00-overview.md)** — the no-agent verdict and the full
   `not yet exercised` inventory (every agent-architecture concern, each paired
   with the real file + line range where it *would* attach if the out-of-scope
   NL/agent features were built).
2. **[`01-control-loop-contrast.md`](01-control-loop-contrast.md)** — the one
   diagram worth drawing: **code decides next step** (the A\* loop) vs **model
   decides next step** (an agent loop). Same skeleton, opposite control axis. A
   teaching *contrast* — explicitly **not** a claim that A\* is an agent.
3. **[`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md)** —
   the single real future seam: a "describe my route" / NL-destination feature
   where a tool-calling agent wraps the existing router as a **tool**, consuming
   `features/routing/summary.ts` and feeding `pipeline/geocode.ts` /
   `mobile/src/AddressBar.tsx`. Includes the tool/injection risk cross-link.

## Cross-links

- `.aipe/study-dsa-foundations/` — A\*, priority queues, admissible heuristics
  (the deterministic side of the control-loop contrast).
- `.aipe/study-system-design/` — the chain-shaped engine pipeline.
- `.aipe/study-security/` — the prompt-injection trust boundary the
  router-as-tool seam would open.
- `.aipe/study-ai-engineering/`, `.aipe/study-prompt-engineering/` — single-LLM
  and prompt mechanics if an AI layer is ever added (sibling folders, not yet
  generated).
