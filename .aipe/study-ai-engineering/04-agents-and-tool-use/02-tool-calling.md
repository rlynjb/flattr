# Tool Calling
### The model names a function; your code runs it (orchestration / study material)

## Zoom out

```
TOOL CALLING — the contract
┌─────────────────────────────────────────────────────────┐
│  1. you DESCRIBE tools (name, JSON schema)                │
│  2. LLM EMITS  { tool: "geocode", input: {q: "..."} }    │
│  3. YOUR CODE  runs the real function, gets a result      │
│  4. result GOES BACK as an observation                    │
│  5. LLM uses it (answers, or calls another tool)          │
└─────────────────────────────────────────────────────────┘
the LLM never executes anything — it only PROPOSES.
```

Tool calling is how a text-only model reaches the outside world: it emits a
structured request, your runtime executes it, and the result is fed back. You've
shipped this (AdvntrCue). The leverage here is recognizing that flattr's pure
functions are *already in the right shape* to be tools — typed I/O, no hidden
state — even though nothing calls them as tools.

## How it works

### Move 1 — what makes a function "tool-shaped"

```
GOOD TOOL                        BAD TOOL
typed input  ─▶ fn ─▶ typed out  ambiguous args ─▶ fn ─▶ side effects
no hidden state                  reads globals, mutates the world
deterministic                    nondeterministic
easy to describe in a schema     hard to schema, hard to trust
```

Fast read: a clean tool is a pure function with a name. The model can only call
what you can *describe*, and you can only safely describe what is predictable. Side
effects and hidden state are what make tools dangerous and hard to schema.

### Move 2 — flattr's functions, viewed as tools

```
ALREADY TOOL-SHAPED (pure, typed) — but NOTHING calls them as tools
┌────────────────────────────────────────────────────────────┐
│ geocode(query) ─▶ { lat, lng, label }     pipeline/geocode.ts│
│   typed in/out, only side effect is the network fetch        │
├────────────────────────────────────────────────────────────┤
│ routeSummary(graph, path, max) ─▶         summary.ts:11      │
│   { distanceM, climbM, steepCount }   pure, no side effects  │
├────────────────────────────────────────────────────────────┤
│ search(...) the router itself ─▶ Path     astar.ts          │
│   pure given the graph                                       │
└────────────────────────────────────────────────────────────┘
       these are the tools an agent WOULD call — if one existed.
```

Step by step: each of these takes typed arguments and returns a typed result. To
expose `geocode` as a tool you'd write a schema (`{ q: string }` → `{lat,lng,label}`)
and let the model emit that shape. The function body wouldn't change at all — it's
already the right shape. That's the honest connection: **tool-shaped ≠ tool-called.**

### Move 3 — the principle

Design functions as if a model might one day call them: name them by intent, give
them typed boundaries, keep side effects at the edge. You get testability today and
tool-readiness for free. The hard part of tool calling isn't the call — it's having
clean, describable seams. flattr has those; it just has no caller.

## In this codebase

**NOT YET EXERCISED.** No LLM, no tool-call loop, no schemas. But this is flattr's
*strongest* honest connection to the agent world: `geocode` (pipeline/geocode.ts:9)
and `routeSummary` (features/routing/summary.ts:11) are already pure, typed,
single-purpose — exactly the shape you'd register as tools.

Real seam: if you built tool calling here, those two functions plus the router
(`features/routing/astar.ts`) are the tool set. Nothing emits `{tool, input}` today,
so it stays study material — but the seam is genuinely clean, not invented.

One caution carried forward: `geocode`'s `label` is OSM `display_name`, untrusted
input. As a tool result it flows back into a prompt — see `06-error-recovery.md` and
the injection note in the prompt-engineering section.

## See also
- `01-agents-vs-chains.md` — tools are what an agent's loop calls
- `04-tool-routing.md` — choosing *which* tool to call
- `pipeline/geocode.ts:9` · `features/routing/summary.ts:11` — the tool-shaped seams
