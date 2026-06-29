# Chains vs agents — the boundary, and where flattr sits

**Industry name(s):** workflow/chain vs autonomous agent · "static control
flow vs model-decided control flow." **Type label:** Industry standard.

---

## Zoom out, then zoom in

This is the entry point to the whole reasoning-pattern family. Before you ask
*what kind* of agent something is, ask the prior question: **is there an
autonomous loop at all, or did an engineer write the steps?** flattr answers
this cleanly — every step in flattr is written by the engineer, and most of
them don't even involve a model.

```
  Zoom out — control flow ownership across flattr

  ┌─ BUILD TIME (pipeline/) ─────────────────────────────────┐
  │  run-build.ts: a FIXED chain, engineer-written order      │
  │  osm → split → elevation → grade → build-graph → graph.json│ ← engineer
  │       (no model fills any slot — pure transforms)          │   decides
  └───────────────────────────────────────────────────────────┘
  ┌─ RUNTIME (features/routing/) ────────────────────────────┐
  │  search(): a LOOP, but CODE decides each step (A* rule)   │ ← engineer
  │       (a control loop, not an autonomous agent)           │   decides
  └───────────────────────────────────────────────────────────┘

  Nowhere in flattr does a MODEL choose what happens next.
```

Zoom in: a **chain** is a control flow the engineer writes — Input → Step 1 →
Step 2 → Output, where each step is fixed and (in an LLM chain) a model fills
a slot but never chooses what comes next. An **agent** is a loop where the
model chooses the next step at runtime. flattr's build pipeline is a chain
*without even the LLM-fills-a-slot part*; flattr's router is a control loop
where code, not a model, decides. Neither is an agent.

---

## Structure pass

**Layers.** Two of flattr's subsystems sit on different sides of an
imaginary line — but both are firmly on the "engineer decides" side.

**Axis — "who writes the steps?"**

```
  "who writes the steps?" — traced across the spectrum

  chain                  control loop            agent
  ─────                  ────────────            ─────
  engineer writes        engineer writes the     model writes
  EVERY step in order    loop; CODE decides      the steps at
                         each iteration          runtime
       ▲                      ▲                      ▲
  pipeline/run-build.ts  features/routing/      (not in flattr)
  (fixed sequence)       astar.ts (A* rule)
```

**Seam — the line flattr does not cross.** The load-bearing boundary is
between "control loop where code decides" and "agent where model decides."
flattr's `search()` sits *right at that line on the code side* — it has a
loop, but the decision is `g + h`, not a model. That's exactly the seam the
agent-loop-skeleton file walks. The contract is "given state, pick the next
move"; flattr fills it with code, an agent fills it with a model.

---

## How it works

### Move 1 — the mental model

You write React components two ways: an imperative script that runs
top-to-bottom (`fetch` then `parse` then `setState` — you wrote the order),
versus a state machine that decides its own next transition based on input. A
chain is the script; an agent is the self-driving state machine. flattr is
all script.

```
  Chain (engineer writes the steps):

  Input → Step 1 → Step 2 → Step 3 → Output
          (each step fixed; if a model is involved it fills
           a slot, it does NOT choose what comes next)

  Agent (model writes the steps at runtime):

  ┌─────────────────────────────────────┐
  │  Reason  → model decides next action │
  │  Act     → call a tool               │
  │  Observe → read result               │
  │     └──── loop or stop ──────────────│
  └─────────────────────────────────────┘
```

### Move 2 — the walkthrough

#### flattr's build pipeline is a chain (no model at all)

`pipeline/run-build.ts` runs a fixed sequence. The engineer wrote the order;
nothing chooses it at runtime, and crucially **no LLM fills any slot** — each
step is a deterministic transform (fetch OSM, split ways, fetch elevation,
compute grade, assemble graph). This is a chain that doesn't even reach the
"LLM fills a slot" version of a chain. It's pure dataflow.

```
  Layers-and-hops — the build chain (build-time only)

  ┌─ Provider ──┐ fetch ┌─ pipeline ──┐ transform ┌─ Storage ──┐
  │ Overpass /  │ ────► │ osm→split→   │ ────────► │ graph.json │
  │ Open-Meteo  │       │ elevation→   │           │ (artifact) │
  └─────────────┘       │ grade→build  │           └────────────┘
                        └──────────────┘
   fixed order, engineer-written, no runtime decision, no model
```

#### flattr's router is a control loop, not an agent

`search()` (`astar.ts:48`) *does* loop, and it *does* decide the next step
each iteration — but the decider is the A* cost rule, code, not a model. This
is the subtle case worth getting right: **a loop where code decides is still
not an agent.** "Agent" requires the *model* to own the runtime decision.
flattr's loop is fully covered in `02-agent-loop-skeleton.md` precisely
because it's the deterministic twin of the agent loop.

#### The decision rule

Use a chain when you know the steps in advance. Use an agent when the steps
depend on what the model finds at runtime. flattr knows its steps in advance
on both axes: the build order is fixed, and the routing decision is a
closed-form cost comparison. There is no point in flattr where "the next step
depends on what a model just discovered," so there is no reason for an agent.
The cost of an agent — variable step count, variable cost, harder
debugging — would buy flattr nothing.

### Move 3 — the principle

The chains-vs-agents line is about *control ownership*, not about whether an
LLM is present. A pipeline with an LLM in every slot can still be a chain (the
engineer owns the order); a loop with no LLM at all can still be agent-shaped
in skeleton (flattr's router). The question that sorts them is the only one
that matters: **at runtime, who picks the next step — your code, or the
model?**

---

## Primary diagram

```
  WHERE FLATTR SITS — the control-ownership spectrum

  ┌──────────────┬──────────────────┬───────────────┬──────────┐
  │ pure chain   │ LLM-slot chain   │ control loop  │ agent     │
  │ (dataflow)   │ (model fills     │ (code decides │ (model    │
  │              │  slots, eng      │  each step)   │  decides  │
  │              │  owns order)     │               │  steps)   │
  ├──────────────┼──────────────────┼───────────────┼──────────┤
  │ ★ pipeline/  │   (none)         │ ★ features/   │  (none)   │
  │ run-build.ts │                  │ routing/      │           │
  │              │                  │ astar.ts      │           │
  └──────────────┴──────────────────┴───────────────┴──────────┘
   engineer owns control ◄─────────────────────► model owns control

   flattr lives entirely on the LEFT half. No model owns any
   runtime decision anywhere in the repo.
```

---

## Elaborate

The chain/agent distinction was sharpened by Anthropic's "Building Effective
Agents" framing (workflows vs agents) and LangChain's chain-vs-agent split.
The durable insight from that body of work: *most production "AI" systems
should be chains, not agents,* because chains are predictable, cheap, and
debuggable, and you only reach for an agent when the task genuinely can't be
expressed as a fixed sequence. flattr is the extreme version of that
advice — it doesn't even need the LLM-slot chain, because its decisions are
deterministic. Read `02-agent-loop-skeleton.md` next for the loop that sits
right at the boundary.

---

## Interview defense

**Q: "Is flattr an agent system?"**

No — and not even close. Two subsystems, both engineer-controlled: the build
pipeline is a fixed chain of pure transforms (no model in any slot), and the
router is a control loop where the A* cost rule, not a model, decides each
step. "Agent" requires the model to own the runtime control flow, and nothing
in flattr does that.

```
  pipeline = chain   |   router = control loop   |   agent = (none)
  eng owns order        eng owns the loop           model owns steps
```

Anchor: *"flattr lives on the left half of the control-ownership spectrum.
The router is the interesting case — it's loop-shaped but code-decided, which
is exactly why it's the cleanest place to teach the agent loop by contrast."*

**Q: "When would you turn flattr's chain into an agent?"**

When a step's next action depends on what a model just discovered. Concretely:
a "plan me a flat afternoon with three coffee stops" feature — the model
doesn't know which stops or in what order until it reasons about the request,
so it would loop, calling `search()` and `geocode()` as tools. That's the one
flattr feature that would justify an agent. (Mapped in
`agent-patterns-in-this-codebase.md`.)

Anchor: *"The trigger is runtime uncertainty about the next step. flattr's
current features have none — the build order and the routing rule are both
known in advance."*

---

## See also

- `02-agent-loop-skeleton.md` — the control loop that sits at the boundary
- `../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the next escalation gate
- `agent-patterns-in-this-codebase.md` — the one feature that would cross the line
- `study-system-design` — the pipeline and router as system boundaries
