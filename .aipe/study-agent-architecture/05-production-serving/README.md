# 05 — Production serving for agents

**Anchor:** single-agent + multi-agent (both).

What single-call serving concerns become once the unit is a *loop* or a
*topology* — caching across turns, backpressure on fan-out, circuit
breaking per tool. flattr has no agent, but the **one network side effect
(`geocode`) is the real circuit-breaker boundary** — that file is grounded.

These files do *not* re-teach single-call mechanics (caching, cost, rate
limit, retry/breaker) — those are in `study-ai-engineering`'s section 06.
They cover what those become when many calls happen across turns, often
concurrently, often against the same tool.

## Files

1. `01-cross-turn-caching.md` — caching across turns and runs (not exercised)
2. `02-fan-out-backpressure.md` — bounding concurrent worker calls (not exercised)
3. `03-per-tool-circuit-breaking.md` — ★ `geocode()` is the breaker boundary
