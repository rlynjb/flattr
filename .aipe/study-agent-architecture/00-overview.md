# Agent architecture — overview

> **Verdict up front: this repo has no LLM agent.** No reasoning loop, no
> tool-calling, no multi-agent orchestration, no AI layer at all. The
> "intelligence" here is a deterministic, hand-rolled **A\* graph search**
> (`features/routing/astar.ts`) — classical shortest-path, not an agent. The
> design spec says so explicitly: *"No LLM layer in v1"*
> (`docs/flattr-spec.md` §8, line 254), and the natural-language features that
> *would* introduce an agent are named out of scope: *"the LLM destination
> parser. All later."* (§13, line 380).
>
> So the honest state of every agent-architecture concept in this guide is
> **`not yet exercised`.** This overview tells you that plainly, then — for
> each concept — names the one real file and line range where it *would*
> attach if the spec's out-of-scope NL/agent features were ever built. That
> "would attach here" map is the genuine teaching value: it's how you reason
> about where an agent layer bolts onto a system that doesn't have one yet.

---

## Zoom out — where an agent *would* live (and doesn't)

The whole system today is two halves with a static artifact between them: a
build-time pipeline that bakes a grade-annotated street graph into
`mobile/assets/graph.json`, and a runtime that searches that graph with A\*
and draws the result. There is no model in any band.

```
  Zoom out — the flattr system as built (no agent anywhere)

  ┌─ UI layer (Expo / React Native) ─────────────────────────────┐
  │  AddressBar.tsx   GradeSlider.tsx   MapScreen.tsx             │
  │  text input   →   geocodeSuggest()  →  route request          │
  └───────────────────────────┬───────────────────────────────────┘
                              │  (start, goal, userMax)
  ┌─ Engine layer (pure TS, deterministic) ──────▼───────────────┐
  │  pipeline/geocode.ts   →   features/routing/astar.ts          │
  │  Nominatim lookup          ★ A* search loop ★  ← CODE decides │
  │                            features/routing/summary.ts        │
  └───────────────────────────┬───────────────────────────────────┘
                              │  reads (never writes)
  ┌─ Data layer (static) ─────▼───────────────────────────────────┐
  │  mobile/assets/graph.json  (prebuilt graph, no DB, no model)   │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Provider layer — DOES NOT EXIST ────────────────────────────┐
  │  [planned, gated]  no OpenAI / Anthropic / any LLM provider   │
  │  spec §8: "No LLM layer in v1"                                 │
  └───────────────────────────────────────────────────────────────┘
```

The star sits on the A\* loop, not on an agent, because the A\* loop is the
thing in this codebase that *decides what to do next* — and it decides by
deterministic code, not by a model. That distinction is the one piece of
agent-architecture intuition this repo can teach honestly, by contrast. It's
walked in [`01-control-loop-contrast.md`](01-control-loop-contrast.md): **a
fixed control loop where code decides every expansion** is the precise
opposite of an agent loop where a model decides every step. Same skeleton
shape (loop, frontier, accumulate, terminate), opposite control axis.

## Zoom in — what "agent architecture" would mean here

Agent architecture is everything above one LLM call: reasoning patterns
(ReAct, plan-and-execute, reflexion, tree-of-thoughts), agentic retrieval
(a retrieval *loop* the model drives), multi-agent topologies (supervisor-
worker, pipeline, fan-out, debate, swarm, graph), and the cross-cutting
infrastructure (the agent control loop with its hard iteration budget, tool
calling / MCP, agent memory tiers, context engineering, guardrails, agent
evals). **None of it exists here.** There is exactly one place where an agent
could ever attach — a future "describe my route" or natural-language
destination feature — and that single seam is walked in
[`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md): the
existing router becomes a **tool** an LLM agent calls.

---

## The concept inventory — `not yet exercised`, with the real would-attach seam

This is the honest audit. Every agent-architecture concern from the generator
spec, marked `not yet exercised`, each paired with the concrete file + line
range where it would attach if the out-of-scope NL/agent features were built.
No file is invented for machinery that does not exist.

### Reasoning patterns (SECTION A)

| Concept | State | Would attach at |
| --- | --- | --- |
| Chains vs agents (the boundary) | `not yet exercised` | The whole engine is a **chain** today: `pipeline/geocode.ts` → `features/routing/astar.ts:22` `search()` → `features/routing/summary.ts:11` `routeSummary()`. The engineer wrote every step; nothing chooses the next. An *agent* would replace the fixed call order with a model-driven loop. The boundary itself is the lesson — see [`01-control-loop-contrast.md`](01-control-loop-contrast.md). |
| The agent loop skeleton (step · execute · accumulate · **terminate**) | `not yet exercised` | There is no agent loop. The *closest structural analog* is the A\* `while (!open.isEmpty())` loop at `features/routing/astar.ts:48-76` — same four-part skeleton (expand · relax · accumulate `g`/`came` · terminate on goal-or-empty-frontier), but **code** is the step function, not a model. The contrast is the teaching value; it is **not** an agent. |
| ReAct (reason → act → observe) | `not yet exercised` | A model deciding "geocode this", "search that corridor", "re-route" would sit between `mobile/src/AddressBar.tsx:29` (the request) and `features/routing/astar.ts:22` (the tool). Today that decision is hard-wired in `MapScreen.tsx`. |
| Plan-and-execute | `not yet exercised` | A multi-stop NL request ("route me flat from A to B avoiding the hill, then to C") would need a plan phase before the per-leg `search()` calls at `features/routing/astar.ts:22`. No planner exists. |
| Reflexion / self-critique | `not yet exercised` | Would wrap the route result from `features/routing/summary.ts:11` ("is this actually flat enough? re-route with lower `userMax`"). Today `steepCount` is computed deterministically (`summary.ts:19`) and shown, never critiqued by a model. |
| Tree of Thoughts | `not yet exercised` | No branch-and-score reasoning. The repo already explores alternatives *deterministically* — `bench/` runs Dijkstra → A\* → directed → bidirectional as fixed stages (`features/routing/astar.ts:135-163`), which is the opposite of model-scored branching. |
| Routing (pick the handler) | `not yet exercised` | An intent router ("is this an address, a place, or a free-text route description?") would sit in front of `pipeline/geocode.ts:9` `geocode()` / `:31` `geocodeSuggest()`. Today the field is always treated as an address string. |

### Agentic retrieval (SECTION B)

| Concept | State | Would attach at |
| --- | --- | --- |
| Agentic RAG (retrieval as a loop) | `not yet exercised` | No embeddings, no vector store, no retrieval loop. The only "retrieval" is a single Nominatim lookup (`pipeline/geocode.ts:21`) and a static `graph.json` read — both one-shot, neither model-driven. |
| Self-corrective RAG | `not yet exercised` | Would grade geocode results before routing — e.g. "did Nominatim return the place the user meant?" against `pipeline/geocode.ts:25-27`. Today the first result wins, no grader. |
| Retrieval routing (which source?) | `not yet exercised` | Would route between the address store (Nominatim), the graph (`mobile/assets/graph.json`), and live search. Today there is exactly one source per query type; nothing to route between. |

### Multi-agent orchestration (SECTION C)

| Concept | State | Would attach at |
| --- | --- | --- |
| When **not** to go multi-agent | `not yet exercised` | The correct answer for this repo is emphatic: **do not.** A grade-aware shortest-path query is a single deterministic computation (`features/routing/astar.ts:22`). It is not decomposable into independent agent specialties. This is the senior-grade "I considered it and chose not to" answer in its purest form. |
| Supervisor-worker | `not yet exercised` | Would only appear if a future NL feature fanned one request across multiple routers/sources. No supervisor, no workers exist. |
| Sequential pipeline | `not yet exercised` | The deterministic engine *is* a sequential pipeline (`geocode` → `search` → `summary`), but the stages are **functions, not agents**. Calling that "multi-agent" would be dishonest. |
| Parallel fan-out / fan-in | `not yet exercised` | The viewport graph build already fans out tile fetches deterministically (`mobile/src/useTileGraph.ts`), but with no agents — it's `Promise`-style concurrency over data, not over reasoning agents. |
| Debate / verifier-critic | `not yet exercised` | No producer/critic agents. The closest deterministic analog is `bench/` comparing algorithm stages — code comparing code, not agents critiquing each other. |
| Swarm / handoff | `not yet exercised` | No peer agents to hand control between. |
| Graph orchestration (state machine) | `not yet exercised` | If an NL workflow ever needed checkpointed, human-in-the-loop stages, it would wrap the engine calls — but today control flow is plain function calls in `MapScreen.tsx`, not a checkpointed graph. |
| Shared state / message passing | `not yet exercised` | No agents means no inter-agent state. The only shared state is the read-only `graph.json`. |
| Coordination failure modes | `not yet exercised` | Infinite handoff, tool-call cascade, synthesis failure — none can occur without multiple coordinating agents. |

### Agent infrastructure (SECTION D)

| Concept | State | Would attach at |
| --- | --- | --- |
| Context engineering | `not yet exercised` | No model context window to engineer. The map viewport bbox passed to `geocodeSuggest()` (`pipeline/geocode.ts:42-46`) is the closest thing to "context curation" — but it biases an API query, not an LLM prompt. |
| Agent memory tiers | `not yet exercised` | No working/episodic/long-term memory. The app reads `graph.json` and forgets each route; there is no session state to persist. |
| Tool calling and MCP | `not yet exercised` | The single most concrete future seam: `features/routing/astar.ts:22` `search()` plus `features/routing/summary.ts:11` `routeSummary()` are *exactly* the function an agent would expose as a **tool**. Walked in [`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md). |
| Agent evaluation (trajectory) | `not yet exercised` | The repo evaluates the *algorithm* deterministically (Vitest `*.test.ts`, `bench/run.ts`), not a model trajectory. No tool-call accuracy or trajectory metrics because there is no trajectory. |
| Guardrails and control (iteration cap, cost ceiling, human gate) | `not yet exercised` | There is one deterministic "cap" worth noting as a contrast: `BLOCKED` is large-finite, not `Infinity`, so the A\* search distinguishes "no flat route" from "no route" (spec §14.4; `features/routing/cost.ts`). That's a *deterministic search bound*, not an agent control envelope — but it's the same instinct (bound the search) one layer down. |

### Production serving for agents (SECTION E)

| Concept | State | Would attach at |
| --- | --- | --- |
| Cross-turn caching | `not yet exercised` | No turns to cache across. The deterministic analog is the prebuilt `graph.json` (build once, read many) and the per-viewport tile cache in `mobile/src/useTileGraph.ts` — caching of *data*, not of model turns. |
| Fan-out backpressure | `not yet exercised` | Would matter only if a supervisor spawned concurrent LLM workers. The existing concurrency is tile fetching against Open-Meteo / Nominatim, which already needs rate-limit care (user memory: Open-Meteo 429s) — a real backpressure concern, but at the HTTP layer, not an agent fan-out. |
| Per-tool circuit breaking | `not yet exercised` | If the router-as-tool seam ([`02`](02-router-as-agent-tool-seam.md)) were built, a breaker would wrap the `geocode()` call (`pipeline/geocode.ts:9`) so a dead Nominatim doesn't burn an agent's whole iteration budget. Today a failed fetch just throws (`geocode.ts:24`). |

---

## What this folder contains

Proportionate to the verdict: an honest overview plus two focused files where
a real diagram earns its place. No padded concept tree for machinery that does
not exist.

- **`00-overview.md`** (this file) — the no-agent verdict and the full
  `not yet exercised` inventory with would-attach seams.
- **[`01-control-loop-contrast.md`](01-control-loop-contrast.md)** — the one
  diagram worth drawing: **code decides next step** (A\* loop) vs **model
  decides next step** (agent loop). Same skeleton, opposite control axis. An
  analogy/contrast for teaching — explicitly **not** a claim that A\* is an
  agent.
- **[`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md)** —
  the single real future seam: a "describe my route" / NL-destination feature
  where a tool-calling agent wraps the existing router as a **tool**, consuming
  `features/routing/summary.ts` and feeding `pipeline/geocode.ts` /
  `mobile/src/AddressBar.tsx`. Includes the tool/injection risk cross-link.

## See also

- **DSA foundations** — the A\* control loop being contrasted lives here as a
  classical algorithm: `.aipe/study-dsa-foundations/` (graph search, priority
  queue, admissible heuristic).
- **System design** — the chain-shaped pipeline and static-artifact data flow:
  `.aipe/study-system-design/`.
- **Security** — if the router-as-tool seam is ever built, the prompt-injection
  / tool-abuse trust boundary lives here: `.aipe/study-security/` (cross-linked
  from [`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md)).
- **AI engineering** — single-LLM-call and retrieval mechanics, if/when an AI
  layer is added: `.aipe/study-ai-engineering/` (not yet generated; sibling of
  this folder).
- **Prompt engineering** — the prompt that would drive the NL parser:
  `.aipe/study-prompt-engineering/` (not yet generated; sibling of this folder).
