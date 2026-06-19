# study-prompt-engineering — index

**Verdict: this repo has no prompts, no LLM calls, no AI layer.**
Verified by grep (`prompt`, `openai`, `anthropic`, `llm`, `completion`,
`gpt-`, `claude-`, `langchain`, `gemini`) — zero hits in application
code — and confirmed by the design spec: `docs/flattr-spec.md:254`
("No LLM layer in v1") and `:380` (the LLM destination parser is out of
scope). flattr is a deterministic grade-aware A* router.

This guide is therefore **honest and proportionate, not invented**. It
does not fabricate a prompt system. It marks every prompt-engineering
concept `not yet exercised` and names the real file:line seam where each
would attach if the spec's out-of-scope NL features get built.

## Files

| File | What it covers |
|------|----------------|
| [`00-overview.md`](00-overview.md) | The no-prompt verdict up front; the whole-system diagram with the empty LLM box; the full 13-concept inventory marked `not yet exercised`, each with its would-live-here seam; the two real seams (route summary, geocode input); the OSM injection concern. **Start here.** |
| [`01-describe-my-route-seam.md`](01-describe-my-route-seam.md) | The one seam that earns a real diagram: how `features/routing/summary.ts` output would become a prompt's context section for a "describe my route" feature. Full `format.md` template with Move 2.5 (current vs future state). |

## Reading order

1. `00-overview.md` — the verdict and the map.
2. `01-describe-my-route-seam.md` — the single future-state concept file.

That's the whole guide. One overview, one concept file. Padding 13
empty files for machinery that doesn't exist would be dishonest; if you
build either NL feature later, re-run the generator and the `not yet
exercised` rows in `00-overview.md` become real concept files.

## Cross-links

- `.aipe/study-security/` — OSM `display_name` as untrusted input;
  runtime half of prompt-injection defense.
- `.aipe/study-ai-engineering/` — model-call / serving / output-
  validation seams (`not yet exercised`).
- `.aipe/study-agent-architecture/` — reasoning/agent patterns
  (`not yet exercised`).
