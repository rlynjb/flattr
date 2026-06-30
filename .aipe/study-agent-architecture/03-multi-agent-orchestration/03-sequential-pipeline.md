# Sequential / pipeline

**Industry names:** sequential agents · agent pipeline. **Type:** Industry
standard. **In this codebase:** the *no-LLM cousin* is real — `pipeline/`
is a fixed chain of single-purpose stages. The agent version (each stage a
model) is **Not yet implemented**.

> Output of one agent feeds the next. This is the topology with the
> cleanest flattr anchor: `pipeline/` already IS a sequential pipeline of
> single-purpose stages — just with functions where an agent system has
> agents.

---

## Zoom out, then zoom in

**Zoom out — the topology (Move 1 shape):**

```
  ┌─────────┐   draft   ┌─────────┐  reviewed  ┌─────────┐
  │ Agent A │ ────────► │ Agent B │ ─────────► │ Agent C │
  │ (write) │           │ (edit)  │            │ (format)│
  └─────────┘           └─────────┘            └─────────┘
```

**Zoom in.** Each stage transforms its input and hands off. It's a
`.then()` chain of single-purpose functions — except each function is an
agent. Isolated failures (you know which stage broke), a cheaper model on
early stages — at the cost of latency = sum of all stages (no parallelism).

---

## How it works

### Move 1 — the mental model

You've shipped this exact shape *without LLMs*: flattr's build pipeline.

```
  flattr's pipeline/ — a sequential pipeline of pure stages

  ┌────────┐ ways  ┌──────────┐ +elev ┌───────┐ segs ┌───────┐ +grade ┌────────────┐
  │overpass│ ────► │elevation │ ────►  │ split │ ───► │ grade │ ─────► │build-graph │
  │  .ts   │       │   .ts    │        │  .ts  │      │  .ts  │        │    .ts     │
  └────────┘       └──────────┘        └───────┘      └───────┘        └─────┬──────┘
                                                                             │ writes
                                                                  graph.json (artifact)
```

Same topology as the agent diagram — each stage single-purpose, output
feeds the next, run by `run-build.ts` in fixed order.

### Move 2 — what stays, what changes if stages became agents

The structure is identical; only the stage *internals* differ. flattr's
stages are deterministic functions. An agent pipeline's stages are model
loops. Everything else transfers:

```
  same in both                        differs
  ────────────                        ───────
  fixed order (engineer-written)      stage internals: function vs agent
  isolated failures (know the stage)  failure recovery: propagate vs re-run
  cheaper early stages                cheaper model on early agents
  latency = sum of stages             same — sequential, no parallelism
```

flattr's failure handling is "propagate" (the Open-Meteo 429 caveat — a
stage fails, the build stops). An agent pipeline would add per-stage
retry. The latency cost is identical: both are sequential, so total time
is the sum — which is exactly why the *next* file
(`04-parallel-fan-out.md`) exists, for when stages are independent.

### Move 3 — the principle

A pipeline buys isolated, debuggable failures and cheap early stages,
paying sum-of-stages latency. flattr proves the topology works without any
model — the agent version just swaps deterministic stages for model loops,
keeping the same fixed order and the same latency cost.

---

## Interview defense

**Q: Has flattr shipped a pipeline topology?**

Yes — `pipeline/` is a sequential pipeline of single-purpose stages
(`overpass→elevation→split→grade→build-graph`), run in fixed order by
`run-build.ts`, output of each feeding the next. It's the agent-pipeline
topology with deterministic functions instead of agents. The agent version
swaps stage internals for model loops; the fixed order, the isolated
failures, and the sum-of-stages latency all stay.

Anchor: *"flattr's `pipeline/` is a sequential pipeline of pure stages —
the agent version is the same chain with a model in each stage."*

---

## See also

- `02-supervisor-worker.md` · `04-parallel-fan-out.md`
- `../01-reasoning-patterns/01-chains-vs-agents.md` ·
  `../01-reasoning-patterns/04-plan-and-execute.md`
- Sibling guide `study-system-design` — the `pipeline/` build chain in full.
