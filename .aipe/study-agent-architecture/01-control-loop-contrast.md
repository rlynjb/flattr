# The control-loop contrast: code decides vs model decides

**Industry name(s):** deterministic control loop vs agent control loop (the
chains-vs-agents boundary). **Type label:** Language-agnostic.

> **Read this as a contrast, not a claim.** A\* is **not** an agent. This file
> exists because the A\* search loop in `features/routing/astar.ts` is the one
> thing in this repo that *decides what to do next inside a loop* — and it
> decides by **code**, deterministically. That makes it the cleanest possible
> teaching foil for an **agent loop**, where a **model** decides what to do
> next. Same skeleton shape; opposite answer on one axis: *who decides the next
> step.* Once you see that axis, you understand the chains-vs-agents boundary
> better than most people who've only ever used an agent framework.

---

## Zoom out — one loop, two possible deciders

The A\* loop sits in the engine layer. It's the decision-maker of this system:
every iteration it picks which node to expand next. The question this file
asks is *who* makes that pick — and the answer here is "the code," which is
exactly what an agent is *not*.

```
  Zoom out — the deciding loop, and where a model would (not) sit

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  MapScreen.tsx issues (start, goal, userMax)              │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Engine layer ────────────▼───────────────────────────────┐
  │  ★ features/routing/astar.ts  search() loop ★             │
  │     while (!open.isEmpty()) { pop → expand → relax }       │
  │     ── the decider is CODE: priority queue + cost fn ──    │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Provider layer — DOES NOT EXIST ─────────────────────────┐
  │  [planned, gated]  an LLM that would decide the next step │
  │  instead of code — i.e. the loop turned agentic           │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** Both an A\* loop and an agent loop have the same four-part
skeleton: a frontier of pending work, a step that picks the next move, an
accumulate that records progress, and a termination test. The only thing that
differs is the step function — a `pop()` from a priority queue (code) vs a
single LLM call (model). Hold that one axis still and the whole boundary
becomes obvious.

---

## How it works — the same skeleton, two step functions

### Move 1 — the mental model

You already know the shape: it's the BFS/Dijkstra frontier loop you've built
(grid graph, river-crossing puzzle, the Dijkstra animation backed by your
`PriorityQueue.ts`). Dequeue the best pending node, expand its neighbors, push
the improved ones back, stop when you pop the goal or the frontier empties. An
agent loop is **that exact shape** with one box swapped: the "pick the next
move" box is an LLM call instead of a `pop()`.

```
  Pattern — one loop kernel, two deciders on the "step" box

         ┌─────────────────────────────────────────┐
         │  while not done:                         │
         │    next = STEP(state)   ◄── the only      │
         │    if next.is_final: return out           │   difference
         │    result = EXECUTE(next)                 │
         │    state  = ACCUMULATE(state, result)     │
         │    if BUDGET_EXCEEDED: stop               │
         └─────────────────────────────────────────┘
                         │
            ┌────────────┴─────────────┐
            ▼                          ▼
   STEP = pop() from PQueue     STEP = one LLM call
   (CODE decides — A*)          (MODEL decides — agent)
   deterministic, replayable    nondeterministic, variable cost
```

### Move 2 — the four parts, named by what breaks

This is the load-bearing-skeleton treatment. Both loops have these four parts;
naming them by what breaks when each is missing is how you see they're the
same machine.

**The frontier / state — what makes it a loop at all.**
In A\* it's the open priority queue plus the `g` (cost-so-far) and `came`
(came-from) maps. Drop it and every iteration is amnesiac — you have N
independent expansions, not a search. In an agent it's the accumulated context
(scratchpad, observations). Drop it and you have N independent LLM calls, not a
loop. **State is the thing that makes either one a loop.**

```
  Execution trace — A* state accumulating (the loop part)

  start S, goal G       open = [S]            g{S:0}
  pop S  → expand A,B    open = [A,B]          g{A:3, B:5}   came{A:S, B:S}
  pop A  → expand B,G    open = [B,G]          g{B:4(↓), G:9} came{B:A, G:A}
  pop B  → expand G      open = [G]            g{G:8(↓)}      came{G:B}
  pop G  == goal         → reconstruct via came → STOP

  each row carries forward the last row's g/came — that carry-forward
  IS the loop; without it, every pop starts from nothing
```

**The step function — the only "decider."**
In A\* the decider is the priority queue: `open.pop()` returns the
lowest-`f`-score node, deterministically, every time
(`features/routing/astar.ts:49`). Given the same graph and `userMax`, it makes
the identical choices on every run — replayable, debuggable by re-running. In
an agent, the decider is one LLM call: `step(state)` returns "call this tool"
or "I'm done." Given the same state, it may choose differently across runs —
nondeterministic, debuggable only by inspecting the trajectory. **This box is
the entire chains-vs-agents boundary.** Same slot, opposite control axis.

**Execute — run the chosen move.**
In A\* this is edge relaxation: for each neighbor, compute `tentative = g[cur]
+ costFn(edge, ...)` and push if it improves (`astar.ts:64-74`). The cost
function — a deterministic grade penalty — is part of the engine. In an agent,
execute is "run the tool the model asked for," and the model **never touches
the tool directly** — the harness runs it and feeds the result back. That
indirection is the agent's control/safety story. In A\*, there's no safety
story to tell, because there's no external actor to mediate — code calls code.

**Termination — and here's the part people forget.**
A\* has two clean exits, both pure functions of the search state: **success**
(`current === goalId`, `astar.ts:52`) and **frontier-empty** (`while
(!open.isEmpty())` falls through to `return { path: null }`, `astar.ts:48,77`).
Because the graph is finite and the closed set prevents revisiting
(`astar.ts:51,61,67`), A\* is *guaranteed* to hit one of those exits. **That
guarantee is exactly what an agent loop lacks.** An agent's success exit
(model emits final output) is not guaranteed — nothing stops a model from
cycling tool calls forever — so an agent needs a **budget exit** (max
iterations / token ceiling) as part of its skeleton, not as bolt-on hardening.
The interview-grade point: A\* gets termination *for free* from graph
finiteness; an agent has to *impose* it with a hard iteration cap. Naming that
budget exit unprompted is the signal you've shipped an agent loop. The repo
teaches the opposite lesson by contrast — when code decides, the structure of
the problem can guarantee termination; when a model decides, you must bound it
yourself.

### Move 2.5 — current state vs future state

```
  Comparison — the deciding box, now vs if this loop went agentic

  ┌─ NOW (shipped) ───────────────┐   ┌─ FUTURE (planned, gated) ──────┐
  │ STEP = open.pop()             │   │ STEP = one LLM call            │
  │ decider: CODE                 │   │ decider: MODEL                 │
  │ deterministic, replayable     │   │ nondeterministic, variable     │
  │ terminates by graph finiteness│   │ needs an iteration cap          │
  │ astar.ts:48-77                │   │ spec §8: "No LLM layer in v1"  │
  └───────────────────────────────┘   └────────────────────────────────┘
```

What *wouldn't* change if an agent were ever added: the A\* loop stays a
deterministic tool. The agent wouldn't replace the search — it would *call* it
(that's [`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md)).
The deciding box that goes agentic is the *outer* one (which addresses to
geocode, whether to re-route), never the inner A\* expansion. **You don't make
A\* agentic; you wrap it.**

### Move 3 — the principle

The chains-vs-agents boundary lives on one axis: *who decides the next step,
code or a model.* Everything else — frontier, accumulate, execute, terminate —
is shared skeleton. When code decides, you often get determinism and
free termination from the problem's structure; when a model decides, you trade
both away for flexibility and must re-impose a hard budget by hand. This repo
sits firmly on the "code decides" side, and that's the right call for
deterministic shortest-path.

---

## Primary diagram

The full recap: one loop skeleton, the deciding box swapped, every consequence
labeled.

```
  Control-loop contrast — flattr's A* (shipped) vs an agent loop (planned)

  ┌──────────────── shared skeleton ────────────────┐
  │  state  →  STEP  →  EXECUTE  →  ACCUMULATE  →  ⟲ │
  │                                  └─ terminate ───┘│
  └───────────────────┬───────────────┬──────────────┘
                      │               │
        ┌─────────────▼──────┐  ┌─────▼─────────────────┐
        │ A* (engine layer)  │  │ agent (provider layer,│
        │ STEP = pop()       │  │  DOES NOT EXIST)      │
        │ CODE decides       │  │ STEP = LLM call       │
        │ deterministic      │  │ MODEL decides         │
        │ term: graph finite │  │ nondeterministic      │
        │ astar.ts:48-77     │  │ term: NEEDS budget cap│
        └────────────────────┘  └───────────────────────┘
              shipped                   planned / gated
```

---

## Implementation in codebase

**Use case.** Every route request runs this loop exactly once:
`MapScreen.tsx` hands `(startId, goalId, userMax)` to a stage wrapper
(`directedAstar`, `astar.ts:156`), which calls `search()`. The loop expands
nodes until it pops the goal, then reconstructs the path. Deterministic: same
inputs, same path, every time — which is why the repo's tests
(`features/routing/*.test.ts`) can assert exact paths.

```
  features/routing/astar.ts  (lines 48–77, the loop kernel)

  while (!open.isEmpty()) {            ← frontier-empty = termination #2
    const current = open.pop()!;       ← STEP: CODE decides next node
    if (closed.has(current)) continue; ← skip stale duplicates (lazy deletion)
    if (current === goalId) {          ← termination #1: success exit
      ... return summarizePath(...);   ← reconstruct + return optimal path
    }
    closed.add(current);               ← never revisit → guarantees termination
    for (const edgeId of graph.adjacency[current] ?? []) {
      const edge = byId.get(edgeId)!;
      const next = otherEnd(edge, current);
      if (closed.has(next)) continue;
      const tentative = g.get(current)! + costFn(edge, current, userMax);  ← EXECUTE
      if (tentative < (g.get(next) ?? Infinity)) {   ← relax: is this cheaper?
        g.set(next, tentative);                       ← ACCUMULATE cost-so-far
        came.set(next, { edge, prev: current });      ← ACCUMULATE path
        open.push(next, tentative + heuristicFn(...)); ← push back to frontier
      }
    }
  }
  return { path: null, ... };          ← frontier exhausted, no route
        │
        └─ the closed set (line 61) + finite graph is what guarantees this
           loop terminates — an agent loop has no such guarantee, which is
           why it needs an explicit iteration cap instead
```

The `pop()` is the load-bearing contrast point: it's deterministic node
selection by `f`-score. Swap it for an LLM call and you have an agent — and you
lose the termination guarantee that the closed set + finite graph give you here
for free.

---

## Elaborate

A\* (Hart, Nilsson, Raphael, 1968) is best-first graph search with an
admissible heuristic — the haversine lower bound here (`astar.ts:9`), which
this repo keeps admissible by construction (penalty ≥ 0, a must-not-change
constraint). The agent control loop (ReAct: Yao et al., 2022) is a much later
idea from a different field, but it borrowed the *loop shape* from exactly this
lineage of search — frontier, expand, terminate. The genuine insight worth
carrying: "agentic" is not a new control primitive, it's the old loop with the
deciding box handed to a model. When you next read an agent framework, find the
four parts and ask which box is the model and where the budget cap lives.

Read next: [`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md)
for where a model *would* attach to this engine.

---

## Interview defense

**Q: "Is your A\* router an agent?"**
No — and the reason is one axis. Both have the same loop skeleton, but in A\*
the step function is a deterministic priority-queue `pop()`
(`astar.ts:49`); in an agent it's an LLM call. Code decides the next step, not
a model. That's the whole chains-vs-agents boundary.

```
  shared loop → swap STEP → pop()=code(A*) | LLM=model(agent)
```

**Q: "Your agent loop never terminates — what did you forget?"**
The budget exit. A search loop gets termination free from a finite graph plus a
closed set (`astar.ts:48,61`). An agent has no such guarantee — the model can
cycle tool calls forever — so the iteration cap / token ceiling is *part of the
skeleton*, not hardening you add later.

```
  A*: success | frontier-empty (guaranteed by finite graph)
  agent: success | BUDGET CAP (must impose by hand)
```

One-line anchor: *same loop, the only difference is whether code or a model
fills the STEP box — and the model-driven version has to be budgeted because
nothing else bounds it.*

---

## Validate

1. **Reconstruct.** From memory, draw the four-part loop skeleton and label
   which box differs between A\* and an agent. (Answer: the STEP box —
   `open.pop()` at `astar.ts:49` vs an LLM call.)
2. **Explain.** Why does A\* terminate without an explicit cap while an agent
   needs one? (Closed set + finite graph, `astar.ts:48,61`, vs a model that can
   loop indefinitely.)
3. **Apply.** A teammate says "let's make the A\* search itself agentic so it
   finds smarter routes." What's wrong with that, and what's the right shape?
   (You don't make the inner search agentic — that loses determinism and
   admissibility; you wrap it as a tool an outer agent calls. See
   [`02`](02-router-as-agent-tool-seam.md).)
4. **Defend.** Justify why this repo correctly has no agent loop. (A
   shortest-path query over a fixed graph is a deterministic computation
   (`astar.ts:22`); the steps don't depend on what a model "finds." A chain is
   the right tool; spec §8 agrees.)

---

## See also

- [`00-overview.md`](00-overview.md) — the no-agent verdict and full inventory.
- [`02-router-as-agent-tool-seam.md`](02-router-as-agent-tool-seam.md) — where a
  model *would* attach: the router as a tool.
- `.aipe/study-dsa-foundations/` — A\*, priority queues, admissible heuristics
  as classical algorithms (the deterministic side of this contrast).
- `.aipe/study-system-design/` — the chain-shaped engine pipeline this loop
  sits inside.
