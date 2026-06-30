# Fan-out backpressure

**Industry names:** concurrency limiting · backpressure · semaphore over
agents. **Type:** Industry standard. **In this codebase: Not yet
implemented** — but the constraint is concrete: Nominatim's ~1 req/sec
policy caps any `geocode` fan-out flattr would do.

> A single call has one outbound request to rate-limit. A fan-out fires many
> concurrent calls — and can exceed the provider's limit. flattr's
> `geocode` already documents the limit it must respect.

---

## Zoom out, then zoom in

**Zoom out — the flow control:**

```
  Supervisor decomposes → 12 worker calls at once
                       │
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Concurrency limiter (semaphore)              │
  │   pop up to N concurrent (N = 4)              │
  │   queue the rest                              │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Provider — receives at most N at a time      │
  └───────────────────────────────────────────────┘
```

**Zoom in.** This is `Promise.all()` with a concurrency cap — what you reach
for with 200 independent requests but not 200 open connections. The agent
twist: backpressure *upward* — when the worker queue grows past a threshold,
the supervisor should stop decomposing, not queue unbounded work.

---

## How it works

### Move 1 — the mental model

flattr's fan-out opportunity (`../03-multi-agent-orchestration/04-parallel-fan-out.md`)
is geocoding N cafes concurrently. But `geocode` hits Nominatim, whose usage
policy is ~1 req/sec (`geocode.ts:2`). So the concurrency cap isn't a
performance tuning knob here — it's a hard external constraint.

```
  flattr's fan-out, bounded by the provider

  geocode 5 cafes "at once"  →  but Nominatim allows ~1 req/sec
       │                          (geocode.ts:2 — documented)
       ▼
  semaphore N=1 (effectively serialize) → respect the policy
       │  going faster → 429s (the external-data caveat)
       ▼
  the fan-out latency win is LOST to the rate limit — that's the trade
```

### Move 2 — the breakpoint, and backpressure upward

The breakpoint is the provider's rate limit ÷ per-call duration — cap
concurrency just under it. For Nominatim at ~1 req/sec, that's effectively
serial. The tradeoff is blunt: a low cap protects the provider but
serializes the fan-out, losing the parallel-latency win that made fan-out
worth it. The fix isn't a higher local cap (that just trades queueing for
429s) — it's a higher provider limit, a self-hosted Nominatim, or batching.

The agent-specific control is backpressure *upward*: a runaway supervisor
that keeps spawning `geocode` workers is the multi-agent version of an
unbounded queue. When the queue grows past threshold, the supervisor stops
decomposing.

### Move 3 — the principle

Cap concurrency at the provider's limit ÷ call duration, and apply
backpressure upward so a supervisor can't spawn unbounded work. flattr's
`geocode` makes the constraint concrete and external: ~1 req/sec means the
fan-out is rate-limited to near-serial, and the answer to needing more is a
higher provider limit, not a higher local cap.

---

## Interview defense

**Q: How fast can flattr fan out its geocodes?**

Barely — Nominatim's policy is ~1 req/sec (documented in `geocode.ts`), so a
concurrency semaphore caps it to effectively serial. The fan-out's
latency win is lost to the rate limit; pushing a higher local cap just
trades queueing for 429s. The real fixes are a higher provider limit, a
self-hosted Nominatim, or batching. The agent-specific control is
backpressure upward — stop the supervisor decomposing more `geocode` work
when the queue backs up.

Anchor: *"flattr's `geocode` fan-out is capped at Nominatim's ~1 req/sec —
an external hard limit, so the cap is correctness, not tuning, and more
throughput means a higher provider limit, not a higher local cap."*

---

## See also

- `../03-multi-agent-orchestration/04-parallel-fan-out.md` (the fan-out shape)
- `03-per-tool-circuit-breaking.md` · `01-cross-turn-caching.md`
- Sibling guide `study-networking` — the Nominatim rate-limit + 429 path.
- Mechanics (cross-ref): `study-ai-engineering`'s rate-limit/backpressure file
