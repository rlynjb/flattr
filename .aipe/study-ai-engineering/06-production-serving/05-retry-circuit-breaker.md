# Retry & Circuit Breaker

*Industry name: retry-with-backoff and circuit breaking — resilience patterns for flaky deps.*

## Zoom out

```
  Two responses to a failing dependency
  ┌──────────────────────────────────────────────────────────────┐
  │  RETRY (optimistic)          │  CIRCUIT BREAKER (defensive)     │
  │  failure is TRANSIENT —      │  failures PERSIST — stop trying  │
  │  try again, backing off      │  for a while, fail fast          │
  │                              │                                  │
  │  call ►✗► wait ►call ►✓       │  ✗✗✗✗► OPEN ► reject instantly   │
  │                              │        ►(cooldown)► HALF► probe   │
  └──────────────────────────────────────────────────────────────┘
```

Networks fail in two shapes. A *transient* blip (one 429, a dropped connection) wants a retry. A *sustained* outage (provider down, quota exhausted) wants the opposite — stop hammering it, fail fast, give it room to recover. Retry handles the first; a circuit breaker handles the second. Used together they keep a flaky dependency from taking your serving layer down with it.

## How it works

### Move 1 — the pattern: classify, then react

```
  failure ─► is it retryable?
              ├─ yes (429, 503, timeout) ─► retry with backoff
              └─ no  (400, 401, 404)     ─► fail immediately
```

Mental model: not every error deserves a retry. Retrying a 400 (bad request) just wastes time and quota — the request is malformed and will fail identically. Retry only *transient* classes; surface the rest. Retrying non-idempotent writes is its own trap (you might double-charge); reads and idempotent ops are safe.

### Move 2 — step by step

```
  RETRY w/ exponential backoff:
    attempt 0 ►✗► sleep base·2⁰
    attempt 1 ►✗► sleep base·2¹
    attempt 2 ►✗► sleep base·2²   (+ jitter to avoid thundering herd)
    attempt N ►✗► give up, throw

  CIRCUIT BREAKER:
    CLOSED   ─ count failures ─► threshold hit ─► OPEN
    OPEN     ─ reject fast for cooldown window ─► HALF-OPEN
    HALF-OPEN─ let one probe through ─► ✓ CLOSED  /  ✗ back to OPEN
```

Exponential backoff spaces retries out so a struggling service gets breathing room instead of a synchronized stampede. The breaker is the escalation: if backoff isn't enough and failures keep coming, trip open and stop spending latency on calls that won't succeed.

### Move 3 — the principle

**Distinguish transient from persistent failure and respond differently — retry the blip, fail fast on the outage.** Blind retry on a real outage *amplifies* it (more load on a dying service); no retry on a blip throws away easy wins. The breaker is just retry's circuit-protection sibling for when retry isn't working.

## In this codebase

**NOT YET EXERCISED for LLM** — no model call to protect. But flattr has the full failure-classification spectrum already, and one provider that *implements retry-with-backoff correctly today*:

```
  flattr's failure handling (real)
  ┌──────────────────────────────────────────────────────────────┐
  │  geocode (pipeline/geocode.ts:24,50,67)                        │
  │     if (!res.ok) throw  ─► FAIL FAST, no retry                 │
  │     (deliberate: a single user-facing lookup; surface it)     │
  │                                                                │
  │  Open-Meteo elevation (pipeline/elevation.ts:107–119)  ★        │
  │     for (let attempt = 0; ; attempt++) {                       │
  │       if (res.ok) break;                                       │
  │       if (res.status === 429 && attempt < retries)            │
  │         await sleep(delayMs * 2 ** (attempt + 1));  ← BACKOFF   │
  │       else throw;                                             │
  │     }                                                          │
  │     retries = 3 (default)                                      │
  └──────────────────────────────────────────────────────────────┘
```

- **`openMeteoProvider` already does textbook retry-with-exponential-backoff** (`pipeline/elevation.ts:96–119`). It classifies correctly: a **429** is retryable → sleep `delayMs · 2^(attempt+1)` and try again, up to `retries` (default 3); any *other* non-ok status throws immediately. This is precisely the loop you'd put around an LLM call that returns 429/503. **The brief's note that flattr has "no retry/backoff today" is outdated — this provider is the working example.** (No jitter, and the breaker stage isn't built — see below.)
- **`geocode` deliberately fails fast** (`:24,50,67` — `if (!res.ok) throw`). That's the *correct* choice for a single interactive lookup: there's a human waiting, so surface the error rather than silently retry. Different call, different policy — which is exactly the "classify, then react" principle.

**What's not built: the circuit breaker stage.** Today Open-Meteo retries each batch independently; there's no shared state that says "this provider has failed 20 times in a row, stop trying for 60s." If the API were *down* (not just throttling), a large build would grind through 3 retries × every batch before failing. A breaker around `ElevationProvider.sample` is the natural next step — and the identical shape you'd wrap an LLM provider in.

**The LLM analog:** a narration call at `features/routing/summary.ts:11` would reuse this exact retry loop for provider 429/503, plus a breaker to fail fast (or fall back to the raw `routeSummary` numbers) during an outage. The retry half already exists in `elevation.ts`; the breaker half is the gap. **Not exercised for LLM.**

## See also

- `04-rate-limiting-backpressure.md` — staying under the limit so you retry less in the first place
- `01-llm-caching.md` — a warm cache is the best outage fallback (serve the last good answer)
- `pipeline/elevation.ts:107–119` — the live retry-with-backoff loop
- `pipeline/geocode.ts:24,50,67` — the deliberate fail-fast counterexample
