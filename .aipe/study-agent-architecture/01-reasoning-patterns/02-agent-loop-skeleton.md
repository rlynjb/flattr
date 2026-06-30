# The agent loop skeleton

**Industry names:** agent control loop · the agent kernel · ReAct loop
(when the step is reason→act→observe). **Type:** Industry standard.

> This is the load-bearing file of the whole guide. flattr has no agent —
> but it has the *exact loop skeleton* an agent runs, filled with code
> instead of a model. You learn the agent loop here by holding it next to
> `features/routing/astar.ts`, a loop you can read top to bottom.

---

## Zoom out, then zoom in

**Zoom out.** Where does "the agent loop" sit? It sits exactly where
flattr's router sits — the decision engine in the middle of the system,
the thing that takes a goal and a state and decides, step by step, what
to do next until it's done.

```
  Zoom out — the control loop's seat in flattr (and where an agent would sit)

  ┌─ UI layer (mobile/) ───────────────────────────────────────┐
  │  MapScreen.tsx  →  user taps start + goal, sets userMax     │
  └───────────────────────────┬────────────────────────────────┘
                              │  search(graph, start, goal, …)
  ┌─ Engine layer (features/routing/) ─────────▼───────────────┐
  │  ★ search() in astar.ts — THE CONTROL LOOP ★               │ ← we are here
  │    pop frontier → expand → decide next → loop or stop      │
  │    (an agent loop has THIS skeleton; a MODEL fills "decide")│
  └───────────────────────────┬────────────────────────────────┘
                              │  reads
  ┌─ Data layer ──────────────▼────────────────────────────────┐
  │  graph.json (static, prebuilt — the search space)          │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in.** An agent loop and flattr's A* loop are the *same four-part
machine*: hold some **state**, take a **step** that picks the next move,
**execute** that move, check whether to **terminate**. The only
difference is who fills the "pick the next move" slot. In flattr, the
`g + h` comparison fills it — pure arithmetic, deterministic, every time.
In an agent, a single LLM call fills it. Swap that one slot and a
search engine becomes an agent. That's the entire lesson.

---

## The structure pass

**Layers.** Two nested levels:

```
  outer: the loop driver   (the while loop — runs forever-until-done)
  inner: the step          (one decision: what's the next move?)
```

**The axis: who decides control flow?** Hold that one question constant
and walk down.

```
  One question, held constant — "who decides the next step?"

  ┌──────────────────────────────────────────────┐
  │ outer: the while loop (driver)               │  → CODE decides
  │   (pop, check termination, push — fixed)     │     (same in both)
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ inner: the step slot                     │  → flattr: CODE (g+h)
      │   (which neighbor is best?)              │  → agent:  MODEL (LLM)
      └──────────────────────────────────────────┘

  the driver is identical; the answer FLIPS at the step slot —
  that flip is the entire difference between a search engine and an agent
```

**The seam.** The load-bearing boundary is the step slot. Everything
around it — the frontier, the termination checks, the state
accumulation — is the *same in both worlds*. The contract at that seam:
"give me the current state, I'll hand back the next action." flattr's
`costFn`/`heuristicFn` satisfy that contract with arithmetic; an agent
satisfies it with a model call. Study that seam and you understand both.

Now the mechanics.

---

## How it works

### Move 1 — the mental model

You already know this shape. It's a `while` loop with a frontier and a
visited set — you've written BFS and Dijkstra (per `me.md`, `Graph.ts`,
`PriorityQueue.ts`, the Dijkstra animation). An agent loop is **that same
loop, with the "pick the best next node" line replaced by a model call.**
The skeleton is the kernel; the step is the swappable slot.

```
  The agent loop kernel — four parts, one swappable slot

         ┌──────────────────────────────────────┐
         │  STATE  (accumulate what's known)     │◄────┐
         └───────────────────┬──────────────────┘     │
                             ▼                          │
         ┌──────────────────────────────────────┐      │ update
   slot →│  STEP   (pick next action)            │      │ (loop)
         │   flattr: g + h arithmetic            │      │
         │   agent:  one LLM call                │      │
         └───────────────────┬──────────────────┘      │
                  is_final?  │  no                      │
            ┌────────────────┤                          │
            ▼ yes            ▼                           │
       TERMINATE        ┌─────────────┐                 │
       (success exit)   │  EXECUTE     │────────────────┘
            ▲           │  (run move)  │
            │           └─────┬───────┘
            │ budget exit     │ budget_exceeded?
            └─────────────────┘
```

### Move 2 — the load-bearing skeleton, walked against flattr's code

This is the skeleton variant from `format.md`: isolate the kernel, name
each part by **what breaks when it's missing**, separate skeleton from
hardening. Here's the kernel as pseudocode — this is the whole pattern,
nothing removable:

```
  runLoop(state, tools):
    while not done:
      action = step(state)            # ① pick next move
      if action.is_final:             # ② termination: success exit
        return action.output
      result = execute(action, tools) # ③ run the move
      state  = update(state, result)  # ④ accumulate
      if budget_exceeded(state):      # ② termination: budget exit
        return fallback(state)
```

Now the same four parts, anchored line-for-line in `astar.ts`.

#### Part 1 — STATE (accumulate)

Without state, every turn is amnesiac: you have N independent calls, not
a loop. State is *what makes it a loop.* In flattr the state is four
structures, set up before the loop:

```ts
// features/routing/astar.ts:30-33
const open = new PQueue<string>();              // the frontier (what to try next)
const g = new Map<string, number>();            // best-known cost to each node
const came = new Map<string, {edge; prev}>();   // back-pointers (the trajectory)
const closed = new Set<string>();               // already-decided (don't revisit)
```

`open` is the agent's "what should I consider next." `g` + `came` are the
**scratchpad / working memory** — the accumulated record of the path so
far. `closed` is the dedup that an agent loop usually has to *engineer*
(more on this under termination). What breaks if you drop `g`/`came`? The
loop runs but can't reconstruct *how* it got to the goal — same as an
agent that forgets its own trajectory and can't explain its answer.

#### Part 2 — STEP (the one decision slot)

The step is the only "smart" part; everything else is plumbing. In an
agent this is the single LLM call that reads the state and emits the next
action. In flattr it's pure arithmetic — the `g + h` relaxation:

```ts
// features/routing/astar.ts:68-72  — THE STEP SLOT
const tentative = g.get(current)! + costFn(edge, current, userMax);   // g: real cost so far
if (tentative < (g.get(next) ?? Infinity)) {                          // is this better?
  g.set(next, tentative);                                             // record it
  came.set(next, { edge, prev: current });                           // remember how
  open.push(next, tentative + heuristicFn(graph.nodes[next], goal));  // g + h → priority
}
```

That `tentative + heuristicFn(...)` is `g + h` — known cost plus a guess
to the goal. **This is the slot a model fills in an agent.** Hold the
two side by side:

```
  The step slot — flattr vs an agent, same seam

  ┌─ flattr (CODE decides) ──────────────────────────────────┐
  │  next = argmin over neighbors of ( g + h )               │
  │  deterministic · same input → same output · ~microseconds│
  └──────────────────────────────────────────────────────────┘
  ┌─ agent (MODEL decides) ──────────────────────────────────┐
  │  next = LLM( state, available_tools )                    │
  │  stochastic · same input → maybe different output ·      │
  │  hundreds of ms + tokens + $ + can be wrong              │
  └──────────────────────────────────────────────────────────┘
```

Everything that makes agents hard — non-determinism, cost, latency,
hallucinated next-steps — lives *in this one slot*. flattr's slot can't
hallucinate; that's the gift the contrast gives you.

#### Part 3 — EXECUTE (run the move, feed the result back)

The model (or the cost function) emits *intent*; the harness runs it. In
flattr, "execute" is expanding a node — reading its adjacency and looking
up each edge:

```ts
// features/routing/astar.ts:64-67
for (const edgeId of graph.adjacency[current] ?? []) {  // execute: read neighbors
  const edge = byId.get(edgeId)!;                        // resolve the edge
  const next = otherEnd(edge, current);
  if (closed.has(next)) continue;
```

The key safety property, which transfers exactly to agents: **the
decider never touches the tool directly.** In an agent, the model emits
`{tool: "geocode", args: {...}}` and *your harness* calls geocode — the
model never holds the network. In flattr, the cost function emits a
number and *the loop* mutates the maps — `costFn` never touches `open` or
`g`. That separation IS the control/safety boundary in both worlds.

#### Part 4 — TERMINATE (two exits, and the budget exit is the lesson)

Termination is **two exits, and naming both is the whole point.**

```ts
// SUCCESS exit — astar.ts:52
if (current === goalId) { /* reconstruct + return the path */ }

// BUDGET / empty exit — astar.ts:48 (loop guard) and :77 (fall through)
while (!open.isEmpty()) { … }
return { path: null, … };   // frontier drained → no route → stop
```

The success exit is obvious. The budget exit is the one people forget —
because *nothing guarantees you ever reach success.* Here's the part
worth saying out loud, the interview-grade observation:

**flattr's budget exit is FREE. An agent has to engineer it.**

```
  Why flattr terminates for free — and an agent doesn't

  flattr:  finite graph  +  closed set (each node decided once)
           ─────────────────────────────────────────────────────
           → the frontier MUST drain. `open.isEmpty()` WILL fire.
           → guaranteed termination, no counter needed.
           → astar.ts:51 `if (closed.has(current)) continue` and
             :67 `if (closed.has(next)) continue` are the guards
             that make the search space monotonically shrink.

  agent:   unbounded action space  +  no built-in "closed" set
           ─────────────────────────────────────────────────────
           → the model can re-pick the same tool forever (A→B→A→B…)
           → nothing drains. The loop can spin until you stop it.
           → you MUST add: max-iterations cap + token/cost ceiling.
           → without it: a silent loop burning tokens to $0 result.
```

flattr gets termination from two structural facts — the graph is finite
and the closed set guarantees each node is expanded at most once, so the
frontier can only shrink. An agent has neither: the action space is
open-ended and there's no automatic "already did this" set. The hard
iteration cap that an agent *must* bolt on is the same role `closed` +
finiteness play for free in flattr. That's why the cap isn't optional
hardening for an agent — **it's part of the skeleton**, the one
flattr happens to satisfy structurally.

#### Skeleton vs hardening

The four parts above are the irreducible kernel. Everything else is
hardening, and flattr shows you which is which:

```
  ┌─ SKELETON (kernel — can't remove) ──────────────────────┐
  │  state · step · execute · terminate(success + budget)   │
  └──────────────────────────────────────────────────────────┘
  ┌─ HARDENING (layered on top) ────────────────────────────┐
  │  • lazy deletion (astar.ts:51) — perf, not correctness  │
  │  • the id→edge index (astar.ts:12) — O(1) expansion     │
  │  • search metrics (pushes/pops) — observability         │
  │  In an agent, hardening is: retry/backoff on tool fail,  │
  │  a memory store when state outgrows the window,          │
  │  step-transition logging, structured-output validation  │
  │  before you trust action.is_final.                      │
  └──────────────────────────────────────────────────────────┘
```

flattr's `pushes`/`pops`/`nodesExpanded` counters (astar.ts:35-37) are
exactly an agent's trajectory metrics — steps taken, work done — just
measured on a deterministic loop.

### Move 2.5 — current vs future state

```
  Phase A: flattr today          Phase B: flattr + one agent feature
  ──────────────────────         ──────────────────────────────────
  search() loop, step = g+h      a NEW loop, step = LLM call, whose
  (no LLM anywhere)              TOOLS are search(), geocode(),
                                 nearestNode(), routeSummary()
                                 (see 07-routing.md + the tool seam)

  What does NOT have to change: search() itself. It becomes a tool the
  agent calls. The router loop and the agent loop coexist — the agent's
  step slot calls into flattr's deterministic loop as one of its moves.
```

The migration cost is small precisely because the router is already a
clean function. The agent loop wraps it; it doesn't rewrite it.

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination
needs **both** a success condition and a hard budget. flattr proves the
skeleton is real by instantiating it without a model — and proves the
budget exit matters by *getting it for free* through structural facts
(finite graph, closed set) that an agent doesn't have. The senior signal
is naming the budget exit unprompted: it says you've shipped a loop, not
read about one.

---

## Primary diagram

```
  The agent loop kernel, mapped onto astar.ts — one frame

  ┌─ Engine layer: features/routing/astar.ts ──────────────────────────┐
  │                                                                     │
  │  STATE (:30-33)   open · g · came · closed                          │
  │       │                                                             │
  │       ▼                                                             │
  │  ┌──────────────────────────────────────────────┐  ← while loop :48 │
  │  │ pop current = open.pop()           (:49)      │                  │
  │  │ if closed: skip  (lazy deletion)   (:51)      │                  │
  │  │ ┌── SUCCESS exit ───────────────┐  (:52)      │                  │
  │  │ │ current === goal → return path │              │                │
  │  │ └────────────────────────────────┘              │                │
  │  │ closed.add(current)                (:61)        │                │
  │  │                                                 │                │
  │  │ STEP + EXECUTE: for each neighbor  (:64-72)     │                │
  │  │   tentative = g + costFn           ← the slot   │                │
  │  │   if better: update g, came, push  ← a model    │                │
  │  │                                      fills this  │                │
  │  │                                      in an agent │                │
  │  └──────────────────────────────────────────────┘                  │
  │       │ frontier drained                                            │
  │       ▼                                                             │
  │  BUDGET / empty exit (:77) → return null                            │
  │  (FREE here: finite graph + closed set. An agent must ENGINEER it.) │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The agent loop descends from ReAct (Yao et al., 2022) — interleave
**Rea**soning and **Act**ing — but the *loop shape* is older than LLMs by
decades. A* (Hart, Nilsson, Raphael, 1968) is the same
frontier-expand-terminate skeleton. That's not a coincidence the guide is
forcing: a search algorithm and an agent are both "best-first
exploration of a state space with a termination condition." The agent
just has a fuzzier state space and a stochastic, expensive step.

The thing flattr makes vivid that LLM tutorials gloss over: **the budget
exit is structural, not incidental.** A* gets it from a finite graph and
a monotone closed set; an agent loses both and has to reintroduce the
guarantee by hand (max-iterations, cost ceiling — see
`04-agent-infrastructure/05-guardrails-and-control.md`). If you only ever
build agents, you might think the iteration cap is a safety nicety. flattr
shows it's load-bearing — it's doing the job the closed set does for free.

Read next: `01-chains-vs-agents.md` (is there a loop at all?), then
`03-react.md` (the canonical step), then `07-routing.md` (the seam where
flattr would grow one).

---

## Interview defense

**Q: What's the minimum skeleton of an agent, and which part do people
forget?**

State, step, execute, terminate — and termination is *two* exits, success
and budget. The forgotten one is the budget exit. I can show why with a
search loop I've read end to end: A* terminates for free because the
graph is finite and the closed set means each node is expanded once, so
the frontier can only drain. An agent has neither a finite action space
nor an automatic "already did this" set — so the hard iteration cap isn't
optional hardening, it's the part of the skeleton that does the job the
closed set does for free.

```
  state · step · execute · terminate
                            ├─ success: model emits is_final
                            └─ budget:  cap iterations + cost ceiling
                               (FREE in A* via finite graph + closed set;
                                ENGINEERED in an agent)
```

Anchor: *"flattr's `astar.ts:48` while loop is an agent loop with the
step slot filled by `g+h` instead of an LLM — and its budget exit is free
because the graph is finite."*

**Q: Where does the model sit, and what's the safety boundary?**

The model fills exactly one slot — `step(state) → next action`. It emits
*intent*; the harness executes. The model never touches the tool
directly. In flattr the analogue is clean: the cost function returns a
number, and *the loop* mutates the frontier — `costFn` never touches
`open`. Same separation: the decider proposes, the runtime disposes.
That boundary is the whole control story.

```
  decider (model / costFn)  ──emits intent──►  harness (loop)  ──runs──► tool
        proposes                                disposes
```

Anchor: *"In `astar.ts`, `costFn` returns a number and the loop owns the
state mutation — that's the same proposer/disposer split an agent needs
between the model and the tool harness."*

---

## See also

- `01-chains-vs-agents.md` — is there a loop at all? (pipeline vs router)
- `03-react.md` — the canonical reason→act→observe step
- `07-routing.md` — the seam: wrapping `search()` as an agent tool
- `04-agent-infrastructure/05-guardrails-and-control.md` — the budget exit
  as a control envelope
- `../agent-patterns-in-this-codebase.md` — what flattr actually is
- ReAct mechanics (cross-ref): `study-ai-engineering`'s
  `04-agents-and-tool-use/03-react-pattern.md`
- Sibling guide `study-dsa-foundations` — A*, the priority queue, the
  closed set: the search internals this file treats as one step.
