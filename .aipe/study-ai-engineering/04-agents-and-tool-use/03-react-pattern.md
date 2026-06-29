# The ReAct Pattern
### Thought → Action → Observation, on repeat (orchestration / study material)

## Zoom out

```
ReAct LOOP (LLM-driven)               flattr's LOOP (algorithm-driven)
┌──────────────────────┐             ┌──────────────────────────┐
│ Thought  reason       │            │ pop cheapest node from PQ │
│   ▼                   │            │   ▼                       │
│ Action   call a tool  │            │ relax its neighbors       │
│   ▼                   │            │   ▼                       │
│ Observation  read out │            │ push updated costs        │
│   └──────── loop ─────┘            │   └──── loop until goal ──┘│
│ stop = model decides   │           │ stop = goal popped / empty │
└──────────────────────┘             └──────────────────────────┘
   LEARNED decision each step           PROVEN decision each step
```

ReAct interleaves *reasoning* (Thought) with *acting* (tool call) and *seeing*
(Observation), looping until the model judges it's done. Both ReAct and A* are
loops that expand a frontier — but one expands it by a *learned* policy and one by
a *proven* priority rule. That contrast is the whole lesson here.

## How it works

### Move 1 — the mental model: two loops, two deciders

```
WHO PICKS THE NEXT EXPANSION?
ReAct:  the LLM, from natural-language reasoning  (may err, may loop forever)
A*:     the priority queue, by f = g + h         (optimal if h admissible)
```

Fast read: ReAct is search where the heuristic *is an LLM*. A* is search where the
heuristic is a math function you can prove. Same skeleton (frontier + expand +
stop), opposite guarantees.

### Move 2 — flattr's real loop, step by step

```
features/routing/astar.ts  +  pqueue.ts (lazy-deletion min-heap)
┌───────────────────────────────────────────────────────────┐
│ while PQ not empty:                                         │
│   node = PQ.pop()         ← "Action": pick cheapest frontier│
│   if node == goal: done   ← deterministic stop              │
│   for next in neighbors:  ← "Observation": real edge costs  │
│     tentative = g[node] + cost(edge)                        │
│     if tentative < g[next]:        astar.ts:69              │
│       g[next] = tentative; PQ.push(next, g+h)               │
└───────────────────────────────────────────────────────────┘
no Thought step — the "reasoning" is the cost function + heuristic, fixed in code.
```

There's no language model forming a hypothesis. The "decision" each iteration is
`PQ.pop()` returning the lowest `f` — pure arithmetic. The loop is bounded by the
graph: it terminates when the goal is popped or the frontier empties.

### Move 3 — the principle

ReAct trades guarantees for generality: it can tackle open-ended tasks A* can't
phrase, but it can hallucinate a step, loop, or stop early — so it needs a max-iteration
guard (see `06-error-recovery.md`). A* can't improvise, but within its problem it's
optimal and always terminates. Pick the loop whose failure mode you can live with.

## In this codebase

**NOT YET EXERCISED — and structurally N/A.** flattr has no LLM reasoning loop. Its
only loop is A*'s priority-queue expansion in `features/routing/astar.ts` (cost
update at `astar.ts:69`) backed by the heap in `features/routing/pqueue.ts`.

The teaching contrast is the value: both ReAct and A* are *frontier-expansion loops
with a stop condition*. Swap the decider — proven heuristic vs learned policy — and
you've turned one into the other. flattr is the proven-heuristic end of that axis.
No attach point for a Thought/Action/Observation loop; flattr is deterministic
search, not LLM reasoning.

## See also
- `01-agents-vs-chains.md` — who owns the control flow
- `06-error-recovery.md` — ReAct's max-iteration guard; flattr's BLOCKED sentinel
- `features/routing/astar.ts` · `features/routing/pqueue.ts` — the real loop
