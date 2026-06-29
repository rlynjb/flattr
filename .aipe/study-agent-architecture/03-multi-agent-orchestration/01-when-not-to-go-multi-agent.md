# When NOT to go multi-agent — the escalation gate

**Industry name(s):** the single-agent-first rule · "earn your topology."
**Type label:** Industry standard (production scar tissue).

---

## Zoom out, then zoom in

The single most important multi-agent decision is whether to be multi-agent
at all. For flattr the answer is an emphatic *no* — flattr isn't even
single-agent, so "should it be multi-agent" is two rungs premature. But the
gate is worth teaching here, because it's the same gate the reader will face
on AdvntrCue or the next AI product, and it's the gate most teams blow past.

```
  Zoom out — flattr's position on the escalation ladder

  ┌──────────────────────────────────────────────────────────┐
  │ rung 0: deterministic code      ★ flattr is HERE          │
  │         (search() decides via A* — no model)              │
  ├──────────────────────────────────────────────────────────┤
  │ rung 1: single-agent (ReAct)    ← the first thing you'd    │
  │         one loop, model + tools   build IF a feature       │
  │                                   needed model decisions   │
  ├──────────────────────────────────────────────────────────┤
  │ rung 2: multi-agent topology    ← only after rung 1 hits   │
  │         many agents, coordination  a measured quality      │
  │                                    ceiling                 │
  └──────────────────────────────────────────────────────────┘

  You do not skip rungs. flattr is two below the first agent.
```

Zoom in: the escalation gate is a checklist you run *before* adding agents.
Build single-agent, measure it, identify the specific failure it can't fix,
and only then ask whether that failure decomposes into independent
specialties. If it doesn't, you stay single-agent. flattr fails the gate at
step zero — it has no agent and no decomposable model-driven problem — so
this file is teaching material, marked **not yet exercised** in this repo,
with the attachment point named.

---

## Structure pass

**Layers.** The gate is one decision tree with an early exit at every node —
each "no" sends you back down a rung.

**Axis — "what does adding a layer of agents *buy*, and what does it cost?"**

```
  cost vs benefit, traced up the ladder

  rung          buys                     costs
  ────          ────                     ─────
  rung 0→1      runtime flexibility      non-determinism,
  (add a model)  for unpredictable steps  latency, $, harder debug
  rung 1→2      parallel specialties     2-5x coordination overhead,
  (add agents)   IF decomposable          a debugging surface that is
                                          now the conversation BETWEEN
                                          agents, not one loop
```

**Seam — the decomposability test.** The load-bearing boundary between
single-agent and multi-agent is one question: *does the failure split into
genuinely independent specialties?* If yes, cross to multi-agent. If no, the
"boundary" is cosmetic and you've bought 2-5x overhead for nothing.

---

## How it works

### Move 1 — the mental model

You wouldn't split one React component into a microservices mesh because it
got slightly complex — you'd reach for that only when parts genuinely need to
scale or deploy independently. Multi-agent is the same call: don't fragment
one loop into many until the work genuinely splits into independent jobs.

```
  The escalation gate — run top to bottom

  ┌───────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline      │
  │ 2. Measure: success rate, tool-call accuracy, │
  │    latency, cost                              │
  │ 3. Identify the SPECIFIC failure single-agent │
  │    cannot fix                                  │
  │ 4. Is that failure genuinely decomposable     │
  │    into independent specialties?              │
  │       │                                        │
  │       ├─ no  → stay single-agent, fix the      │
  │       │        prompt / tools / retrieval      │
  │       └─ yes → escalate to the SPECIFIC        │
  │                topology that addresses it      │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough, applied to flattr

#### Step 1-2: there is no baseline to measure

flattr has no agent, so there is nothing to measure. The escalation gate
assumes a single-agent baseline exists and has been instrumented (success
rate, tool-call accuracy, latency, cost). flattr's analog of "measurement" is
its **benchmark harness** (`bench/run.ts`) — but that measures *algorithm*
performance (Dijkstra → A* → directional → bidirectional, by nodes-expanded
and pushes/pops), not agent trajectory. That's a real and useful seam: if
flattr ever grew an agent, `bench/` is where trajectory evals would attach.

```
  Layers-and-hops — what flattr measures vs what an agent needs

  ┌─ bench/ (exists) ──────┐      ┌─ agent evals (not yet) ──────┐
  │ nodes expanded         │  ≠   │ task success rate            │
  │ heap pushes / pops     │      │ tool-call accuracy           │
  │ per algorithm stage    │      │ trajectory steps / $ / ms    │
  └────────────────────────┘      └──────────────────────────────┘
   measures the SEARCH                 measures the AGENT LOOP
   (deterministic)                     (would attach at bench/)
```

#### Step 3-4: flattr's problems don't decompose into model specialties

Run the gate honestly. flattr's hard problems are: routing (a closed-form
search), grade classification (`features/grade/classify.ts`, a pure
band+color map), and the build pipeline (fixed transforms). None of these
needs a model, so none decomposes into *model* specialties. The
decomposability test isn't even reachable — there's no model-driven failure
to decompose.

The one hypothetical that *would* reach the gate is the "plan a flat
afternoon with three coffee stops" feature. Even there, the honest answer is
**stay single-agent**: one ReAct loop calling `geocode()`, `search()`, and
`routeSummary()` as tools handles it. The sub-problems (find coffee shops,
route between them, order the stops) are not independent specialties needing
separate agents — they're sequential tool calls in one loop. Reaching for
multi-agent there would buy the 2-5x coordination tax for nothing.

### Move 3 — the principle

Topology is earned, not chosen. Every rung up the ladder buys a specific
capability at a specific cost, and you only pay when a *measured* failure on
the rung below forces it. The senior-grade move is not building the
multi-agent system — it's saying "I considered it and chose not to, because
the failure wasn't decomposable." flattr is the purest case of that
discipline: it doesn't even climb to rung 1, because deterministic code
solves the whole problem.

---

## Primary diagram

```
  THE LADDER — flattr's verdict at each rung

  rung 2  multi-agent   │ NOT YET EXERCISED. Would need: a
                        │ model-driven failure that decomposes
                        │ into independent specialties. flattr
                        │ has none.
          ──────────────┼────────────────────────────────────
  rung 1  single-agent  │ NOT YET EXERCISED. Attachment point:
                        │ a "plan-a-flat-afternoon" feature, ONE
                        │ ReAct loop over search/geocode/summary.
          ──────────────┼────────────────────────────────────
  rung 0  deterministic │ ★ flattr IS HERE. search() decides via
          code          │ A* cost rule. No model owns any step.
```

---

## Elaborate

The "don't reach for multi-agent before single-agent hits its ceiling" rule
is production scar tissue — it comes from teams that shipped multi-agent
systems and paid the coordination tax (the conversation between agents
becomes the thing you debug, not any single loop). Anthropic's multi-agent
research-system writeup and the broader "Building Effective Agents" guidance
both land on the same breakpoint: multi-agent earns its overhead only when
the task genuinely parallelizes across specialties. flattr never gets near
that breakpoint. The coordination failure modes that make the tax concrete
(infinite handoff, tool-call cascade, context bloat, synthesis failure) are
catalogued in the audit as not-yet-exercised — they can't occur in a system
with no agents.

---

## Interview defense

**Q: "Walk me through deciding whether to go multi-agent."**

Build single-agent, instrument it (success rate, tool-call accuracy, latency,
cost), find the specific failure it can't fix, then ask the one question that
matters: does that failure decompose into independent specialties? Only "yes"
crosses to multi-agent, and only to the specific topology that addresses that
failure. The cost of crossing is 2-5x coordination overhead and a debugging
surface that's now the inter-agent conversation.

```
  baseline → measure → specific failure → decomposable? → yes: topology
                                                        → no:  stay single
```

Anchor: *"The strongest answer is 'I chose not to.' On flattr's hypothetical
multi-stop feature, the sub-tasks are sequential tool calls in one loop, not
independent specialties — so single-agent, not multi-agent."*

**Q: "flattr has no agent — why does the gate matter here?"**

Because it shows the discipline transfers. flattr's `bench/` harness measures
deterministic search performance; that's the exact slot where agent
trajectory evals would attach if flattr ever grew an agent. The gate's "build
a baseline and measure" step already has its measurement seam in this repo —
it just measures an algorithm today instead of a loop.

Anchor: *"flattr is two rungs below the first agent. The gate's value here is
recognizing that, and naming `bench/` as where measurement would plug in."*

---

## See also

- `../01-reasoning-patterns/01-chains-vs-agents.md` — the rung-0/rung-1 boundary
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — what a single-agent loop is
- `../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — what flattr could become
- `../audit.md` — the coordination failure modes, marked not-yet-exercised
