# Per-tool circuit breaking

**Industry names:** circuit breaker · per-tool breaker. **Type:** Industry
standard. **In this codebase:** the *boundary* is real and named —
`geocode()` is flattr's one network/side-effect tool, hitting Nominatim,
which already 429s under load (the project's external-data caveat). The
breaker itself is **Not yet implemented**.

> Single-call retry handles one flaky request. An agent loop can call the
> *same* flaky tool every turn — multiplying the failure by the iteration
> count. flattr's `geocode` is exactly that flaky tool, and the project
> already documents its failure mode.

---

## Zoom out, then zoom in

**Zoom out — the breaker scoped to a tool:**

```
  Agent calls tool X
       │
       ▼
  ┌───────────────────────────────────────────────┐
  │  Circuit breaker (per tool)                   │
  │   closed:    calls pass through               │
  │   N fails →  OPEN: fail fast, don't call tool │
  │   after T:   half-open, try one               │
  └───────────────────────────────────────────────┘
       │ tool X open?
       ▼
  Agent observes "tool X unavailable" and routes around it
  (different tool / degrade / escalate) — not retry every turn
```

**Zoom in.** A per-tool breaker tracks each tool's health. When a tool
fails N times it opens — fail fast, stop calling it. The agent-specific
twist: feed the open state *back to the agent as an observation*, so its
reasoning routes around the dead tool instead of looping on it.

---

## How it works

### Move 1 — the mental model

flattr's tools split cleanly: three pure (`search`, `routeSummary`,
`nearestNode` — can't fail in a way a breaker helps) and one network
(`geocode` → Nominatim, `geocode.ts:21`). The breaker is *only* for
`geocode`.

```
  flattr's one breaker boundary

  search() · routeSummary() · nearestNode()   → pure, no breaker needed
  geocode()  → Nominatim HTTP (geocode.ts:21) → THE breaker boundary
               already throws on !res.ok (geocode.ts:24) and 429s under
               load (external-data caveat) — the documented flaky tool
```

### Move 2 — why a loop makes geocode's flakiness expensive

flattr's caveat already names the failure: Open-Meteo/Nominatim 429 under
heavy use. In a one-shot UI call, that's one failed geocode. In an *agent
loop* planning a multi-stop afternoon, the model might call `geocode` on
every turn — and a 429'd Nominatim retried each turn burns the whole
iteration budget on a tool that isn't coming back:

```
  geocode flaky + agent loop = budget-ending failure

  no breaker:   turn 1 geocode → 429 → retry
                turn 2 geocode → 429 → retry      ← multiplies the failure
                … entire iteration budget spent, ZERO result
  with breaker: turn 1-3 geocode → 429×3 → OPEN
                turn 4+ → "geocode unavailable" fed to agent →
                          agent routes around (use cached coords /
                          ask user / degrade) — budget preserved
```

The shift from the single-call breaker: there, the breaker protects *your
service* from hammering Nominatim. Here it does that *and* feeds the
open-circuit state back as an observation so the agent's reasoning routes
around it. A breaker that just fails fast without telling the agent leaves
it retrying the dead path. And it never trips on the pure tools — only on
`geocode`, which never caches side effects.

### Move 3 — the principle

A per-tool breaker turns "one dead tool + a loop = the whole budget burned"
into a routed-around inconvenience — but only if the open state is fed back
to the agent. flattr's `geocode` is the textbook case: the one network
tool, already documented as flaky, the only one that needs a breaker.

---

## Interview defense

**Q: Which flattr tool needs a circuit breaker, and why does the loop matter?**

`geocode` — it's the one network tool (Nominatim, `geocode.ts:21`) and the
project already documents it 429ing under load. In a one-shot UI call
that's one failure; in an agent loop the model may call it every turn, so a
dead Nominatim retried per turn burns the whole iteration budget for
nothing. The breaker opens after N fails and — the agent-specific part —
feeds "geocode unavailable" back as an observation so the agent routes
around it. The three pure tools never need one.

Anchor: *"flattr's `geocode` is the one network tool, already documented as
429-prone — in a loop that's a budget-ending failure, so it's the breaker
boundary, fed back to the agent as an observation."*

---

## See also

- `../04-agent-infrastructure/03-tool-calling-and-mcp.md` (the pure/network
  tool split)
- `02-fan-out-backpressure.md` · `01-cross-turn-caching.md`
- `../03-multi-agent-orchestration/09-coordination-failure-modes.md`
  (tool-call cascade)
- Mechanics (cross-ref): `study-ai-engineering`'s retry/circuit-breaker file
- Sibling guide `study-networking` — the Nominatim HTTP failure path.
