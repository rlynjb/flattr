# 05 — Evals & Observability

> **The spine of this section:** flattr evals **deterministic code** with exact-match
> vitest + a `bench/` harness. **LLM evals — which flattr lacks — exist precisely
> because models are non-deterministic.** flattr lives at the bottom of the eval
> ladder (rung 1, exact-match) *because it can*; an LLM output would force it upward.
> Every file below is study material: no LLM eval is exercised here, so each names
> the honest deterministic analog already in the repo and the gap an LLM feature opens.

```
THE WHOLE SECTION IN ONE PICTURE
┌───────────────────────────────────────────────────────────────┐
│  DETERMINISTIC (flattr today)        │  NON-DETERMINISTIC (LLM)  │
│  ───────────────────────────────────┼─────────────────────────  │
│  output is the same bytes every run  │  same facts, varying bytes │
│  golden = exact expected path        │  golden = output PROPERTIES│
│  method = exact-match (.toBe)        │  method = fuzzy/rubric/judge│
│  oracle = computable (route cost)    │  no oracle → LLM-as-judge   │
│  observe = ms / nodesExpanded / cost │  observe = tokens/latency/$ │
│  ── fixtures.ts · *.test.ts · bench/ │  ── the gap flattr lacks    │
└───────────────────────────────────────────────────────────────┘
   the LEFT column is real code in this repo; the RIGHT is the
   discipline you'd adopt the moment a model entered the pipeline
```

## Files

1. **[01-eval-set-types.md](01-eval-set-types.md)** — golden / adversarial /
   regression sets. flattr's `features/routing/fixtures.ts` is golden-set-shaped
   (exact expected paths); a narration at `summary.ts:11` would need a new
   `route → expected-sentence-properties` set.

2. **[02-eval-methods.md](02-eval-methods.md)** — the ladder: exact-match → fuzzy →
   rubric → LLM-judge → pairwise → human. flattr's vitest tests are *all* exact-match
   because routing is deterministic; an LLM output forces the climb. **The cleanest
   contrast in the guide — read this one closely.**

3. **[03-llm-as-judge-bias.md](03-llm-as-judge-bias.md)** — judging output with a
   model; position / verbosity / self-preference bias. N/A here: `bench/run.ts` has an
   *objective oracle* (route `cost`), which is exactly why it needs no judge.

4. **[04-llm-observability.md](04-llm-observability.md)** — trace / tokens / latency /
   cost per call. flattr has no LLM telemetry, but `bench/report.ts` already measures
   latency + work + quality for deterministic code — the same boundary instrumentation,
   pointed at `astar()` instead of a model.

## Read order

01 → 02 → 03 → 04. File 02 carries the spine; 01 sets up the datasets it scores, 03
and 04 are the two things that change shape (grading, telemetry) once non-determinism
enters. Real seams to keep in mind throughout: output→prompt `summary.ts:11`,
input→prompt `geocode.ts:9`.
