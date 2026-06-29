# LLM Observability
### industry: *telemetry* — reference material (traces, tokens, latency, cost)

## Zoom out

```
LLM OBSERVABILITY — make every model call legible after the fact
┌──────────────────────────────────────────────────────────────┐
│  per call, log:                                                │
│    TRACE     prompt in / completion out (the actual strings)   │
│    TOKENS    prompt + completion counts                        │
│    LATENCY   wall time of the provider round-trip              │
│    COST      tokens × price → $ per call, rolled up            │
└──────────────────────────────────────────────────────────────┘
        you cannot debug, budget, or improve a call you can't see
```

Observability is the layer that turns an opaque provider call into evidence. Without
it, a bad output is unreproducible (no prompt logged), a slow app is unattributable
(no latency), and the bill is a surprise (no token accounting).

## How it works

**Move 1 — the pattern: wrap the call site, emit a structured record.**

```
INSTRUMENTED CALL SITE
   t0 = now()
   resp = await provider.complete(prompt)        ◀── the seam
   log({ prompt, completion: resp.text,
         promptTokens, completionTokens,
         ms: now()-t0, costUSD })
```

Mental model: the provider call is a *network boundary you own one side of*.
Everything you want to know later — why it said that, why it was slow, what it cost
— has to be captured *at that boundary*, because the provider won't hand it back to
you later.

**Move 2 — what to capture, step by step.**

```
THE FOUR SIGNALS
  trace    → reproduce a bad output, diff prompt versions
  tokens   → catch context bloat before it caps you
  latency  → find the call dragging p95; decide on streaming
  cost     → attribute $ per feature/user; set budgets/alerts
                 │
                 ▼ same shape as ANY perf telemetry:
                   measure at the boundary, aggregate, alert
```

**Move 3 — principle.** Telemetry lives at the boundary, not in business logic.
Whether the boundary is a provider HTTP call or an algorithm run, the discipline is
identical: time it, count its work, record its output, aggregate, and compare across
versions. LLM observability is just perf-and-trace telemetry pointed at a model call.

## In this codebase

**Not yet exercised** — flattr makes no LLM calls, so there is no token / cost /
prompt telemetry to emit. But flattr *already practices observability* for the work
it does have: it instruments its deterministic boundary.

```
flattr's observability analog (DETERMINISTIC boundary = the algorithm)
┌──────────────────────────────────────────────────────────────┐
│  bench/run.ts:24   t0 = performance.now(); … ms = now()-t0     │  LATENCY
│  bench/run.ts:48   nodesExpanded, pushes, pops                 │  "work units"
│  bench/run.ts:53   cost = result.path.cost                     │  QUALITY
│  bench/report.ts   formatTable(...) → per-algorithm comparison │  AGGREGATE
└──────────────────────────────────────────────────────────────┘
   maps 1:1 to LLM telemetry:
     ms            ↔  latency
     nodesExpanded ↔  tokens  (the "how much work" counter)
     cost          ↔  quality score
     formatTable   ↔  the dashboard row
```

`bench/run.ts` times each algorithm (`performance.now`), counts its work
(`nodesExpanded` / `pushes` / `pops` — flattr's token-equivalent: the unit of effort
spent), records output quality (`cost`), and `bench/report.ts` aggregates it into a
comparison table. That's exactly the *measure-at-the-boundary → aggregate → compare*
loop of LLM observability, applied to a pure-function boundary.

**The gap an LLM feature opens.** Add a provider call at a future `narrate.ts`
(say, wrapping `summary.ts:11`'s output into prose) and a *new* boundary appears —
the one flattr has never had: a non-deterministic, paid, network call. That's where
you'd add the signals bench/ doesn't track because it never needed them: **prompt/
completion trace** (reproduce a weird sentence), **token counts** (context cost),
and **dollar cost** (bench's `cost` is route quality, not money). The
instrumentation *pattern* is already in the repo — `bench/run.ts` is the template —
it would just point at a model call instead of `astar()`.

## See also
- `03-llm-as-judge-bias.md` — judge calls are themselves call sites worth logging
- `06-production-serving/` — where latency/cost telemetry drives serving decisions
- `bench/run.ts`, `bench/report.ts` — the deterministic measure→aggregate template
