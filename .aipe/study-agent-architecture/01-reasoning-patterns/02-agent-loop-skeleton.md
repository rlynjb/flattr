# The agent loop skeleton — taught by contrast with flattr's search loop

**Industry name(s):** agent control loop / agentic loop · the ReAct kernel.
**Type label:** Industry standard (the loop) · Project-specific (the
deterministic counterpart in `features/routing/astar.ts`).

---

## Zoom out, then zoom in

flattr has no agent loop. But it has the *exact same control-loop skeleton*
sitting in plain sight, with the model swapped out for code. That makes it
the best possible place to learn what an agent loop actually is — because you
can read every decision the loop makes, run it in a test, and watch it
terminate, with no LLM hiding the mechanics.

Here's where the loop lives in the system, and where its agent twin *would*
live:

```
  Zoom out — the control loop, code-decides vs model-decides

  ┌─ UI layer (mobile/) ─────────────────────────────────────┐
  │  MapScreen → tap origin/destination → request a route    │
  └───────────────────────────┬──────────────────────────────┘
                              │  (startId, goalId, userMax)
  ┌─ Service layer (features/routing/) ──────────────────────┐
  │                                                          │
  │   ★ search()  ── THE CONTROL LOOP ──★   astar.ts:48      │ ← we are here
  │   while frontier not empty:                              │
  │     pop → expand → decide next → loop or stop            │
  │              ▲                                            │
  │              │  CODE fills the "decide next" slot         │
  │                                                          │
  │   ┌── the agent twin (NOT in this repo) ──────────────┐  │
  │   │  while not done:                                   │  │
  │   │    step = MODEL.decide(state)  ← LLM fills the slot│  │
  │   │    result = execute(step, tools)                   │  │
  │   └────────────────────────────────────────────────────┘ │
  └───────────────────────────┬──────────────────────────────┘
                              │  Path { nodes, edges, cost, ... }
  ┌─ Storage layer ──────────────────────────────────────────┐
  │  graph.json (prebuilt static artifact, read-only)        │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: **an agent loop and a search loop are the same skeleton.** Both
maintain state, both run a step function in a loop, both execute the step's
result, both must terminate two ways. The single axis that flips between them
is **control — who decides the next step.** In `search()`, the answer is the
A* cost-plus-heuristic rule, written by the engineer. In an agent, the answer
is a model call. Hold that one axis and everything else lines up.

---

## Structure pass

**Layers.** One outer loop, one inner step. The outer loop is the same in
both worlds (maintain state, pick next, execute, check termination). The
inner step is the only thing that differs.

```
  ┌─────────────────────────────────────┐
  │ outer: the loop (state + terminate)  │   → IDENTICAL in both
  └─────────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ inner: the step (decide next)    │   → CODE here / MODEL there
      └─────────────────────────────────┘
```

**Axis — "who decides the next step?"** Trace it down the two layers:

```
  One question down the stack: "who decides the next step?"

  layer        flattr search()           an agent loop
  ───────      ──────────────────        ─────────────────
  outer loop   CODE (while/pop/expand)   CODE (the harness)
  inner step   CODE (A* cost rule)       MODEL (the LLM call)

  the answer flips at exactly ONE altitude — the inner step.
  that single flip is the entire difference between
  "search" and "agent". everything else is shared.
```

**Seam — the inner step.** This is the load-bearing boundary. On flattr's
side, `costFn(edge, current, userMax) + heuristicFn(...)` decides which
frontier node wins (`astar.ts:68-72`). On an agent's side, a model decides
which tool to call. The contract across the seam is identical: *"given the
current state, return the next move."* Swap a deterministic function for a
model call and the search loop becomes an agent loop. That swap is the whole
lesson.

---

## How it works

### Move 1 — the mental model

You already know this shape: it's BFS/Dijkstra/A* — frontier, expand,
repeat. You've built it (`PG.ts`, `Graph2.ts` in reincodes). An agent loop
is that same frontier-expand-terminate skeleton, except the "expand"
decision is made by a model instead of a cost function. One plain sentence:
**an agent is a search loop whose step function is an LLM call.**

```
  The kernel — one skeleton, two fillings

         ┌──────────────────────────────────┐
         │  state  (accumulates each turn)   │
         └───────────────┬──────────────────┘
                         ▼
         ┌──────────────────────────────────┐
   ┌────►│  step(state) → next move          │  ◄── the ONE slot
   │     │    flattr: A* cost+heuristic rule │      that differs
   │     │    agent:  MODEL.decide(state)    │
   │     └───────────────┬──────────────────┘
   │                     ▼
   │     ┌──────────────────────────────────┐
   │     │  execute(move) → result           │
   │     └───────────────┬──────────────────┘
   │                     ▼
   │     ┌──────────────────────────────────┐
   │     │  state = update(state, result)    │
   │     └───────────────┬──────────────────┘
   │                     ▼
   │              ┌──────────────┐
   └──── no ──────│ terminate?   │──── yes ──► return
                  │ success OR    │
                  │ budget        │
                  └──────────────┘
```

### Move 2 — the load-bearing skeleton, walked against real code

The agent-architecture spec names four load-bearing parts of any agent loop,
plus a two-exit termination rule. flattr's `search()` has **all five**,
because it's the same skeleton. Let me walk each part by naming what breaks
when it's missing — and point at the exact line in `astar.ts` that
implements it.

#### Part 1 — state (accumulate)

Without state, every turn is amnesiac and you have N independent calls, not a
loop. State is the thing that *makes* it a loop.

In `search()`, the state is four maps, declared at `astar.ts:30-33`:

```ts
const open = new PQueue<string>();              // frontier — what to try next
const g = new Map<string, number>();            // best-known cost to each node
const came = new Map<string, {edge,prev}>();    // how we reached each node
const closed = new Set<string>();               // already-finalized nodes
```

`came` is the accumulator — it's literally the running record of the path
being built, exactly like an agent's scratchpad accumulating
tool-results-so-far. Strip it (`astar.ts:53` reconstructs from it) and the
loop can find the goal but can't tell you *how* it got there. An agent that
forgets its prior tool results has the same failure: it re-derives the same
sub-step every turn.

#### Part 2 — the step function (the one "smart" part)

Without it, nothing chooses the next move. This is the only place where a
decision is made; everything else is plumbing.

In flattr the step is **deterministic** — the A* relaxation at
`astar.ts:68-72`:

```ts
const tentative = g.get(current)! + costFn(edge, current, userMax);  // cost of this move
if (tentative < (g.get(next) ?? Infinity)) {                         // is it better?
  g.set(next, tentative);                                            // record it
  came.set(next, { edge, prev: current });
  open.push(next, tentative + heuristicFn(graph.nodes[next], goal)); // priority = g + h
}
```

The priority `g + h` *is* the decision rule. The node with the lowest
priority pops next (`astar.ts:49`). That's a closed-form, testable, instant
decision. Swap those three lines for `const move = await model.decide(state)`
and you have an agent — same loop, same termination, but now the next move is
a model's judgment instead of a cost comparison. The cost: the agent's
decision is non-deterministic, variable-latency, and can be *wrong*, which is
why an agent needs the second termination exit below and flattr does not lean
on it as hard.

```
  Layers-and-hops — where the decision is made

  flattr (code decides):
  ┌─ search() ─┐  reads state   ┌─ cost.ts + geo.ts ─┐
  │ the loop   │ ─────────────► │ costFn / heuristic  │  pure functions
  │            │ ◄───────────── │ → a number          │  instant, testable
  └────────────┘  a priority    └─────────────────────┘

  an agent (model decides):
  ┌─ harness ──┐  reads state   ┌─ LLM provider ──────┐  Provider boundary
  │ the loop   │ ─────────────► │ model.decide(state) │  network hop,
  │            │ ◄───────────── │ → a tool call (JSON)│  latency, $, can err
  └────────────┘  a tool call   └─────────────────────┘
```

#### Part 3 — execute (run the move, feed the result back)

The decision-maker emits *intent*; the loop runs it. In an agent this
boundary is the safety story — the model never touches a tool directly, the
harness does.

In `search()`, "execute" is the neighbor expansion at `astar.ts:64-67`:

```ts
for (const edgeId of graph.adjacency[current] ?? []) {  // the available "moves"
  const edge = byId.get(edgeId)!;
  const next = otherEnd(edge, current);                 // run the move → new node
  if (closed.has(next)) continue;
```

`graph.adjacency[current]` is the move set — the analog of an agent's tool
registry. The loop, not the cost function, walks the edges and feeds results
back into state. Same separation: the "decide" part (cost rule) never
mutates the graph; the loop does the running. In an agent this same
separation is what stops a hallucinated tool call from executing — the
harness validates before it runs.

#### Part 4 — termination: TWO exits, and naming both is the point

This is the part people forget. An agent needs **two** exits, and so does a
correct search loop:

```
  Two exits — both required

  success exit ──► the goal is reached / model emits final answer
  budget  exit ──► frontier empties / max iterations hit
```

flattr's success exit, `astar.ts:52-60`:

```ts
if (current === goalId) {                    // SUCCESS: reached the goal
  const { nodes, edges } = reconstruct(...);
  return { path: summarizePath(...), ... };
}
```

flattr's budget exit, `astar.ts:48` and `astar.ts:77`:

```ts
while (!open.isEmpty()) { ... }   // loop condition IS the budget guard
// ...falls through to:
return { path: null, nodesExpanded, pushes, pops };  // frontier exhausted, no path
```

Here's the contrast that makes the lesson land. In flattr the budget exit is
**guaranteed to fire** — the graph is finite and `closed` (`astar.ts:61`)
ensures each node finalizes once, so the frontier provably drains. The loop
*cannot* run forever.

An agent has no such guarantee. Nothing forces a model to ever emit its
success token; it can cycle tool calls indefinitely. So for an agent the
budget exit is not a fallthrough — it's a hard `if (iterations > MAX)
return fallback`. It is **part of the skeleton, not bolt-on hardening.** An
agent shipped without an explicit iteration cap burns tokens in a silent
loop. flattr gets its cap *for free* from the math (finite graph + closed
set); an agent has to add it by hand. Naming this unprompted — "the agent
budget exit is the part flattr gets free and agents have to engineer" — is
the signal that you've actually built a loop, not just read about one.

### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (if flattr grew an agent)
  ─────────────                    ────────────────────────────────
  search()                         a planner loop that calls
   step = A* cost rule             search() as ONE of several tools
   (deterministic)                  step = model.decide(state)
   budget = frontier drains         budget = explicit iteration cap
   one termination, free            two terminations, one engineered

  What does NOT change: search() itself. It becomes a TOOL the
  agent calls (see agent-patterns-in-this-codebase.md). The loop
  skeleton you learned here is the skeleton you'd reuse — you'd
  wrap a second loop around it, not rewrite it.
```

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, where `step` is a
model call and `terminate` needs **both** a success condition and a hard
budget. A deterministic search loop is the *same four parts* with `step` as a
cost function and a budget that the problem structure guarantees. Once you've
seen one, you've seen the other — the only real difference is whether the
"decide" slot is filled by code you can test or a model you have to fence in.

---

## Primary diagram

The full recap — flattr's loop and its agent twin, every part labeled.

```
  THE SHARED SKELETON — flattr search() (astar.ts) vs an agent loop

  ┌─────────────────────────── the loop ───────────────────────────┐
  │                                                                 │
  │  STATE        flattr: open/g/came/closed  (astar.ts:30-33)      │
  │  (accumulate) agent:  scratchpad of tool results               │
  │       │                                                          │
  │       ▼                                                          │
  │  STEP         flattr: g + h cost rule     (astar.ts:68-72) ◄──┐ │
  │  (decide)     agent:  model.decide(state)                 the │ │
  │       │                                                  ONLY │ │
  │       ▼                                              difference│ │
  │  EXECUTE      flattr: expand neighbors    (astar.ts:64-67)    │ │
  │  (run move)   agent:  harness runs tool                       │ │
  │       │                                                        │ │
  │       ▼                                                        │ │
  │  TERMINATE    success: goal reached       (astar.ts:52)        │ │
  │  (two exits)  budget:  frontier empty     (astar.ts:48,77) ────┘ │
  │               agent budget = explicit iteration cap (must add)   │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
   Service layer · features/routing/astar.ts · pure, no I/O, fully tested
```

---

## Elaborate

The agent loop comes from the ReAct paper (Yao et al., 2022) —
Reason→Act→Observe interleaved — but the *loop* underneath it is older than
LLMs by decades. It's the same generic search loop behind Dijkstra (1959),
A* (1968), and every game-tree search. The AI-engineering framing
("Thought→Action→Observation") is one specific way to prompt the `step`
function; the loop invariant (state + step + execute + two terminations) is
what's actually load-bearing, and it's framework- and model-independent. That
is why learning it in flattr's deterministic form transfers directly: the
skeleton doesn't care whether the step is a cost comparison or a GPT call.

What to read next: `01-chains-vs-agents.md` for the boundary one rung up (is
there a loop *at all*?), and `agent-patterns-in-this-codebase.md` for how
flattr's `search()` becomes a *tool* the agent's step function calls.

---

## Interview defense

**Q: "What's the minimal skeleton of an agent loop?"**

State + step + execute + terminate, where terminate needs *two* exits — a
success condition and a hard iteration/cost budget. The budget exit is the
one people forget, and it's not optional: nothing guarantees the model emits
its success token, so without a cap the loop burns tokens silently.

```
  state → step(decide) → execute → update → terminate?(success|budget) → loop
```

Anchor: *"I'd point at a deterministic search loop — A* — to show the same
skeleton, because there the budget exit is provable (finite frontier) and in
an agent you have to engineer it. Same shape, different guarantee."*

**Q: "What actually changes when a search loop becomes an agent loop?"**

Exactly one thing: who fills the `step` slot. In A* it's a cost-plus-heuristic
rule — deterministic, instant, testable. In an agent it's a model call —
non-deterministic, slow, can be wrong. Everything else (state, execute, the
two terminations) is identical. That single substitution is why agents are
harder to debug: you can't unit-test a model the way you unit-test
`costFn(edge, current, userMax)`.

```
  inner step:  CODE (cost rule) ═══╪═══► MODEL (LLM call)
               testable, instant  flips  stochastic, slow, fenced
```

Anchor: *"In flattr the decision is `g + h` at astar.ts:68 — I can assert its
output in a test. The agent version replaces those three lines with a model
call. The loop around it doesn't move."*

**Q: "Why does flattr not need an iteration cap but an agent does?"**

flattr's budget exit fires for free: the graph is finite and the `closed` set
finalizes each node once, so the frontier provably drains (`astar.ts:48,61`).
An agent has no finite move-set guarantee — a model can cycle tool calls
forever — so the cap must be explicit. The cap is part of the skeleton, not
hardening you add later.

Anchor: *"flattr gets termination from the math; an agent gets it from a
counter you write. Naming that difference is the tell that you've shipped a
loop."*

---

## See also

- `01-chains-vs-agents.md` — one rung up: is there a loop at all?
- `agent-patterns-in-this-codebase.md` — `search()` as a callable tool (the seam)
- `study-dsa-foundations` — the A* search mechanics inside this loop
- `study-ai-engineering` — ReAct's Thought→Action→Observation step function (the model side)
- `study-system-design` — the router as a service boundary
