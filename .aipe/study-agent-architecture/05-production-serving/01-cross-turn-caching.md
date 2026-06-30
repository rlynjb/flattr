# Cross-turn caching

**Industry names:** cross-turn cache · prefix caching · semantic cache.
**Type:** Industry standard. **In this codebase: Not yet implemented** — no
loop, no turns. flattr's `geocode` is the one cacheable tool; the mobile app
already has an `elevCache` instinct worth naming.

> Single-call caching keys on one request. An agent runs many turns per
> task, and tasks repeat sub-steps. flattr's pure tools are trivially
> cacheable; `geocode` is the one with a freshness caveat.

---

## Zoom out, then zoom in

**Zoom out — two cache scopes:**

```
  Single-call cache:  request → hash → hit? return : call

  Cross-turn cache:
  ┌─ Agent run (task A) ──────────────────────────┐
  │  turn 1: geocode "cafe X"  ──┐                 │
  │  turn 3: geocode "cafe X" ◄──┘ cached in-run   │
  └────────────────────────────────────────────────┘
  ┌─ Agent run (task B, later) ───────────────────┐
  │  turn 1: geocode "cafe X" ◄── semantic cache   │
  │          across runs                            │
  └────────────────────────────────────────────────┘
```

**Zoom in.** Three layers, cheapest to most useful: prompt-prefix caching
(keep the stable system prompt + tool defs at the front so the prefix is
cached every turn); intra-run memoization (re-derived sub-result in one task);
cross-run semantic cache (a later task's sub-step is close to an earlier one).

---

## How it works

### Move 1 — the mental model

flattr's tools split by cacheability the same way they split by purity:

```
  flattr tool        cacheable?
  ──────────         ──────────
  search()           yes — pure, (graph,start,goal,userMax)→Path is stable
  nearestNode()      yes — pure
  routeSummary()     yes — pure
  geocode()          yes BUT with a freshness caveat (an address's coords
                     are stable; "coffee near me" results can change)
```

The mobile app already has the instinct — `mobile/src/elevCache.ts` caches
elevation lookups. That's the same move: memoize a stable-input tool result
so you don't re-fetch.

### Move 2 — the agent-specific danger

The tradeoff is *sharper* for agents than single calls: a stale cross-run
cache hit poisons the *whole trajectory*, not one response. The agent
reasons forward on a stale sub-result and every downstream turn inherits the
error.

```
  stale cache hit, single call vs agent loop

  single call:  one wrong response, done
  agent loop:   turn 1 reads stale geocode → turn 2-5 plan a route around
                a WRONG coordinate → entire afternoon plan is wrong
```

So: gate the semantic cache on freshness (don't cache `geocode("coffee near
me")` whose results change), and **never cache a tool call with side
effects.** flattr's pure tools are safe to cache freely; `geocode`'s
*address* lookups are cacheable, its *"near me"* lookups are not.

### Move 3 — the principle

Cache the stable, gate the fresh, never cache side effects — and remember a
stale hit in a loop corrupts the whole trajectory, not one turn. flattr's
pure tools (`search`/`nearestNode`/`routeSummary`) are free to cache; only
`geocode` needs the freshness gate, the same boundary that makes it the
breaker tool.

---

## Interview defense

**Q: What in flattr is safe to cache across turns, and what isn't?**

The three pure tools — `search`/`nearestNode`/`routeSummary` — cache freely
(stable inputs, no side effects); the mobile `elevCache` already does this
for elevation. `geocode` is conditional: a fixed address's coords are
stable, but "coffee near me" changes, so gate it on freshness. The
agent-specific danger is that a stale hit poisons the whole trajectory, not
one response — so never cache a side-effect call, and gate anything
time-varying.

Anchor: *"flattr's pure tools cache freely; `geocode` needs a freshness gate
— and in a loop a stale hit corrupts the whole trajectory, not one turn."*

---

## See also

- `03-per-tool-circuit-breaking.md` · `02-fan-out-backpressure.md`
- `../04-agent-infrastructure/03-tool-calling-and-mcp.md`
- Mechanics (cross-ref): `study-ai-engineering`'s single-call caching file
