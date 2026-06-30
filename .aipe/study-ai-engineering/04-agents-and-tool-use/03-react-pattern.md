# ReAct pattern — N/A: flattr has no reasoning loop to externalize

**Industry name(s):** ReAct (Reason + Act) / thought-action-observation loop.
**Type:** Industry standard.

## Zoom out — ReAct is an agent's reasoning trace; flattr has no agent and no trace

ReAct interleaves the LLM's reasoning with tool calls: Thought (what to do)
→ Action (call a tool) → Observation (read the result) → Thought → ...,
until the model decides it's done. It exists to make a *multi-step
reasoning loop* debuggable. flattr has no such loop — its route flow is a
fixed chain (see [agents vs chains](01-agents-vs-chains.md)) with no LLM
reasoning between steps. There's nothing to reason, so nothing to
externalize.

```
  Zoom out — no Thought/Action/Observation loop exists in flattr

  ┌─ (NOT BUILT) ReAct loop ────────────────────────────────┐
  │  Thought → Action → Observation → Thought → ... → answer │
  │  ★ flattr has no LLM reasoning between steps             │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ flattr's actual flow (fixed chain) ▼ ───────────────────┐
  │  geocode → nearestNode → directedAstar → summary         │ MapScreen.tsx:155-159
  │  deterministic · no per-step reasoning                   │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** UI input → fixed engine steps → render.
- **Axis — is there reasoning between steps?** ReAct: yes, an LLM thought
  precedes every action. flattr: no, the next step is the next line of
  code. Trace "what decides the next action" and it's always the source,
  never a reasoning step.
- **Seam:** none. ReAct's seam is the Thought→Action boundary where the
  model commits to a tool. flattr has no such boundary; its step
  transitions are hardcoded function calls.

## How it works

### Move 1 — the mental model

ReAct is "think out loud before each move." Instead of the model silently
picking actions, it writes a Thought, takes one Action, reads the
Observation, then thinks again — so when it goes wrong you can read the
trace and see *where* the reasoning broke. flattr never thinks: its moves
are predetermined function calls, so there's no reasoning trace to read
and no place for reasoning to break.

```
  Pattern — ReAct interleaves reason and act (flattr does neither)

  Thought: "I should search PRs for auth"
  Action:  search_prs("auth")
  Observation: 7 results
  Thought: "also check 'authentication'..."   ← loop continues
            ▲ flattr has no Thought step at all
  flattr:  call geocode(); call route(); done.  (no reasoning, no loop)
```

### Move 2 — the walkthrough

**flattr's "trace" is just a call sequence.** `MapScreen.tsx:155–159`:

```ts
const r = directedAstar(graph, startId, endId, userMax);   // not an "Action"
if (!r.path) return { found: false };                      // a branch, not a "Thought"
return { fc: routeToGeoJSON(...), summary: routeSummary(...), found: true };
```

There's no Thought before the route call and no Observation the model
reflects on. The early-return on `!r.path` is a deterministic branch, not
a reasoning step. A* itself *does* "explore" the graph — expand, score,
backtrack — but that's algorithmic search, not LLM reasoning; it produces
no natural-language trace and makes no tool-selection decisions.

```
  Layers-and-hops — fixed calls, no reason/act interleave

  ┌─ UI ──────┐ call geocode → call route   ┌─ engine ──────────┐
  │MapScreen  │ ──────────────────────────►│ directedAstar      │ :155
  │           │ ◄──────────────────────────│ result (path|null) │
  └───────────┘  no Thought between calls   └────────────────────┘
```

**The boundary condition.** Don't mistake A*'s search loop for ReAct.
ReAct's loop is *LLM reasoning choosing tools*; A*'s loop is a
deterministic priority-queue expansion choosing the lowest-cost frontier
node. They're both "loops that explore," but ReAct's steps are
model-decided and language-mediated, while A*'s are fully determined by
the cost function. Calling A* "ReAct" would conflate algorithmic search
with LLM reasoning.

### Move 3 — the principle

ReAct earns its place when a task needs multiple model-decided steps and
you need the reasoning to be inspectable. flattr's task is single-pass and
deterministic, so there's no reasoning to externalize and ReAct has no
foothold. The principle: ReAct is a debugging affordance for *LLM*
reasoning loops — a deterministic algorithm's loop (like A*) is already
inspectable through its state, and doesn't need or benefit from a
thought-action-observation framing.

## Primary diagram

```
  No reasoning loop — flattr's steps are predetermined

  ┌─ ReAct (NOT BUILT) ──────────────────────────────────────┐
  │ Thought → Action → Observation → ... (LLM-decided steps)  │
  └──────────────────────────────────────────────────────────┘
  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ geocode → nearestNode → directedAstar → summary           │
  │ fixed chain [MapScreen.tsx:155–159] · no LLM reasoning     │
  │ (A*'s internal search loop ≠ ReAct — deterministic, no NL) │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

ReAct made agents debuggable by forcing the model to write its reasoning
between actions — the trace is where you find the bad step. It's
foundational for multi-step LLM tasks. flattr is the opposite shape: a
deterministic pipeline whose "trace" is a fixed call sequence and whose
only loop (A*) is algorithmic, not reasoned. The transferable distinction
is recognizing that a search loop and a reasoning loop are not the same
thing — flattr has the former and none of the latter.

## Interview defense

**Q: Does flattr use the ReAct pattern?** Answer: no — there's no LLM
reasoning loop. Its route flow is a fixed chain (`MapScreen.tsx:155–159`):
geocode → route → summarize, with a deterministic branch on `!r.path`, no
Thought/Action/Observation. A* *does* loop internally, but that's
algorithmic frontier expansion driven by the cost function, not
model-decided tool selection with a natural-language trace. Load-bearing
distinction: ReAct externalizes *LLM* reasoning; A*'s loop is
deterministic search and needs no such framing.

```
  A* search loop (deterministic) ≠ ReAct loop (LLM reasoning + tool choice)
```

Anchor: *"flattr has a search loop, not a reasoning loop — A* expands the
frontier by cost, it never 'thinks' between actions the way ReAct does."*

## See also

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — why flattr's flow is a fixed chain.
- [02-tool-calling.md](02-tool-calling.md) — the tools a ReAct loop would call.
- [05-agent-memory.md](05-agent-memory.md) — N/A: flattr is stateless per route.
