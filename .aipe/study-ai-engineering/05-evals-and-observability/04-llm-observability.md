# LLM observability — traces, spans, replay

**Industry name(s):** LLM observability / tracing / span-level telemetry.
**Type:** Industry standard (study material). **Not present in flattr.**

## Zoom out — flattr already measures its hot path: `bench/report.ts`

You've shipped the deterministic analog of LLM observability. flattr's
`bench/run.ts` + `bench/report.ts` instrument the router's *latency and
work* — milliseconds, nodes expanded, queue pushes/pops — per algorithm,
per input pair. That's the same instinct as LLM tracing (measure each
call, compare runs, catch regressions), applied to graph math instead of
model calls. What flattr does **not** have is an LLM call to trace — no
token counts, no cost-per-call, no prompt/response replay — because there
is no model. LLM telemetry attaches the day a route-describe call exists.

```
  Zoom out — flattr's telemetry vs LLM telemetry

  ┌─ Router (deterministic) ────────────────────────────────┐
  │  directedAstar() — nodesExpanded, pushes, pops          │
  └────────────────────────────┬─────────────────────────────┘
                  measured by ▼
  ┌─ bench/ telemetry (TODAY) ──────────────────────────────┐
  │  run.ts times each pair → report.ts formats a table     │
  │  ms · expanded · pushes · pops · cost                   │
  └────────────────────────────┬─────────────────────────────┘
                  ★ no LLM call → no span/token/cost telemetry
  ┌─ (future) describe call ───▼─────────────────────────────┐
  │  trace: prompt, tokens, latency, cost, response, replay │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** router → `bench/` telemetry → (future) LLM telemetry.
- **Axis — what's observed:** flattr observes *deterministic work*
  (expansions, ms) — reproducible, so a single run is authoritative. LLM
  observability observes *non-deterministic calls* (tokens, cost,
  variable latency) — so you need many traces and aggregates, not one
  run.
- **Seam:** `bench/run.ts:23` (`time(fn)`) wraps a call and records its
  duration — that's a span. An LLM span would wrap the future describe
  call the same way, but also capture prompt, response, token counts, and
  cost, which `time()` doesn't.

## How it works

### Move 1 — the mental model

Observability is "after the fact, can I see what happened?" A **span** is
one timed unit of work (a function call, a model call) with attributes. A
**trace** is the tree of spans for one request. **Replay** is keeping the
inputs/outputs so you can re-run a past call. flattr has spans (timed
algorithm runs) and a comparison report; it lacks the LLM-specific
attributes (tokens, cost) and replay, because nothing non-deterministic
runs.

```
  Pattern — span attributes: what flattr has vs what an LLM adds

  flattr span (bench)        LLM span (future)
  ┌──────────────────┐       ┌──────────────────────┐
  │ name: algorithm  │       │ name: describe       │
  │ ms               │       │ ms (variable)        │
  │ nodesExpanded    │  +→   │ prompt tokens        │
  │ pushes / pops    │       │ completion tokens    │
  │ cost (route)     │       │ cost ($ per call)    │
  │                  │       │ prompt + response    │ ← replay
  └──────────────────┘       └──────────────────────┘
```

### Move 2 — the walkthrough

**flattr's span — `time()` in `bench/run.ts`.** Each algorithm run is
wrapped and timed:

```ts
// bench/run.ts:23 — a span: wrap a call, record duration
function time(fn: () => SearchResult): { result: SearchResult; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}
```

The `SearchResult` already carries `nodesExpanded`, `pushes`, `pops` —
the router *self-instruments*, exposing its internal work as span
attributes. That's deeper telemetry than most LLM apps bother with.

**flattr's report — `bench/report.ts`.** `formatTable` lines up the
spans across algorithms into one comparison:

```ts
// bench/report.ts:2 — the span schema, made explicit
export type BenchRow = {
  algorithm: string; nodesExpanded: number; pushes: number;
  pops: number; ms: number; cost: number;
};
```

Compare runs, catch a regression (an algorithm change blows up
`nodesExpanded`) — exactly what an LLM dashboard does for latency/cost
drift, minus the model.

**Where LLM telemetry would attach.** A future describe call would be a
new span on the same `time()` pattern, but its attributes are different:
prompt text, token counts, dollar cost, and the *response* (kept for
replay, because the call is non-deterministic and you can't re-derive its
output). `BenchRow` would gain `promptTokens`, `costUsd`, `responseHash`.

### Move 3 — the principle

Observability means making the work *legible after it ran*. flattr
already does this for its deterministic hot path — the router exposes its
own counters and `bench/` aggregates them. The LLM version is the same
pattern with two additions forced by non-determinism: cost/token
attributes (because calls aren't free) and replay (because you can't
re-derive a model's output). The pattern transfers; the attributes grow.

## Primary diagram

```
  Telemetry pattern — flattr today, LLM tomorrow

  ┌─ bench/run.ts:23  time(fn) ─────────────────────────────┐
  │   span: { ms, nodesExpanded, pushes, pops, cost }       │
  │        │ aggregated by                                   │
  │        ▼                                                 │
  │   bench/report.ts  formatTable → comparison table        │
  └────────────────────────────┬─────────────────────────────┘
              same wrap, new attributes ▼ (future)
  ┌─ describe call span ────────────────────────────────────┐
  │   span: { ms, promptTokens, completionTokens, costUsd,  │
  │           prompt, response }  ← replay-able              │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The one thing flattr's deterministic telemetry *can't* prepare you for is
**replay**, and it's the most useful LLM-observability feature. Because a
model call is non-deterministic, the only way to debug a bad
route-describe output later is to have kept the exact prompt and
response. flattr never needs this — re-running `directedAstar` with the
same inputs reproduces the path bit-for-bit, so it stores nothing. The
mental shift when adding an LLM: outputs become *data you must capture*,
not *results you can recompute*.

## Project exercises

### B5-OBS.1 — extend the span schema for a describe call

- **Exercise ID:** B5-OBS.1
- **What to build:** widen `BenchRow` (or a sibling type) with
  `promptTokens`, `completionTokens`, `costUsd`, and a `responseHash`,
  and have `formatTable` render them.
- **Why it earns its place:** it makes the LLM-telemetry shape concrete
  on top of flattr's existing report harness.
- **Files to touch:** `bench/report.ts` (extend `BenchRow` +
  `formatTable`), `bench/report.test.ts`.
- **Done when:** a row with token/cost fields renders in the table and
  the existing test still passes.
- **Estimated effort:** 1–2 hrs.

### B5-OBS.2 — replay capture for non-deterministic calls

- **Exercise ID:** B5-OBS.2
- **What to build:** a thin wrapper that, given a (future) describe call,
  records `{input: RouteSummary, prompt, response}` to disk so a past
  call can be re-inspected.
- **Why it earns its place:** it introduces the one telemetry concept
  flattr's deterministic engine never needed — replay.
- **Files to touch:** new `features/routing/describe.trace.ts`, reuse
  `RouteSummary` from `summary.ts:5`.
- **Done when:** running a describe call leaves a re-readable trace file
  keyed by the `RouteSummary` input.
- **Estimated effort:** 2 hrs (depends on a describe feature existing).

## Interview defense

**Q: does flattr have observability?** Answer: for its deterministic hot
path, yes. `bench/run.ts`'s `time()` is a span — it wraps each algorithm
call and records `ms` plus the router's self-reported `nodesExpanded`,
`pushes`, `pops`, and `bench/report.ts` aggregates them into a comparison
table to catch regressions. That's the same instinct as LLM tracing.
What's missing is LLM-specific telemetry — token counts, cost-per-call,
and replay — because there's no model call to trace. It'd attach as a new
span on the same `time()` pattern. Load-bearing point: the tracing
pattern is identical; non-determinism is what forces the extra
cost/token attributes and replay capture.

```
  deterministic span: ms + counters (recompute to debug)
  LLM span: + tokens + cost + saved response (replay to debug)
```

Anchor: *"flattr already traces the work that matters — the router. The
LLM-only parts (cost, replay) wait for a call that doesn't exist yet."*

## See also

- [01-eval-set-types.md](01-eval-set-types.md) — the sets an eval run would observe.
- [02-eval-methods.md](02-eval-methods.md) — exact-match runs are the cheapest thing to observe.
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — judge calls also need tracing.
- [../06-production-serving/01-llm-caching.md](../06-production-serving/01-llm-caching.md) — cache hits/misses are a key span attribute.
