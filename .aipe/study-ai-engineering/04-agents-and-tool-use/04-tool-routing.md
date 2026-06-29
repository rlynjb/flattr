# Tool Routing
### Picking *which* tool runs — heuristic front, LLM back (orchestration / study material)

## Zoom out

```
WHO ROUTES THE REQUEST TO A TOOL?
┌──────────────────────────────────────────────────────────┐
│  HEURISTIC FRONT   cheap rules first (regex, type, flag)   │
│     request ──▶ rule match? ──yes──▶ run tool directly     │
│                     │ no                                   │
│                     ▼                                      │
│  LLM BACK          model classifies the hard cases         │
│     request ──▶ LLM ──▶ { tool: "X" } ──▶ run tool         │
├──────────────────────────────────────────────────────────┤
│  flattr            HEURISTIC ALL THE WAY — no LLM back     │
│     every dispatch is a code-decided branch                │
└──────────────────────────────────────────────────────────┘
```

Tool routing is the dispatch problem: given a request, *which* function handles it?
The mature pattern is **heuristic-before-LLM** — answer the cheap, certain cases in
code, escalate only the ambiguous remainder to a model. flattr lives entirely in the
"front": it never needs a model to route, because its inputs are already typed.

## How it works

### Move 1 — the mental model: a funnel, widest part free

```
100 requests
   │  cheap rules catch the obvious ones (free, instant, deterministic)
   ▼
  ~15 ambiguous left
   │  LLM classifies these (slow, costs tokens, can be wrong)
   ▼
   route to tool
```

Fast read: every request you can route with an `if` is a request you didn't pay an
LLM to route. The model is the expensive fallback, not the front door. Put
determinism first; reach for the model only where rules genuinely can't decide.

### Move 2 — how flattr routes (all front, no back)

```
flattr DISPATCH — every branch is code
┌──────────────────────────────────────────────────────────┐
│ has typed coords?      ──▶ go straight to A*               │
│ has a text address?    ──▶ geocode()    pipeline/geocode.ts│
│ need spoken totals?    ──▶ routeSummary()   summary.ts:11  │
│ edge over userMax?     ──▶ cost() returns BLOCKED  cost.ts │
└──────────────────────────────────────────────────────────┘
no classifier, no { tool } emission, no model in the path.
```

Step by step: flattr's "routing" is just function selection by static type and
flags. A coordinate goes to the router; a string goes to `geocode`; a finished path
goes to `routeSummary`. The decision is in the source, not learned.

### Move 3 — the principle

Routing is where most "we need an agent" projects overspend. The right reflex is the
one flattr embodies by default: **route deterministically wherever the input shape
already tells you the answer.** Only the residue — genuinely ambiguous natural
language — earns an LLM router. Heuristic front keeps cost, latency, and failure
surface small.

## In this codebase

**NOT YET EXERCISED.** There is no LLM router and no `{tool}` dispatch — flattr
routes purely by code branch, which is the *ideal* heuristic-front baseline, not a
gap to fix.

The one place an LLM-back router *could* attach is the natural-language input seam:
`pipeline/geocode.ts:9`. If users typed "somewhere flat near the park," a model
might classify intent (geocode vs. POI-search vs. "use my location") before
dispatch. Today the string goes straight to `geocode` with no classification — pure
front, no back. No agent attach point; flattr is a deterministic pipeline.

## See also
- `02-tool-calling.md` — the tools a router would dispatch to
- `01-agents-vs-chains.md` — routing is the agent's per-step decision
- `pipeline/geocode.ts:9` — the only seam where an LLM router could earn its cost
