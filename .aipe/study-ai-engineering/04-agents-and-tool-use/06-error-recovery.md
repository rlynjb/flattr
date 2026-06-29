# Error Recovery
### Tool fails → observe → retry, with a hard stop (orchestration / study material)

## Zoom out

```
AGENT RECOVERY LOOP                    flattr's DETERMINISTIC ANALOG
┌─────────────────────────┐          ┌──────────────────────────────┐
│ call tool                │          │ geocode() fetch               │
│   ▼ error                │          │   ▼ !res.ok                   │
│ feed error as observation│          │ throw Error(status)  :24/49/67│
│   ▼                      │          │   ▼  (caller handles)         │
│ LLM decides: retry?      │          │ router: cost() ─▶ BLOCKED     │
│   ▼ stop at max-iter     │          │ = large-finite, NOT Infinity  │
└─────────────────────────┘          └──────────────────────────────┘
   model-driven graceful degradation     code-driven graceful degradation
```

An agent recovers by turning a tool error into an *observation*, letting the model
decide whether to retry or reroute, and capping the whole thing with a
max-iteration stop so it can't spin forever. flattr has no such loop — but it does
have a genuine deterministic *analog* of graceful degradation worth understanding.

## How it works

### Move 1 — the mental model: errors are data, loops need a leash

```
ERROR AS OBSERVATION    a failure is just another input to reason over
RETRY BUDGET            N attempts, then give up cleanly
MAX-ITERATION STOP      the loop's leash — no infinite spin
GRACEFUL DEGRADATION    "couldn't do X" must differ from "X is impossible"
```

Fast read: recovery is two disciplines — feed failures back as information, and
*bound* the work so the system always terminates with a clear answer.

### Move 2 — flattr's two honest mechanisms

```
1) CONVENTIONAL ERRORS — throw at the boundary
   pipeline/geocode.ts
     if (!res.ok) throw new Error(`Geocode failed: ${status}`)   :24
     same guard at :49 (suggest) and :67 (reverse)
   ↳ no retry loop; the caller decides. Standard, not agentic.

2) DEGRADATION VIA SENTINEL — the interesting one
   features/routing/cost.ts
     export const BLOCKED = 1e9     :5
     if (g > max) return BLOCKED    :18
   ↳ over-max edges cost a LARGE FINITE number, not Infinity (spec §14.4)
       BLOCKED (1e9)  = "this edge is awful, avoid if you can"
       Infinity       = "this edge does not exist"
   ↳ keeps "no FLAT route" distinct from "no route at all"
```

Step by step: when every path forces a too-steep edge, using `1e9` instead of
`Infinity` lets A* still *find* a path (the least-bad one) rather than reporting
"unreachable." That preserves a usable answer under bad conditions — the
deterministic cousin of an agent degrading gracefully instead of failing hard.

### Move 3 — the principle

The shared lesson across agent recovery and flattr's sentinel: **distinguish "best
effort under constraints" from "impossible," and always terminate with a clear
signal.** An agent does this with retries + a max-iteration stop; flattr does it with
a finite penalty that keeps the search solvable. Different machinery, same value:
never collapse "degraded" into "failed."

## In this codebase

**NOT YET EXERCISED as agent recovery.** No tool-error-as-observation, no retry
loop, no max-iteration guard — there's no LLM loop to guard.

What *is* real and worth the honest connection: `geocode` throws on `!res.ok`
(`pipeline/geocode.ts:24,49,67`) — ordinary boundary error handling. And the router
encodes graceful degradation deterministically: `BLOCKED = 1e9`
(`features/routing/cost.ts:5,18`) keeps "no flat route" distinct from "no route"
(spec §14.4). That's the deterministic analog of degrading gracefully — but it is
not agent recovery, because nothing reasons about the failure. No agent attach point;
flattr is a deterministic pipeline.

## See also
- `03-react-pattern.md` — the loop that needs a max-iteration leash
- `02-tool-calling.md` — `geocode` results (incl. untrusted OSM labels) flow back
- `features/routing/cost.ts:5` · `pipeline/geocode.ts:24` — the real mechanisms
