# Chains vs agents — the boundary

**Industry names:** workflow vs agent · static control flow vs autonomous
loop. **Type:** Industry standard.

> The entry point to the whole reasoning-pattern family. The one question:
> *did the engineer write the steps, or does the decider write them at
> runtime?* flattr answers "engineer wrote them" twice over — `pipeline/`
> is a chain, and even the router loop decides with code, not a model.

---

## Zoom out, then zoom in

**Zoom out.** flattr has two control-flow shapes, and neither is an agent:

```
  Zoom out — flattr's two control flows, both engineer-written

  ┌─ Build-time chain (pipeline/) ─────────────────────────────┐
  │  osm → elevation → split → grade → build-graph             │ ← a CHAIN
  │  fixed order, engineer wrote every step, no decider        │
  └────────────────────────────────────────────────────────────┘
  ┌─ Run-time loop (features/routing/astar.ts) ────────────────┐
  │  pop → expand → decide(g+h) → loop or stop                 │ ← a LOOP
  │  but CODE decides each step, not a model                   │   (not an agent)
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** A **chain** is steps the engineer wrote: input → step 1 →
step 2 → output. A model, if present, fills a slot but never chooses
what comes next. An **agent** is a loop where the *decider* writes the
steps at runtime. flattr's pipeline is a textbook chain. Its router is a
loop — but the decider is arithmetic, so it's still not an agent. The
distinction this file draws is: *is there an autonomous loop?* The next
file (`02-agent-loop-skeleton.md`) answers *what's in the loop.*

---

## The structure pass

**The axis: who writes the sequence of steps?**

```
  One question — "who writes the next step?"

  ┌─ chain (pipeline/) ──────────┐  → ENGINEER, at code-time
  │  run-build.ts calls each      │     (fully fixed)
  │  stage in a fixed order       │
  └───────────────────────────────┘
  ┌─ flattr's loop (astar.ts) ───┐  → ENGINEER wrote the loop;
  │  the g+h rule picks neighbors │     CODE picks within it
  └───────────────────────────────┘     (fixed rule, data-driven path)
  ┌─ an agent (not in flattr) ───┐  → MODEL, at run-time
  │  LLM picks the next action    │     (the path is unknown until run)
  └───────────────────────────────┘
```

**The seam.** The boundary that matters is between "the path is known
before you run" (chain) and "the path depends on what the decider finds"
(agent). flattr's router straddles it interestingly: the *path through
the graph* is unknown until you run (data-driven, like an agent), but the
*rule* that picks it is fixed (like a chain). That's why it's a loop but
not an agent — autonomy is about who writes the *rule*, not whether the
output varies.

---

## How it works

### Move 1 — the mental model

You've shipped both shapes. A `.then()` chain of single-purpose functions
is a chain — the order is in your code. A `while` loop that picks its next
move from a rule is the loop shape. The agent is the loop shape with the
*rule* replaced by a model.

```
  Chain:   Input → [Step 1] → [Step 2] → [Step 3] → Output
                    (order fixed by the engineer; a model, if any,
                     fills a slot but never picks what comes next)

  Agent:   ┌─────────────────────────────────────────┐
           │  Reason → Act → Observe → (loop or stop) │
           │  the MODEL picks each next action        │
           └─────────────────────────────────────────┘
```

### Move 2 — walkthrough against flattr

#### The chain: `pipeline/`

flattr's build pipeline is a chain. `pipeline/run-build.ts` drives a
fixed sequence — fetch OSM ways (`overpass.ts`), fetch elevation
(`elevation.ts`), split into segments (`split.ts`), compute grade
(`grade.ts`), assemble the graph (`build-graph.ts`). The order is in the
code. No step decides what comes next; `grade.ts` always follows
`elevation.ts`.

```
  pipeline/ — a chain (layers-and-hops, build-time)

  ┌─ Network ─┐  ways    ┌─ pipeline/ ─────────────────────────────┐
  │ Overpass   │ ───────► │ overpass → elevation → split → grade →  │
  │ Open-Meteo │ elev     │ build-graph                             │
  └────────────┘ ───────► └────────────────────┬────────────────────┘
                                                │ writes
                          ┌─ Data ──────────────▼───────────────────┐
                          │ mobile/assets/graph.json (static artifact)│
                          └──────────────────────────────────────────┘
```

What makes it a chain and not an agent: the sequence is written, not
chosen. If elevation fails, the next step doesn't *reason* about what to
do — it just propagates (per the project's external-data caveat, the
Open-Meteo 429 is handled by checking quota, not by a decider rerouting).

#### The loop that isn't an agent: `search()`

The router *is* a loop (`astar.ts:48`), and the path it produces is
unknown until it runs — that feels agent-like. But the decision rule is
fixed: `g + h`, every time, deterministically. There's no model, no
runtime-chosen strategy. It's a loop with a hard-coded step. See
`02-agent-loop-skeleton.md` for the full walk.

### Move 3 — the principle

Use a chain when you know the steps in advance — flattr's build does, so
it's a chain. Use an agent when the steps depend on what the decider
finds *and* you're willing to pay for a model to decide. flattr never
needs the model to decide, so it never crosses into agent territory. The
cost of an agent is unpredictability: variable step count, variable cost,
harder debugging — all the things flattr's deterministic loop is free of.

---

## Primary diagram

```
  flattr's two control flows vs an agent — one frame

  CHAIN (pipeline/, build-time)   LOOP (router, run-time)   AGENT (absent)
  ───────────────────────────     ──────────────────────    ──────────────
  fixed order, engineer-written   fixed rule (g+h),          model-written
  osm→elev→split→grade→graph      data-driven path           steps at runtime
       │                               │                          │
       ▼                               ▼                          ▼
  graph.json                      a Path                     (would call
  (no decider)                    (code decides each step)    search/geocode
                                                              as tools)
```

---

## Elaborate

The chain/agent line is the most-confused boundary in agent
architecture, because output that *varies* feels autonomous. flattr is
the clean counterexample: its router's output varies wildly with input,
yet it's not an agent, because the *decision rule* is fixed. Autonomy is
about who authors the rule, not whether the result is dynamic. Most
production "agents" should be chains — the decision tree is known, and a
chain is cheaper and debuggable. Reach for the loop only when the path
genuinely can't be written down in advance.

---

## Interview defense

**Q: flattr's router produces a different path for every input — isn't
that an agent?**

No — autonomy is about who writes the *rule*, not whether the output
varies. The router's rule is fixed: `g + h`, deterministically, every
expansion. A model never decides anything. It's a loop with a hard-coded
step, not an agent. The build pipeline is even clearer — a fixed-order
chain, `osm→elevation→split→grade→graph`.

```
  varies(output) ≠ autonomous(rule)
  flattr: output varies, rule fixed → loop, not agent
```

Anchor: *"`astar.ts` picks a different path per input, but the picking
rule never changes — that's a chain's determinism wearing a loop's
shape, not an agent."*

---

## See also

- `02-agent-loop-skeleton.md` — what's inside the loop (the contrast)
- `07-routing.md` — where flattr could grow a real agent
- `../03-multi-agent-orchestration/03-sequential-pipeline.md` — the
  pipeline shape, when each stage is an agent
- `../agent-patterns-in-this-codebase.md`
- Cross-ref: `study-ai-engineering`'s
  `04-agents-and-tool-use/01-agents-vs-chains.md` (the mechanics)
