# Tool calling and MCP

**Industry names:** tool calling · function calling · MCP (Model Context
Protocol). **Type:** Industry standard. **In this codebase:** the *tools*
are real and pre-cut (`search`, `geocode`, `nearestNode`, `routeSummary`);
the *calling* (a model invoking them) is **Not yet implemented**.

> The connective tissue under every pattern. Mechanics are in
> `study-ai-engineering`. This file's job: place tool calling as the
> substrate, and show flattr's four functions as already-shaped tools.

---

## Zoom out, then zoom in

**Zoom out.**

```
  Zoom out — tool calling is the substrate every pattern runs on

  ┌─ reasoning patterns (A) ──┐
  │ ReAct, plan-execute …     │  all emit → tool calls
  └─────────────┬─────────────┘
  ┌─ multi-agent topologies (C) ┐
  │ supervisor, swarm …         │  all run on → tool calls
  └─────────────┬───────────────┘
                ▼
         ┌──────────────┐
         │ TOOL CALLING │  the model emits {tool, args};
         │  substrate   │  YOUR harness runs it
         └──────────────┘
```

**Zoom in.** A tool is a typed function the model can request by name. The
model emits intent (`{tool: "geocode", args: {...}}`); the harness
executes. MCP standardizes how agents connect to tools so a tool defined
once works across agents without per-agent integration.

---

## How it works

### Move 1 — the mental model

A good tool is a single-purpose, well-typed, mostly-pure function — and
flattr already has four:

```
  flattr's pre-cut tools (real signatures, real file:line)

  search(graph, startId, goalId, userMax, costFn, heuristicFn)
      : SearchResult                                  ← astar.ts:22  (pure)
  routeSummary(graph, path, userMax): RouteSummary    ← summary.ts:11 (pure)
  nearestNode(graph, point): string                   ← nearest.ts:5  (pure)
  geocode(query, opts): Promise<GeocodeResult|null>   ← geocode.ts:9  (NETWORK)
```

### Move 2 — what makes them good tools, and the one that's different

Three properties make these "pre-cut":

```
  ┌─ typed ────────────────────────────────────────────────┐
  │ each has a precise input/output type — the tool schema  │
  │ writes itself from the signature                        │
  ├─ single-purpose ───────────────────────────────────────┤
  │ search routes, geocode resolves, nearestNode snaps —    │
  │ one job each, the model picks cleanly                   │
  ├─ mostly pure ──────────────────────────────────────────┤
  │ search/routeSummary/nearestNode are pure (graph in,     │
  │ value out) → safe to call, cache, retry, parallelize    │
  └─────────────────────────────────────────────────────────┘
```

The odd one out is `geocode` — it's the **only tool with a network side
effect** (Nominatim, `geocode.ts:21`). That single fact decides everything
about hardening: the three pure tools are free to retry and cache; `geocode`
needs the circuit breaker
(`../05-production-serving/03-per-tool-circuit-breaking.md`) and respects
Nominatim's ~1 req/sec policy. The MCP decision (MCP vs direct definitions
vs a tool gateway) would matter if these tools were shared across agents;
for flattr's single planned loop, direct definitions are enough — the
token overhead of MCP isn't justified for four local functions.

### Move 3 — the principle

A tool is a typed single-purpose function the model requests by name; the
harness runs it, the model never does. flattr's functions are already that
shape — which is why turning flattr agentic is "register four tools," not
"rewrite the engine." The purity of three and the side effect of one
dictate the entire hardening story.

---

## Interview defense

**Q: Are flattr's functions ready to be agent tools?**

Three of four are ideal — `search`, `routeSummary`, `nearestNode` are pure,
typed, single-purpose, so they're safe to call, cache, retry, parallelize,
and their schemas write themselves from the signatures. The fourth,
`geocode`, has a network side effect — so it gets the circuit breaker and
the rate-limit, where the others don't. Direct tool definitions suffice;
MCP's overhead isn't worth it for four local functions.

Anchor: *"flattr's `search`/`routeSummary`/`nearestNode` are pure typed
tools; `geocode` is the one network tool — that purity split is the whole
hardening story."*

---

## See also

- `../01-reasoning-patterns/07-routing.md` (the seam that calls these)
- `../05-production-serving/03-per-tool-circuit-breaking.md` (geocode's breaker)
- `05-guardrails-and-control.md`
- Mechanics (cross-ref): `study-ai-engineering`'s tool-calling file
