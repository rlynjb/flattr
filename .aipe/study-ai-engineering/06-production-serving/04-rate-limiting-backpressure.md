# Rate Limiting & Backpressure

*Industry name: rate limiting / backpressure / load shedding — serving flow control.*

## Zoom out

```
  Two directions of flow control
  ┌───────────────────────────────────────────────────────────┐
  │  INBOUND (rate limiting)     │  OUTBOUND (backpressure)      │
  │  cap how fast clients hit YOU │  cap how fast YOU hit a dep   │
  │                              │                              │
  │  clients ──►[limiter]──► app  │  app ──►[limiter]──► provider │
  │  reject/queue excess         │  slow/queue to stay under cap │
  └───────────────────────────────────────────────────────────┘
```

Every serving system has a maximum sustainable rate. Rate limiting protects *you* from clients; backpressure protects a *downstream dependency* from you. For LLM apps both matter: providers enforce RPM/TPM limits (you must not exceed them — outbound), and you cap your own users so one client can't drain your quota (inbound). Same mechanism, opposite ends of the pipe.

## How it works

### Move 1 — the pattern: a budget over time

```
  token bucket:   [● ● ● ● ●]  refills at R per sec, cap N
                   │
   request ────────┤ token available? ─► proceed (take one)
                   └ empty?            ─► wait / queue / reject
```

Mental model: a rate limit is a budget that refills on a clock. The only design choices are *what to do when the budget is empty*: **block** (wait — backpressure), **queue** (defer), or **shed** (reject/429 — protect yourself). LLM serving uses all three: block on provider limits, queue background jobs, shed abusive users.

### Move 2 — step by step (outbound, the common LLM case)

```
  1. provider says: 60 requests / minute
  2. you set a limiter at ≤ 1 req/sec (with headroom)
  3. before each call: acquire a slot (block if none free)
  4. on 429 anyway: back off and retry (→ 05)
  5. for bulk work: SEQUENTIAL or small-concurrency, not a burst
```

The simplest correct limiter is *just do one thing at a time* — sequential calls with a delay. It throws away throughput, but for a polite client against a 1-req/sec API it's exactly right and impossible to get wrong.

### Move 3 — the principle

**Match your emission rate to the slowest thing downstream, and decide explicitly what happens to the overflow.** A pipeline that emits faster than its consumer absorbs will fail — the only question is whether it fails loudly (429s) or you shape the flow on purpose.

## In this codebase

**NOT YET EXERCISED for LLM** — no model, no provider RPM to respect. But flattr already does outbound rate limiting *correctly* against two real external APIs, using the two simplest valid strategies. The pattern transfers one-to-one to LLM serving.

```
  flattr's outbound flow control (real, today)
  ┌──────────────────────────────────────────────────────────────┐
  │  ① Nominatim (~1 req/sec policy)                                │
  │     strategy: SEQUENTIAL calls, never parallel                 │
  │     mobile/src/MapScreen.tsx:189                               │
  │       const b = await geocode(to, { viewbox });                │
  │       // "sequential: Nominatim allows ~1 req/sec"            │
  │     From is awaited (:182) BEFORE To (:189) — by construction  │
  │     the app never bursts two geocode calls at once.            │
  │                                                                │
  │  ② Open-Meteo Elevation (free-tier, 429-prone)                 │
  │     strategy: BATCH + THROTTLE                                 │
  │     pipeline/elevation.ts                                      │
  │       OPEN_METEO_BATCH = 100   ← ≤100 points per request       │
  │       delayMs = 300            ← sleep between batches         │
  │       (and 429 backoff — see 05)                              │
  └──────────────────────────────────────────────────────────────┘
```

- **The Nominatim case is the cleanest possible rate limiter:** concurrency of one. `MapScreen.tsx:182` awaits the *From* geocode fully before `:189` issues the *To* geocode. There's no token bucket because there doesn't need to be — serializing the two awaits *is* the limiter, and the comment names the policy it's respecting. This is exactly how you'd serialize calls to an LLM provider with a tight RPM limit.
- **The Open-Meteo case is the bulk-job version:** chunk the work (`OPEN_METEO_BATCH = 100`), sleep between chunks (`delayMs`, `sleep(delayMs)` at line 121), and stay under the quota by construction. Swap "100 elevation points" for "100 documents to summarize" and this is LLM batch processing with backpressure.

**The shape you'd reuse for an LLM:** if narration shipped at `features/routing/summary.ts:11`, you'd put the *same* sequential-await or batch-with-delay discipline in front of the model call to respect its RPM/TPM limits. flattr already writes this correctly — just for map APIs instead of a model. **Not exercised for LLM.**

## See also

- `05-retry-circuit-breaker.md` — what to do when you hit the limit anyway (429)
- `02-llm-cost-optimization.md` — rate limiting and cost both target the same metered dependency
- `mobile/src/MapScreen.tsx:182,189` and `pipeline/elevation.ts:96–121` — the two live limiters
