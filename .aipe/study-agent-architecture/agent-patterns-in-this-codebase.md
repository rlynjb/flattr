# Agent patterns in this codebase — the router-as-tool seam

## The plain statement

**This codebase does not currently use any autonomous agent loop.** There is
no LLM, no tool-calling, no model-decided control flow, and no multi-agent
topology. Every step in flattr is decided by engineer-written code: the build
pipeline is a fixed chain of pure transforms, and the router is a control
loop where the A* cost rule decides each step.

The patterns below are covered as *study material* and as a *future seam*.
The one genuinely interesting thing flattr has, from an agent-architecture
view, is that its router is already shaped like an agent's tool layer. This
file maps that seam concretely — the exact function signatures an LLM agent
would call, and the one feature that would justify wrapping them.

## Agent patterns table

```
  ┌──────────────────────┬──────────────────┬──────────────────────────┐
  │ Feature              │ Pattern / shape  │ Why this pattern          │
  ├──────────────────────┼──────────────────┼──────────────────────────┤
  │ build pipeline       │ chain (no model) │ steps known in advance;   │
  │ (pipeline/run-build) │                  │ pure transforms           │
  ├──────────────────────┼──────────────────┼──────────────────────────┤
  │ routing (search)     │ control loop     │ a loop, but CODE decides  │
  │ (features/routing/   │ (NOT an agent)   │ each step via A* cost     │
  │  astar.ts)           │                  │ rule — deterministic      │
  ├──────────────────────┼──────────────────┼──────────────────────────┤
  │ (none)               │ single-agent     │ NOT YET EXERCISED         │
  │                      │ ReAct            │                          │
  ├──────────────────────┼──────────────────┼──────────────────────────┤
  │ (none)               │ multi-agent      │ NOT YET EXERCISED         │
  └──────────────────────┴──────────────────┴──────────────────────────┘
```

Neither feature names a model in any decision. The control envelope on the
router is the A* admissibility invariant and the `BLOCKED` large-finite
sentinel (steep-but-reachable stays distinct from disconnected) — both
deterministic guards, not agent guardrails.

---

## The seam: flattr's router is already a tool layer

Here's the part worth studying. An LLM agent needs tools, and a *good* tool
is a well-typed, side-effect-free, single-purpose function with typed inputs
and typed outputs. flattr's router functions are *exactly that already.* Look
at the signatures — these are agent tools that happen not to have an agent
calling them yet.

### The four tool-shaped functions (real signatures)

```
  flattr's router functions — already tool-shaped

  ┌─ search() ─ features/routing/astar.ts:22 ─────────────────┐
  │  search(graph, startId, goalId, userMax, costFn, heur)    │
  │    → SearchResult { path: Path|null, nodesExpanded, ... } │
  │  pure, deterministic, no I/O, fully tested                │
  └───────────────────────────────────────────────────────────┘
  ┌─ routeSummary() ─ features/routing/summary.ts:11 ─────────┐
  │  routeSummary(graph, path, userMax)                       │
  │    → { distanceM, climbM, steepCount }                    │
  │  human-facing totals; pure                                │
  └───────────────────────────────────────────────────────────┘
  ┌─ geocode() ─ pipeline/geocode.ts:9 ──────────────────────┐
  │  geocode(query, opts?) → Promise<GeocodeResult | null>   │
  │    GeocodeResult = { lat, lng, label }                    │
  │  the ONE function with a network hop (Nominatim)          │
  └───────────────────────────────────────────────────────────┘
  ┌─ nearestNode() ─ features/routing/nearest.ts:5 ──────────┐
  │  nearestNode(graph, point) → string (nodeId)             │
  │  snaps a coordinate to the graph; pure                    │
  └───────────────────────────────────────────────────────────┘
```

Each one passes the "is this a good tool?" test:

- **Typed input, typed output.** `geocode(query) → {lat, lng, label} | null`
  is already the JSON-shaped contract a tool schema describes. No parsing of
  free-form strings, no ambiguous returns.
- **Single responsibility.** `search` finds a path. `routeSummary` totals it.
  `geocode` resolves an address. `nearestNode` snaps a coordinate. Each does
  one thing — exactly what you want when a model has to decide *which* tool.
- **Side-effect discipline.** Three of the four are pure (no I/O, no
  mutation). Only `geocode` touches the network, and it's the one that would
  need a circuit breaker if an agent called it in a loop. That clean split
  (pure tools vs the one network tool) is the side-effect boundary an agent's
  guardrails would key on.

### What the agent would add — and what it would NOT touch

```
  Phase A (now)                  Phase B (a planner agent)
  ─────────────                  ──────────────────────────
  someone calls these            a MODEL decides which to call,
  functions directly             in what order, when to stop
  (mobile UI, tests)

  ┌─ the four functions ─┐       ┌─ the four functions ─┐
  │ search / summary /   │  ═══► │ search / summary /   │  ◄── UNCHANGED
  │ geocode / nearest    │       │ geocode / nearest    │      (now "tools")
  └──────────────────────┘       └──────────┬───────────┘
                                            │ called as tools
                                 ┌──────────▼───────────┐
                                 │ a ReAct loop (NEW)   │
                                 │ step = model.decide  │
                                 │ budget = iter cap     │
                                 └──────────────────────┘
```

The takeaway is *what doesn't change*: the router. You'd add a loop (the
skeleton from `01-reasoning-patterns/02-agent-loop-skeleton.md`) and a thin
tool-schema wrapper around each function, and the existing, tested router
code stays byte-for-byte the same. That's the payoff of having tool-shaped
functions before you have an agent — the seam is pre-cut.

---

## The one feature that would cross into agent territory

**"Plan me a flat afternoon route with three coffee stops."** This is the
single flattr feature that genuinely needs a model-decided loop, because the
stops, their order, and the routing between them aren't known until the model
reasons about the request.

```
  Layers-and-hops — the hypothetical planner agent

  ┌─ UI ──────────┐  "flat afternoon, 3 coffee stops"
  │ MapScreen     │ ─────────────────────────────────┐
  └───────────────┘                                  │
  ┌─ Agent loop (NEW — Service layer) ───────────────▼──────┐
  │  step: model decides next tool call                     │
  │   turn 1 → geocode("coffee near X")  → candidate stops  │
  │   turn 2 → nearestNode(stop) ×3      → graph node ids    │
  │   turn 3 → search(graph, a, b, userMax, gradeCost, h)   │
  │            ×N legs                    → flat paths       │
  │   turn 4 → routeSummary(...)         → totals per leg    │
  │   terminate: model emits final plan OR iteration cap    │
  └────────────────────────────┬────────────────────────────┘
                              │ tool calls (no model touches graph directly)
  ┌─ Tools (UNCHANGED router) ─▼───────────────────────────┐
  │  geocode · nearestNode · search · routeSummary         │
  └─────────────────────────────────────────────────────────┘
```

Even this stays **single-agent** — one ReAct loop, not a multi-agent
topology (see `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`
for why the sub-tasks are sequential tool calls, not independent
specialties). The control envelope it would need: an iteration cap (the
budget exit flattr's `search()` gets for free but an agent must engineer), a
circuit breaker on `geocode` (the one network tool), and output validation
before trusting the model's final plan.

## Where each not-yet-exercised pattern would attach

```
  ┌──────────────────────────┬────────────────────────────────────┐
  │ Pattern (not yet present) │ Attachment point in flattr         │
  ├──────────────────────────┼────────────────────────────────────┤
  │ single-agent ReAct loop   │ wrap router fns as tools; new loop  │
  │                          │  in features/ (planner feature)     │
  ├──────────────────────────┼────────────────────────────────────┤
  │ agentic retrieval / RAG   │ no knowledge corpus exists; would   │
  │                          │  need a doc store + embeddings first │
  ├──────────────────────────┼────────────────────────────────────┤
  │ agent memory tiers        │ no persistence layer (graph.json is │
  │                          │  read-only); would need a store      │
  ├──────────────────────────┼────────────────────────────────────┤
  │ multi-agent topology      │ no decomposable model problem exists │
  ├──────────────────────────┼────────────────────────────────────┤
  │ trajectory / tool evals   │ bench/ measures search perf today;  │
  │                          │  agent evals would attach there      │
  ├──────────────────────────┼────────────────────────────────────┤
  │ guardrails / control env  │ iteration cap + circuit breaker on  │
  │                          │  geocode + output schema validation  │
  └──────────────────────────┴────────────────────────────────────┘
```

## See also

- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop you'd wrap the tools in
- `01-reasoning-patterns/01-chains-vs-agents.md` — why the current router isn't an agent
- `06-orchestration-system-design-templates/02-agentic-support-system.md` — the planner as a template
- `study-system-design` — the router functions as service boundaries
- `study-ai-engineering` — tool-calling mechanics (the model side of this seam)
