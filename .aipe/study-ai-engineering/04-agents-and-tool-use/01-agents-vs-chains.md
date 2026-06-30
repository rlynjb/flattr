# Agents vs chains — flattr's pipeline is a fixed chain, not an agent

**Industry name(s):** agent (autonomous loop) vs chain (fixed pipeline).
**Type:** Industry standard.

## Zoom out — flattr's route flow is a deterministic chain; no loop, no LLM deciding steps

An agent loops — the LLM decides which step runs next and how many steps
to take. A chain is fixed — *you* define the steps and they run in order.
flattr's route flow is the second, and not even an LLM chain: it's a
deterministic pipeline. Tap or type → geocode → snap to nearest node →
A* → summary → render. The number of steps is constant, the order is
hardcoded, and nothing decides at runtime to do something different.

```
  Zoom out — flattr's route flow is a fixed pipeline

  ┌─ UI (mobile/) ──────────────────────────────────────────┐
  │  tap/type ──► geocode ──► nearestNode ──► render          │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ engine (features/routing/) ▼ ───────────────────────────┐
  │  directedAstar ──► routeSummary ──► RouteSummary          │ MapScreen.tsx:155-159
  │  ★ fixed order, fixed step count — a CHAIN, not an agent  │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** UI input → geocode/nearest → A* → summary → UI render.
- **Axis — who decides what runs next?** In an agent: the LLM, per step,
  unpredictably. In flattr: the *code*, statically — the call sequence is
  written out in `MapScreen.tsx`. Trace "who controls the next step" and
  the answer is "the source code" at every layer. It never flips to a
  model, because there is no model.
- **Seam:** there is no agent-loop seam. The closest decision point is the
  grade `penalty` (`cost.ts:16`) influencing *which path* A* picks — but
  that's a deterministic cost function, not a step-selection loop.

## How it works

### Move 1 — the mental model

You know the difference between a build script and a REPL. A build script
runs fixed steps in order — compile, bundle, write — every time, same
sequence. A REPL loops: read input, decide what to do, maybe loop again,
unbounded. A chain is the build script; an agent is the REPL with an LLM
at the prompt. flattr is the build script: a straight line of steps with a
known length.

```
  Pattern — chain (fixed) vs agent (loop)

  CHAIN (flattr):   input → step1 → step2 → step3 → output
                    YOU define steps · fixed count · deterministic

  AGENT:            input → [thought → action → observation] → ... → output
                    LLM picks each step · unbounded count · needs a stop budget
```

### Move 2 — the walkthrough

**flattr's chain, written out as code.** `MapScreen.tsx:155–159`:

```ts
const r = directedAstar(graph, startId, endId, userMax);   // step: route
if (!r.path) return { fc: null, summary: null, found: false };
return {
  fc: routeToGeoJSON(graph, r.path, userMax),              // step: shape for map
  summary: routeSummary(graph, r.path, userMax),           // step: summarize
  found: true,
};
```

And the inputs are produced by an equally fixed sequence:
`nearestNode(graph, startPt)` / `nearestNode(graph, endPt)`
(`MapScreen.tsx:133–134`), themselves fed by `geocode`
(`MapScreen.tsx:182/189`). The steps are *literally lines of code in a
fixed order*. No step inspects a result and decides to take a different
next step; the only branch is the early return when there's no path.

```
  Layers-and-hops — the fixed route chain (no loop)

  ┌─ UI ──────┐ geocode → nearestNode      ┌─ engine ──────────┐
  │MapScreen  │ ──────────────────────────►│ directedAstar      │ :155
  │           │                            │ → routeSummary     │ :159
  │           │ ◄──────────────────────────│ → render           │
  └───────────┘  fixed order, fixed count  └────────────────────┘
        no thought→action→observation loop anywhere
```

**The boundary — what would make it an agent (it isn't one).** An agent
needs an LLM that, at runtime, picks the next tool from a set and loops
until it decides to stop — with a hard iteration budget so it can't loop
forever. flattr has none of that: no LLM, no tool set to choose from, no
loop, no budget, because none is needed. If anything were ever added, the
honest description is a 2-step *chain* — NL-parse → geocode → route — not
an agent loop. The parse step would *prepare* input; it would not *decide*
the pipeline.

### Move 3 — the principle

Reach for an agent only when the steps genuinely depend on what the model
discovers mid-task — otherwise a chain is simpler, cheaper, and far easier
to debug. flattr's steps are knowable in advance (geocode, route,
summarize), so a fixed chain is correct and an agent would add
nondeterminism for nothing. The principle: agents buy flexibility at the
cost of predictability; don't pay it when the pipeline is already known.

## Primary diagram

```
  flattr is a fixed chain — every step known in advance

  ┌─ UI (mobile/) ───────────────────────────────────────────┐
  │ geocode (geocode.ts:9) → nearestNode (nearest.ts:5)       │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ engine ───────────────────▼─────────────────────────────┐
  │ directedAstar [:155] → routeSummary [:159] → render        │
  │ deterministic · fixed count · no LLM deciding next step    │
  └──────────────────────────────────────────────────────────┘
   (an added NL-parse step = a 2-step CHAIN, still not an agent)
```

## Elaborate

The agent-vs-chain distinction is the first fork in any "should I use an
LLM here" decision, and most production "agents" are really chains with
good prompts. flattr is a clean teaching case for the chain side: a fully
deterministic pipeline where every step is a function call in a fixed
order. The transferable judgment is resisting the agent reflex — flattr's
route flow has no step whose existence depends on a model's runtime
decision, so it stays a chain.

## Project exercises

### B-CHAIN.2 — keep the route flow a chain when adding NL parse

- **Exercise ID:** B-CHAIN.2
- **What to build:** if/when NL destination parsing is added, structure it
  as a fixed 2-step chain (parse → geocode → route), explicitly *not* an
  agent loop — the LLM prepares input, it does not select steps.
- **Why it earns its place:** it forces the agent-vs-chain decision to be
  made deliberately and on the chain side, where flattr belongs.
- **Files to touch:** new `pipeline/parse-destination.ts`;
  `mobile/src/MapScreen.tsx:182/189` (call parse before geocode, no loop).
- **Done when:** the added step runs exactly once per route, in fixed
  order, with no runtime step-selection.
- **Estimated effort:** half a day with a stub model.

## Interview defense

**Q: Is flattr's route pipeline an agent?** Answer: no — it's a fixed
chain, and not even an LLM one. The steps are hardcoded in
`MapScreen.tsx`: geocode → nearestNode (`:133–134`) → directedAstar
(`:155`) → routeSummary (`:159`) → render, in fixed order with a constant
step count. An agent loops with an LLM choosing the next step; flattr's
code chooses every step statically. If NL search were added, it'd be a
2-step chain (parse → geocode → route), still not an agent. Load-bearing
point: an agent needs runtime step-selection *and* a stop budget — flattr
has neither because it needs neither.

```
  geocode → route → summarize (fixed order) = chain ≠ thought→action loop
```

Anchor: *"flattr's route flow is a deterministic chain — the code picks
every step; nothing loops and no model decides what runs next."*

## See also

- [02-tool-calling.md](02-tool-calling.md) — what geocode/route would be *as* tools, if an agent existed.
- [04-tool-routing.md](04-tool-routing.md) — flattr's routing is all heuristic.
- [06-error-recovery.md](06-error-recovery.md) — flattr's deterministic error-shape discipline.
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the NL-parse chain at the input seam.
