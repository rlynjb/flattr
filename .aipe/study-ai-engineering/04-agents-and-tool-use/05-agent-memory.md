# Agent memory — N/A: flattr is stateless per route

**Industry name(s):** agent memory (short-term in-context / long-term retrieved).
**Type:** Industry standard.

## Zoom out — flattr keeps no memory across routes; each route is a pure function of inputs

Agent memory is what lets an agent carry context: short-term (the
conversation so far, in the window) and long-term (past facts pulled from
a store per turn). Both presuppose an agent that runs over time and
remembers. flattr has neither — a route is computed fresh from
`(start, end, userMax, graph)` every time, and nothing about route N
influences route N+1. It's stateless by construction.

```
  Zoom out — every route is a pure function, no carried state

  ┌─ inputs (per route) ────────────────────────────────────┐
  │  startId · endId · userMax · graph                       │
  └────────────────────────────┬─────────────────────────────┘
                  pure recompute (no memory)
  ┌─ engine ───────────────────▼─────────────────────────────┐
  │  directedAstar(graph, startId, endId, userMax)            │ MapScreen.tsx:155
  │  ★ nothing remembered between routes — stateless          │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** inputs → A* recompute → render. No persistence layer feeds
  back in.
- **Axis — what persists between invocations?** Agent memory: short-term
  (window) and long-term (store) both persist. flattr: nothing persists
  into the next route; the only state is React UI state for the *current*
  view. Trace "what survives to the next route" and the answer is nothing.
- **Seam:** none for memory. The `useMemo` over `[graph, startId, endId,
  userMax]` (`MapScreen.tsx:162`) is a *recompute cache* keyed on inputs —
  not memory of past results, just memoization of the current one.

## How it works

### Move 1 — the mental model

You know a pure function — same inputs, same output, no hidden state.
That's flattr's router. Agent memory is the opposite: state that
accumulates so the agent's behavior depends on its history. Short-term
memory is the conversation buffer; long-term memory is RAG inside the
agent, retrieving past facts per turn. flattr carries none of it — each
route is a clean recompute.

```
  Pattern — agent memory (stateful) vs flattr (pure)

  agent:  turn N uses short-term (window) + long-term (retrieved store)
          behavior depends on HISTORY
  flattr: route(start, end, userMax, graph) → path
          same inputs → same path · no history       MapScreen.tsx:155
```

### Move 2 — the walkthrough

**flattr's route is a pure recompute.** `MapScreen.tsx:155–162`:

```ts
const r = directedAstar(graph, startId, endId, userMax);   // depends ONLY on inputs
// ...
return { fc: ..., summary: ..., found: true };
}, [graph, startId, endId, userMax]);                       // memo key = the inputs
```

The `useMemo` dependency array *is* the full set of things that affect the
result. There's no store of past routes, no "remember the user prefers
flatter," no cross-session state feeding the computation. Change nothing,
get the identical route; this is memoization, not memory.

```
  Layers-and-hops — pure recompute, no memory store

  ┌─ UI ──────┐ inputs only      ┌─ engine ──────────────┐
  │MapScreen  │ ─────────────────►│ directedAstar          │ :155
  │ useMemo   │ ◄─────────────────│ path (function of in)  │
  └───────────┘  no past-route store feeds back here
```

**The boundary condition.** The honest line: flattr *does* hold state —
React UI state (`userMax`, the focused field, the current endpoints) — but
that's *current-view* state, not *memory* in the agent sense. Agent memory
specifically means state that persists across invocations to inform future
behavior. flattr's `userMax` is a current setting, not a learned
preference; nothing records that you took flat routes last week. If flattr
ever added "remember my grade preference," *that* would be the first
long-term memory — and it'd be a stored setting, not an in-context buffer.

### Move 3 — the principle

Agent memory exists because agents act over time and need continuity —
short-term for coherence within a task, long-term for knowledge across
tasks. A stateless, pure computation needs neither: same inputs, same
output, no history to carry. flattr is firmly the latter. The principle:
add memory only when behavior should depend on history — a pure recompute
that's correct without it shouldn't carry state it doesn't use.

## Primary diagram

```
  flattr is stateless per route — no memory layers

  ┌─ agent memory (NOT BUILT) ───────────────────────────────┐
  │ short-term: conversation in window                        │
  │ long-term: past facts retrieved per turn                  │
  └──────────────────────────────────────────────────────────┘
  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ route = f(start, end, userMax, graph)  [MapScreen.tsx:155]│
  │ useMemo([inputs]) = recompute cache, NOT memory [:162]    │
  │ React UI state = current view, NOT cross-route memory     │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Agent memory is what separates a chatbot that forgets every turn from one
that builds context — short-term for the current task, long-term (RAG
inside the agent) for persistent knowledge. flattr is the stateless
counter-example: a pure routing function whose only "state" is
input-keyed memoization. The transferable distinction is memoization vs
memory — a cache keyed on inputs is not history; agent memory is state
that *changes future behavior*, and flattr has none.

## Interview defense

**Q: What's flattr's memory model?** Answer: stateless. A route is a pure
function of `(start, end, userMax, graph)` — `directedAstar`
(`MapScreen.tsx:155`), memoized on exactly those inputs (`:162`). There's
no short-term buffer and no long-term store; nothing about one route
affects the next. The `useMemo` is a recompute cache, not memory, and
React UI state is current-view, not cross-route history. Load-bearing
distinction: memoization keyed on inputs is not memory — agent memory is
state that changes future behavior, which flattr deliberately has none of.

```
  route = f(inputs); useMemo([inputs]) = cache ≠ memory (no history)
```

Anchor: *"flattr is stateless per route — a pure function plus
input-keyed memoization; nothing persists to influence the next route."*

## See also

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — the stateless fixed chain.
- [03-react-pattern.md](03-react-pattern.md) — no reasoning loop to accumulate state in.
- [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) — long-term memory is RAG inside an agent; flattr needs neither.
