# Agents vs Chains
### Who decides the control flow — you, or the model? (orchestration / study material)

## Zoom out

```
WHO PICKS THE NEXT STEP?
┌──────────────────────────────────────────────────────────┐
│  CHAIN     steps + order fixed by YOU (code)               │
│            input ──▶ step1 ──▶ step2 ──▶ step3 ──▶ out     │
├──────────────────────────────────────────────────────────┤
│  AGENT     steps + count picked by the MODEL at runtime    │
│            input ──▶ LLM ──▶ "do X" ──▶ obs ──▶ LLM ──▶... │
│                       ▲___________________________│ loop   │
├──────────────────────────────────────────────────────────┤
│  flattr    NEITHER — fixed pipeline + fixed algorithm      │
│            control flow is 100% code-decided, 0% model     │
└──────────────────────────────────────────────────────────┘
```

A **chain** is a directed graph of steps you wrote down: the path is known before
you run it. An **agent** hands the steering wheel to an LLM — it loops, deciding
each next action and *when to stop*. The axis that separates them is one question:
**who decides the next step.** flattr sits off this axis entirely — it's a
deterministic data pipeline plus A*, where every branch is `if`/`while` in code.

## How it works

### Move 1 — the mental model: control flow ownership

```
CHAIN                          AGENT
pipe(a, b, c)                  while(!done) { act = llm(state); ... }
└ you own the order            └ model owns the order + the stop
└ replayable, debuggable       └ variable cost, variable path
└ no surprises                 └ can adapt to surprises
```

Fast read: a chain is a recipe; an agent is a cook. A recipe never changes the
steps; a cook decides whether to add salt after tasting. Chains are cheaper to
reason about and audit. Agents buy flexibility with unpredictability.

### Move 2 — flattr's actual control flow

```
flattr's FIXED PIPELINE (build time)
osm.osm ─▶ parse ─▶ annotate grades ─▶ snap ─▶ graph.json
   each arrow is a code-decided step; no model anywhere

flattr's FIXED ALGORITHM (request time)
graph.json + start/goal ─▶ A* (features/routing/astar.ts)
   the only "loop" is the priority-queue expansion — a proven
   search, not a learned decision (see 03-react-pattern.md)
```

Step by step: there is no point where flattr asks "what should I do next?" The
build pipeline's stages are hard-wired. At request time, `geocode` runs, then the
router runs, then `routeSummary` runs. The order is in the source, not in a model's
head.

### Move 3 — the principle

Reach for a **chain** when the steps are knowable in advance (they almost always
are). Reach for an **agent** only when the step *sequence itself* depends on data
you can't see until runtime, and the cost of an LLM-in-the-loop is worth it. Most
"agent" problems are chains wearing a costume.

## In this codebase

**NOT YET EXERCISED.** flattr has no chain and no agent — it's the textbook
deterministic counterexample, which is exactly why it teaches the contrast cleanly.

The one honest seam where a *chain* (not an agent) could appear:
`features/routing/summary.ts:11` returns `{ distanceM, climbM, steepCount }`.
A 2-step chain could turn that struct into spoken narration:

```
routeSummary(...) ──▶ step1: format facts ──▶ step2: LLM phrasing ──▶ "mostly flat, one short climb"
summary.ts:11           (code)                  (single LLM call)        narration
```

That's a chain because *you* fix both steps. It would not become an agent unless
the model also chose *which* tools to call and *how many times* — and flattr never
needs that. No attach point for an agent loop; flattr is a deterministic pipeline.

## See also
- `02-tool-calling.md` — why flattr's pure functions are already tool-shaped
- `03-react-pattern.md` — A*'s loop vs an LLM reasoning loop
- `features/routing/astar.ts` — the deterministic search that owns the only loop
