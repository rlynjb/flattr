# Routing — the seam where flattr grows an agent

**Industry names:** intent routing · LLM router · tool/agent router.
**Type:** Industry standard.

> Routing is the front door of the one concrete agent feature flattr
> could grow: "plan a flat afternoon with 3 coffee stops." The router
> picks which handler/tool runs — and flattr's existing functions
> (`search`, `geocode`, `nearestNode`, `routeSummary`) are already the
> tools it would route between. **Not yet implemented** — this file names
> the seam.

---

## Zoom out, then zoom in

**Zoom out.** Routing sits at the entrance to a loop — before you commit
to a tool or an agent, you classify the request and pick a handler.

```
  Zoom out — where a router would sit in a future flattr

  ┌─ UI layer (mobile/) ───────────────────────────────────────┐
  │  user: "plan a flat afternoon with 3 coffee stops near me"  │
  └───────────────────────────┬────────────────────────────────┘
                              │  natural language
  ┌─ NEW agent layer (would live in features/plan/) ─▼─────────┐
  │  ★ ROUTER ★ → pick the next tool:                          │ ← we are here
  │    geocode? nearestNode? search? routeSummary?             │   (NOT YET BUILT)
  └───────────────────────────┬────────────────────────────────┘
                              │  calls existing functions as tools
  ┌─ Engine layer (features/routing/, pipeline/) ──▼───────────┐
  │  search() · geocode() · nearestNode() · routeSummary()     │
  │  (UNCHANGED — they become the agent's tools)               │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in.** A router answers "which handler takes this?" In a
single-agent system it picks a *tool*; in a multi-agent system the same
pattern picks an *agent* (the supervisor's core job — see
`../03-multi-agent-orchestration/02-supervisor-worker.md`). flattr's seam
is the single-agent case: one ReAct loop whose router picks among
flattr's four pre-cut tools.

---

## The structure pass

**The axis: who decides which handler runs?** Two answers, and the
production pattern uses both.

```
  One question — "who picks the handler?"

  ┌─ heuristic front ────────────┐  → CODE (regex/rules) — fast, free
  │  "ends in an address?" →      │     deterministic
  │   geocode. "lat,lng?" →       │
  │   nearestNode directly.       │
  └───────────────────────────────┘
  ┌─ LLM back ───────────────────┐  → MODEL — for the ambiguous ones
  │  "a flat loop past 3 cafes"   │     ("decompose into geocode ×3
  │   → decompose into tool calls │      + search + summary")
  └───────────────────────────────┘
```

**The seam.** The load-bearing boundary is heuristic→LLM: code handles the
high-volume predictable routes, the model handles the ambiguous ones.
This is exactly the same seam as `astar.ts`'s step slot — code where it
can decide, model where it can't.

---

## How it works

### Move 1 — the mental model

Routing is a `switch` you can't fully write by hand. The cases you *can*
write (an address string, a tapped coordinate) stay code; the cases you
can't (free-form intent) fall through to a model.

```
  Heuristic-first routing — the shape

  Input
    │
    ▼
  ┌─────────────────────┐
  │ Heuristic router    │  fast, deterministic
  │ (regex / rules)     │  ← handles the obvious routes
  └─────────┬───────────┘
            │ no clear match
            ▼
  ┌─────────────────────┐
  │ LLM router          │  classify intent, pick the
  │ (model-decided)     │  tool/agent — handles ambiguity
  └─────────────────────┘
```

### Move 2 — the seam, against flattr's real functions

flattr already has the routing *targets* — four functions with clean
signatures that map one-to-one to tools:

```ts
search(graph, startId, goalId, userMax, costFn, heuristicFn): SearchResult  // astar.ts:22
routeSummary(graph, path, userMax): RouteSummary                            // summary.ts:11
geocode(query, opts): Promise<GeocodeResult | null>                         // geocode.ts:9
nearestNode(graph, point): string                                          // nearest.ts:5
```

A router for "plan a flat afternoon with 3 coffee stops" decomposes the
request and picks these in sequence:

```
  Layers-and-hops — the future routing flow (NOT YET BUILT)

  ┌─ user intent ─────────────────────────────────────────────┐
  │ "flat loop near me past 3 coffee shops"                    │
  └──────────────────────────┬─────────────────────────────────┘
                  hop 1: LLM router decomposes
                             ▼
  ┌─ tool calls (existing flattr functions) ──────────────────┐
  │ geocode("coffee near me") ×3   → 3 coordinates (geocode.ts)│
  │ nearestNode(graph, coord) ×N   → snap to graph (nearest.ts)│
  │ search(graph, a, b, userMax,…) → flat legs (astar.ts)      │
  │ routeSummary(graph, path,…)    → climb/distance (summary.ts)│
  └──────────────────────────┬─────────────────────────────────┘
                  hop 2: agent assembles legs into a loop
                             ▼
  ┌─ answer: a flat multi-stop route ─────────────────────────┐
  └────────────────────────────────────────────────────────────┘
```

The point of showing the signatures: **nothing in `features/routing/`
changes.** The router is new code that *calls* these. `search()` doesn't
know it's being driven by a model instead of by `MapScreen.tsx`. That's
what makes them pre-cut tools — single-purpose, well-typed, the network
side-effect isolated to `geocode` (see
`../05-production-serving/03-per-tool-circuit-breaking.md`).

### Move 2.5 — current vs future

```
  Phase A: today                    Phase B: with the router
  ──────────────                    ────────────────────────
  MapScreen.tsx calls geocode →     LLM router decomposes intent →
  nearestNode → search directly     calls the SAME four functions
  (UI is the "router", hand-coded)  (model picks the order + args)

  What doesn't change: the four functions. The UI's fixed call order
  becomes the agent's runtime-chosen order.
```

### Move 3 — the principle

Routing is the bridge from one agent to many: pick a tool in a
single-agent system, pick an agent in a multi-agent one — same pattern.
The production shape is heuristic-front, LLM-back: don't pay a model to
route what a regex can. flattr's UI is already a hand-coded router; the
seam is replacing that fixed order with a model that picks it from
intent.

---

## Primary diagram

```
  The seam — flattr's four functions as routed tools (NOT YET BUILT)

  ┌─ NEW: features/plan/ (the agent) ──────────────────────────┐
  │  heuristic router → LLM router → ReAct loop                │
  │         picks among ↓                                      │
  └───────────────────────────┬────────────────────────────────┘
        ┌──────────┬──────────┼──────────┬──────────┐
        ▼          ▼          ▼          ▼
   geocode()  nearestNode() search()  routeSummary()
   (network)  (pure)        (pure)    (pure)
   geocode.ts nearest.ts:5  astar.ts  summary.ts:11
   :9         ↑              :22        ↑
              └─ UNCHANGED engine functions = pre-cut tools ─┘
```

---

## Elaborate

Routing as a discrete pattern (rather than an `if` buried in a handler)
comes from the cost asymmetry: an LLM classification call is expensive
relative to a regex, so you tier them. The reframe flattr makes concrete:
*your UI is already a router.* `MapScreen.tsx` decides "geocode this
string, then snap, then search" — a fixed route. Turning flattr agentic
isn't adding intelligence to the router functions; it's replacing the
fixed UI route with a model that chooses the route per request.

---

## Interview defense

**Q: How would you make this routing engine agentic without rewriting it?**

I wouldn't touch the engine. `search`, `geocode`, `nearestNode`,
`routeSummary` are already single-purpose typed functions — pre-cut
tools. I'd add one ReAct loop whose step is a model call, and register
those four as its tools. The model decomposes "flat afternoon, 3 coffee
stops" into geocode×3 → nearestNode → search legs → routeSummary, and
assembles the loop. The router is heuristic-front (a tapped coordinate
skips geocode), LLM-back (free-form intent hits the model).

```
  intent → [regex route?] → yes → call directly
                          → no  → LLM router → tool sequence
```

Anchor: *"flattr's UI is already a hand-coded router calling `geocode →
nearestNode → search`; the agent version replaces that fixed order with a
model — the four functions don't change."*

---

## See also

- `02-agent-loop-skeleton.md` — the loop the router feeds
- `03-react.md` — the loop the seam would instantiate
- `../04-agent-infrastructure/03-tool-calling-and-mcp.md` — the four
  functions as tools, in detail
- `../05-production-serving/03-per-tool-circuit-breaking.md` — `geocode`,
  the one side-effect tool
- `../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md`
  — the multi-stop planner as a system-design template
- `../agent-patterns-in-this-codebase.md`
