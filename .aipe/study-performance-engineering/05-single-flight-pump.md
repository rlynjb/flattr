# Single-Flight Pump — bounded concurrency / backpressure

**Industry name(s):** single-flight / concurrency limiter (max-in-flight = 1) /
priority work queue with backpressure. **Type:** Industry standard (overload
control).

## Zoom out, then zoom in

Panning the map and asking for a route both want to fetch tiles and build graphs
off rate-limited free APIs. If they all fired at once, Overpass and Open-Meteo
would 429 you into oblivion. flattr runs **exactly one build at a time**, corridor
before viewport, and drains the next when it finishes. This is the backpressure
mechanism that keeps the whole thing under quota.

```
  Zoom out — where the pump sits

  ┌─ UI (JS thread) ──────────────────────────────────────────┐
  │  MapScreen.tsx: onRegionDidChange (pan) · ensureBbox (route)│
  └───────────────────────────┬───────────────────────────────┘
                              │ enqueue requests
  ┌─ Coordination ────────────▼───────────────────────────────┐
  │  useTileGraph.ts: ★ pump() ★   one build at a time         │ ← we are here
  │   pendingCorridor (priority) / pendingView / busyRef       │
  └───────────────────────────┬───────────────────────────────┘
                              │ one build → network
  ┌─ I/O (rate-limited) ──────▼───────────────────────────────┐
  │  fetchOverpass · buildGraph · openMeteoProvider           │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do I serve pan + route requests against APIs that
throttle, without ever having two builds racing?"* The answer is a hand-rolled
single-flight queue with a priority slot.

## Structure pass

**Layers.** Three nested controls, outer to inner:

```
  spatial gate (reject too-wide)  →  debounce (collapse rapid pans)  →  pump (one at a time)
  MAX_*_SPAN_DEG                     600ms timer                        busyRef + pending slots
```

**Axis: control — "who decides the next unit of work runs?"** Trace it down:

```
  One question across the layers
  "who admits the next build?"

  ┌─ pan/route handler ─────────┐  → USER decides (gesture/tap)
  └─ debounce + spatial gate ───┘  → TIMER + size check decide (drop or delay)
       ┌─ pump ─────────────────┐  → busyRef decides (run now, or stash as pending)
       └────────────────────────┘     finally → pump() decides (drain next)
```

Control flips from user → policy → the pump's own `finally`. The pump is
self-clocking: each build's completion admits the next.

**Seam.** The load-bearing boundary is `busyRef` (`useTileGraph.ts:113, 167,
182, 222`). On one side, callers freely enqueue. On the other, at most one build
exists. That boolean *is* the concurrency limit.

## How it works

### Move 1 — the mental model

You know how a `<button disabled={loading}>` stops a double-submit while a request
is in flight? The pump is that, generalized: a `busyRef` flag gates the work, and
instead of dropping the second request it *stashes* it in a single "pending" slot
to run next. Two slots, actually — one for corridor (high priority), one for
viewport — so a route never gets starved by panning.

```
  Single-flight pump — the shape

  enqueue ──► [pendingCorridor]  (priority)
              [pendingView]
                  │
   busy? ── yes ──┘ (just stash; newest wins per slot)
   busy? ── no  ──► take corridor-else-view → busy=true
                    ┌─────────────┐
                    │  one build  │ ── network ──►
                    └──────┬──────┘
                  finally: busy=false → pump() drains next
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** Single-flight is four parts:

```
  busy flag + pending slot(s) + admit-one + drain-on-finish
      │            │               │            │
  busyRef     pendingCorridor/   pump head   finally → pump()
              pendingView
```

**Name each part by what breaks without it:**

- **`busyRef` guard (useTileGraph.ts:167)** — the concurrency limit. Remove it and
  every pan fires a concurrent build → parallel Overpass/Open-Meteo hits → 429
  storm. This is *the* backpressure.
- **Two pending slots with priority (useTileGraph.ts:170-180)** — corridor checked
  first. Remove the priority and a fast-panning user starves their own pending
  route; the map loads tiles while the route they asked for waits.
- **Newest-wins per slot** — `pendingViewRef.current = {...}` overwrites
  (`useTileGraph.ts:239`), it doesn't append. Remove this (use a list) and a burst
  of pans queues a backlog of stale viewports that all build in sequence — work
  for views the user already panned past.
- **`finally → pump()` (useTileGraph.ts:221-225)** — the self-clock. Remove it and
  the queue stalls after the first build; nothing drains the pending slot.

```ts
// mobile/src/useTileGraph.ts:166-182  — admit exactly one, corridor first
const pump = useCallback(() => {
  if (busyRef.current) return;              // ← already building: do nothing (caller already stashed)
  let kind: "corridor" | "view";
  let req: { bbox: Bbox; silent: boolean };
  if (pendingCorridorRef.current) {         // ← PRIORITY: route corridor before viewport
    kind = "corridor";
    req = pendingCorridorRef.current;
    pendingCorridorRef.current = null;      // claim it
  } else if (pendingViewRef.current) {
    kind = "view";
    req = pendingViewRef.current;
    pendingViewRef.current = null;
  } else {
    return;                                 // nothing pending
  }
  busyRef.current = true;                   // ← THE limit: now in flight
  // ... async build ...
```

```ts
// mobile/src/useTileGraph.ts:221-225  — self-clocking drain
} finally {
  busyRef.current = false;   // release the slot
  if (!silent) setLoadingStep(null);
  pump();                    // ← drain next pending (corridor first). Self-clock.
}
```

**Separate skeleton from hardening.** The four parts above are the kernel. The
*hardening* on top:

- **Debounce before enqueue (useTileGraph.ts:254-255)** — 600 ms collapses a pan
  gesture's hundreds of region events into one enqueue. Reduces how often the pump
  even runs.
- **Spatial gates (useTileGraph.ts:249-251, 272)** — reject builds wider than the
  span caps before they enter the pump at all. Caps the *size* of each unit.
- **Capped self-heal retry (useTileGraph.ts:209-218, MAX_RETRIES=6)** — when a
  build degrades to flat elevation, re-queue it `silent`ly up to 6 times. Bounded
  so a sustained API outage doesn't loop forever.

```
  Sequence — pan-pan-pan then route, under the pump

  user        pump            busy    in flight
  ────        ────            ────    ─────────
  pan A   →   debounce…
  pan B   →   debounce…(A dropped, newest wins)
  pan C   →   queueViewport(C) → pump → busy=true → build C
  route   →   ensureBbox → pendingCorridor=R → pump (busy, just stash)
  (C done)→   finally → pump → corridor R FIRST → build R   ← route not starved
  (R done)→   finally → pump → nothing pending → idle
```

### Move 3 — the principle

Backpressure is *refusing to start work you can't afford*, and the cheapest form
is a max-in-flight of 1 with a priority slot. The generalizable move is that the
limiter is **self-clocking** — completion admits the next unit — so you never need
a separate scheduler thread. flattr layers cheap gates (debounce, size caps) in
front so the pump rarely has to say no, but the `busyRef` is the hard guarantee
underneath.

## Primary diagram

```
  Single-flight pump — full picture

  ┌─ MapScreen ───────────────────────────────────────────────┐
  │  pan → onRegionDidChange        route → ensureBbox         │
  └────────────┬───────────────────────────┬──────────────────┘
        600ms debounce + size gate    size gate
               │                           │
  ┌─ useTileGraph ─────────────────────────▼──────────────────┐
  │  pendingViewRef (newest-wins)   pendingCorridorRef (prio)  │
  │            └───────────┬────────────────┘                  │
  │                    pump()                                   │
  │            busyRef? ── yes → return (already stashed)       │
  │                    │  no                                    │
  │            corridor-else-view → busyRef=true                │
  │                    ▼                                        │
  │         fetchOverpass → buildGraph → setRegion             │
  │                    ▼                                        │
  │         finally: busyRef=false → pump()  (self-clock)      │
  │         degraded? re-queue silent, capped at MAX_RETRIES=6 │
  └───────────────────────────────────────────────────────────┘
            one build at a time → stays under free-tier quotas
```

## Elaborate

This is "single-flight" in the Go `singleflight`/HTTP-cache sense (collapse
concurrent demand for the same work) crossed with a 1-slot worker queue. Real
systems usually allow N>1 in flight with a semaphore; flattr picks N=1 because the
binding constraint is *external rate limits*, not local CPU — one build keeps it
safely under Overpass/Open-Meteo quotas, and the builds aren't the user-facing
latency path (the bundled base graph already routes). The priority slot is the
piece that matters most: it's what guarantees an interaction (route) preempts
background work (pan-loading). → `07-elevation-batching-and-cache.md` for what the
single build does about elevation rate limits specifically.

## Interview defense

**Q: How do you keep pan + route from hammering rate-limited APIs?**

> A single-flight pump: `busyRef` allows exactly one graph build in flight; new
> requests get stashed in one of two pending slots — corridor (route) has priority
> over viewport (pan) — and the build's `finally` calls `pump()` to drain the
> next. So concurrency is hard-capped at 1, and a route never gets starved by
> panning. In front of it, a 600 ms debounce and span caps mean the pump rarely
> even has to refuse.

```
  busyRef=1  ·  corridor-before-view  ·  finally→pump self-clock
```

Anchor: *the `busyRef` boolean is the entire concurrency limit; `finally→pump` is
the self-clock people forget.*

**Q: Why max-in-flight of 1 and not a higher limit?**

> Because the bottleneck is external quota, not local CPU. The base graph already
> routes, so builds aren't on the user's critical latency path — one at a time is
> the safe choice to stay under Overpass/Open-Meteo free tiers. If the constraint
> were CPU/throughput I'd raise it with a semaphore; here raising it just buys
> more 429s.

```
  constraint = rate limit → N=1     constraint = throughput → semaphore N>1
```

Anchor: *match the concurrency limit to the actual binding resource.*

## See also

- `07-elevation-batching-and-cache.md` — what the one build does about elevation limits.
- `08-render-thread-search-and-debounce.md` — the debounce that feeds this pump.
- `audit.md` lens 3 (throughput), lens 6 (backpressure).
- Cross-guide: `study-runtime-systems` (bounded work, the event loop), `study-networking` (the rate limits).
