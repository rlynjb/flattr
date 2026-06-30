# 05 — Evals & Observability (flattr)

How you'd *know* an AI feature works, and *see* what it did at runtime —
mapped onto a codebase that already does both for deterministic graph
math. flattr has **no LLM**: it's a hand-rolled A* router over a
grade-annotated street graph. So these files teach the concepts as study
material, then anchor honestly to flattr's real seams: its `*.test.ts`
suite, its `bench/` harness, and the `RouteSummary` output that a future
route-describe feature would consume.

## The honest framing

flattr already ships the *right* eval type for graph math:
**deterministic, exact-match** unit tests (`*.test.ts` via Vitest) plus a
**benchmark harness** (`bench/run.ts` + `bench/report.ts`). Those are a
golden set, a regression set, and span-level latency telemetry — just
not for an LLM. An LLM route-describe feature would *add* new eval types
(rubric, LLM-as-judge) and new telemetry (tokens, cost, replay) layered
onto the existing harness. The seam everything hangs off is
`features/routing/summary.ts:5` — `RouteSummary = {distanceM, climbM,
steepCount}` — the deterministic output that prose would be built from.

## The four files

```
  01-eval-set-types.md      golden / adversarial / regression;
                            flattr's *.test.ts ARE golden+regression for
                            graph math; describe adds a rubric set
  02-eval-methods.md        exact-match = flattr's tests today;
                            rubric / LLM-judge added for prose
  03-llm-as-judge-bias.md   N/A today; applies when scoring describe prose
  04-llm-observability.md   traces/spans/replay; bench/report.ts is the
                            deterministic analog of router latency
```

## Reading order

1. **`01-eval-set-types.md`** — *what* you collect to eval. flattr's two
   existing sets, the one it's missing.
2. **`02-eval-methods.md`** — *how* you score each set. Why exact-match is
   the strongest method flattr can use.
3. **`03-llm-as-judge-bias.md`** — what breaks when the scorer is itself a
   model. Not present today; the `RouteSummary` ground truth keeps a
   future judge honest.
4. **`04-llm-observability.md`** — *seeing* the run. `bench/` as the
   deterministic telemetry flattr already ships.

## Cross-links

- **`../06-production-serving/`** — serving the feature these evals would
  guard (caching, rate limits, retries on the real geocode/elevation
  calls).
- **`../06-production-serving/03-prompt-injection.md`** — the adversarial
  inputs (hostile OSM `display_name`) the eval sets must include.
- Sibling guides under `.aipe/`: `study-testing` (the `*.test.ts` suite
  as a test *and* an eval seam), `study-debugging-observability` (the
  router's self-instrumenting counters).
