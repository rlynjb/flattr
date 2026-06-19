# 07 — Timeouts, retries, pooling, and backpressure
### timeouts, retries, jitter, connection pools, request collapse, and overload
**Industry name:** resilience / overload control — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

This is the load-bearing networking file in the repo. Everything flattr does to survive flaky, rate-limited free APIs lives here: retry-with-backoff, request collapsing (dedup), batching, the single-in-flight busy-lock, and the best-effort degrade-to-flat fallback. It's also where the biggest gap lives — *there is no client-side request timeout anywhere.* Verdict first: the retry/backoff and concurrency control are real and thoughtful; jitter and timeouts are missing; and the retry policy is inconsistent across providers.

```
  Zoom out — where resilience sits

  ┌─ App / Build layer ──────────────────────────────┐
  │  ★ retries · backoff · dedup · busy-lock ·        │ ← we are here
  │    best-effort fallback — the resilience logic ★  │
  │  fetch(url)  (no timeout / AbortSignal)            │
  └─────────────────────────┬─────────────────────────┘
  ┌─ Provider layer (free tier, rate-limited) ──────▼┐
  │  Overpass · Open-Meteo · Nominatim — 429 under load│
  └────────────────────────────────────────────────────┘
```

Zoom in: this layer answers "what does flattr do when the provider is slow, overloaded, or rate-limiting?" The free-tier 429 is the real, documented enemy (`.aipe/project/context.md`), and every mechanism here exists to stay under the limit or recover when it's hit.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** Pre-request (collapse + batch + throttle to *avoid* overload) → In-request (retry + backoff to *recover* from a transient failure) → Cross-request (busy-lock to *cap concurrency*) → Whole-build (best-effort fallback to *degrade* instead of fail).

**Axis — failure (where does overload originate, propagate, get contained?).**

```
  Axis "how is overload contained?" — across the resilience layers

  ┌──────────────────────────────────────────────────┐
  │ Pre-request: dedup + batch + throttle             │ → AVOID hitting limit
  └──────────────────────────────────────────────────┘
      ┌──────────────────────────────────────────────┐
      │ In-request: retry + backoff on 429/5xx        │ → RECOVER if hit
      └──────────────────────────────────────────────┘
          ┌──────────────────────────────────────────┐
          │ Cross-request: 1-at-a-time busy-lock      │ → CAP concurrency
          └──────────────────────────────────────────┘
              ┌──────────────────────────────────────┐
              │ Whole-build: degrade to flat (0m)     │ → CONTAIN failure
              └──────────────────────────────────────┘

  four layers, four distinct overload-containment moves
```

**Seams.** Two load-bearing seams. First, `busyRef` in `useTileGraph` — the boundary between "a build is running" and "a build is queued"; concurrency flips from N-possible to exactly-1 here. Second, `bestEffortElevation` — the boundary between "elevation succeeded" and "elevation failed but the build continues with zeros"; failure-containment flips from propagate to swallow here.

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know the standard retry shape: try, if it fails transiently wait a bit and try again, give up after N attempts? flattr has that — twice, with two different wait curves. But the more interesting shape is the *overload-avoidance* layered on top: collapse duplicate requests, batch many points into one call, throttle between calls, and only ever run one build at a time. Retry recovers from a 429; the avoidance layer tries to never earn one.

```
  Pattern — avoid, then recover, then cap, then degrade

  AVOID:    dedup ──► batch 100 ──► throttle 300ms between batches
                │
  RECOVER:  on 429/5xx: sleep(backoff) ──► retry ──► give up after N
                │
  CAP:      busy? ──► queue (corridor preempts view) ──► one at a time
                │
  DEGRADE:  elevation failed? ──► return 0m, keep building
```

#### Move 2 — walking each mechanism (the load-bearing skeleton)

The retry kernel is the irreducible core. Strip it to the minimum that's still "retry with backoff":

```
  The retry kernel — smallest thing that's still the pattern

  for attempt = 0, 1, 2, ...:
      res = fetch(url)
      if res.ok: return body              ← success exit
      if retryable(res.status) and attempt < N:
          sleep(backoff(attempt))         ← WAIT before retry
          continue
      throw                               ← give-up exit
```

**Part 1 — the retryable-status set (what breaks if missing: you'd retry 4xx forever or give up on transient blips).** Overpass retries `{429, 502, 503, 504}` (`pipeline/overpass.ts:18`). Open-Meteo retries *only* `429` (`pipeline/elevation.ts:114`). The set encodes "which failures are worth retrying" — 5xx and 429 yes (server/rate, transient), 4xx no (your request is wrong). Drop this check and you'd either hammer on a permanent 400 or treat a 503 as fatal.

**Part 2 — the backoff curve (what breaks if missing: instant retries = a tight loop that makes the overload worse).** Here's the inconsistency, drawn out:

```
  Execution trace — two different backoff curves

  Overpass (LINEAR):  delayMs * (attempt + 1)
    attempt 0 fails → sleep 2000ms  → attempt 1
    attempt 1 fails → sleep 4000ms  → attempt 2
    attempt 2 fails → sleep 6000ms  → attempt 3 → give up
    waits: 2s, 4s, 6s

  Open-Meteo (EXPONENTIAL):  delayMs * 2 ** (attempt + 1)
    attempt 0 fails → sleep 600ms   → attempt 1   (300 * 2^1)
    attempt 1 fails → sleep 1200ms  → attempt 2   (300 * 2^2)
    attempt 2 fails → sleep 2400ms  → attempt 3 → give up
    waits: 600ms, 1.2s, 2.4s
```

Two modules in one codebase, two curves. Exponential (Open-Meteo) is the textbook-correct choice — it backs off harder the longer the provider stays unhappy. Linear (Overpass) is gentler and caps lower. Neither is wrong, but the *inconsistency* is a smell: a reader can't predict the behavior without reading each module.

**Part 3 — the missing jitter (what breaks if missing: synchronized retries — the thundering herd).** Neither curve adds randomness. If flattr ever fired many requests that got 429'd together, they'd all back off by the *same* amount and retry at the *same* instant, re-colliding. flattr mostly dodges this by being single-threaded and sequential (Part 5), so the herd is small — but jitter is the standard hardening and it's `not yet exercised`.

```
  with jitter (NOT in flattr):  sleep(backoff(attempt) + random(0, spread))
  without (flattr):             sleep(backoff(attempt))  ← retries align
```

**Part 4 — request collapse via dedup (what breaks if missing: you'd sample elevation finer than the DEM and blow the rate limit).** Before any elevation request, `sampleElevations` collapses nodes that fall in the same `dedupePrecision`-sized cell to a single representative point (`pipeline/elevation.ts:42-50`). Many nodes → one query. This is request-collapsing: it cuts request count *before* the network, which is the cheapest possible rate-limit defense.

```
  Pattern — dedup collapses N points to 1 request

   node A (47.618, -122.328) ┐
   node B (47.618, -122.328) ┼─ same ~90m cell ─► ONE Open-Meteo query
   node C (47.618, -122.328) ┘                     result fanned back to A,B,C
```

**Part 5 — the single-in-flight busy-lock (what breaks if missing: a pan storm fires 10 parallel builds and instantly rate-limits you).** This is the most interesting mechanism in the file. `useTileGraph` runs *exactly one* graph build at a time, guarded by `busyRef`. Requests don't queue infinitely — there are exactly two pending slots (one corridor, one view), and the corridor *preempts* the view so a pending route isn't starved by panning.

```
  State machine — the busy-lock + 2-slot priority queue

   idle ──pan──► [pending view set]
        ──route─► [pending corridor set]
                       │ pump()
                       ▼
   busy (1 build running) ──new pan──► overwrites pending view
                          ──new route─► overwrites pending corridor
                       │ build done
                       ▼
   pump() drains: corridor FIRST, then view ──► back to idle
```

The "overwrite, don't append" design is deliberate: if you pan five times while a build runs, only the *last* viewport matters, so the pending slot is overwritten, not queued. This collapses a burst of pans into one follow-up build. Concurrency is capped at 1 specifically to stay under the free rate limits — the comment says so (`mobile/src/useTileGraph.ts:6-7`).

**Part 6 — best-effort degrade (what breaks if missing: a throttled elevation API fails the whole build and the screen stays empty).** `bestEffortElevation` wraps the provider so a thrown error yields `0 m` for every point instead of propagating (`mobile/src/useTileGraph.ts:18-28`). Streets still render, routing still connects (flat grades), and real grades fill in on a later load when the API recovers. This is failure containment: the elevation dependency is downgraded from "required" to "best-effort."

```
  Layers-and-hops — degrade contains the elevation failure

  ┌─ buildGraph ─┐  sample(points)   ┌─ Open-Meteo ──┐
  │              │ ────────────────► │ 429 / down    │
  │ bestEffort   │ ◄── throws ────── └───────────────┘
  │ catch → 0m   │                      │
  │ build continues with flat elevation │
  └──────────────┘  streets render, route connects, grades = 0 (for now)
```

**Part 7 — the missing timeout (what breaks if missing: a hung connection blocks forever).** No `fetch` in the repo passes an `AbortSignal` or any deadline. The Overpass QL carries a *server-side* `[timeout:60]` (`pipeline/overpass.ts:10`) — that's Overpass promising to abort its own query after 60s, not flattr aborting the connection. If a provider accepts the TCP connection but never responds (a half-open connection, a black-hole), flattr's `await fetch` hangs until the OS default kicks in (minutes), and the busy-lock means *the whole build pipeline is stuck* behind it. This is the top red flag (`08`).

#### Move 2.5 — the runtime tuning vs build tuning

The same retry code is tuned differently in the two phases:

```
  Comparison — same module, two tunings

  BUILD (run-build.ts)              RUNTIME (useTileGraph.ts:111)
  ──────────────────────            ───────────────────────────
  openMeteoProvider()               openMeteoProvider(fetch,
   → delayMs 300, retries 3           { delayMs: 400, retries: 1 })
  "take your time, get it right"    "fail fast → degrade to flat quickly
                                      instead of stalling on doomed 429s"
```

At build time you want fidelity, so retry hard. At runtime you want the screen to stay responsive, so retry *once* and fall back to flat fast. Same code, opposite priorities — a genuinely good use of the injectable options.

#### Move 3 — the principle

Resilience is layered: avoid the failure (collapse, batch, throttle, cap concurrency), recover from it (retry with backoff), and contain it (degrade gracefully). flattr does all three — the gap isn't the *shape*, it's the *hardening*: no timeout (a hung connection is unbounded), no jitter (retries align), and an inconsistent retry policy across providers. The single highest-leverage fix is a timeout, because without one no other resilience mechanism can bound how long a stuck call holds the pipeline.

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The complete resilience picture — all four layers and the two gaps.

```
  flattr resilience — avoid → recover → cap → degrade (+ 2 gaps)

  ┌─ AVOID overload (pre-request) ─────────────────────────────┐
  │  dedup (collapse same-cell pts) · batch 100 · throttle 300ms│
  └────────────────────────────┬───────────────────────────────┘
  ┌─ RECOVER (in-request) ──────▼──────────────────────────────┐
  │  retryable set {429,5xx} · backoff (LINEAR vs EXP — incons.)│
  │  ✗ NO JITTER (retries align)   ✗ NO TIMEOUT (hang = forever)│
  └────────────────────────────┬───────────────────────────────┘
  ┌─ CAP concurrency (cross-request) ─▼────────────────────────┐
  │  busyRef: 1 build at a time · 2 pending slots ·            │
  │  corridor PREEMPTS view · overwrite-not-append             │
  └────────────────────────────┬───────────────────────────────┘
  ┌─ DEGRADE (whole-build) ─────▼──────────────────────────────┐
  │  bestEffortElevation: elevation fails → 0m, build continues│
  └─────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** Reached on every provider call. Most visible in three places: the two retry loops (Overpass, Open-Meteo), the busy-lock pump, and the best-effort wrapper.

**The exponential-backoff retry loop** — `pipeline/elevation.ts` (lines 108-119):

```
  pipeline/elevation.ts  (lines 108-119)

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url);            ← NO timeout — can hang here
    if (res.ok) { json = await res.json(); break; } ← success exit
    if (res.status === 429 && attempt < retries) {  ← ONLY 429 retried
      await sleep(delayMs * 2 ** (attempt + 1));    ← EXPONENTIAL backoff
      continue;
    }
    throw new Error(`Open-Meteo elevation: ${res.status}`); ← give up
  }
        │
        └─ note: retries ONLY 429 (not 5xx, unlike Overpass). No jitter.
           The await fetchImpl has no AbortSignal → unbounded on a hang
```

**The busy-lock pump with corridor priority** — `mobile/src/useTileGraph.ts` (lines 89-129):

```
  mobile/src/useTileGraph.ts  (lines 89-129)

  const pump = useCallback(() => {
    if (busyRef.current) return;                 ← LOCK: one build at a time
    let kind, bbox;
    if (pendingCorridorRef.current) {            ← corridor wins (priority)
      kind = "corridor"; bbox = pendingCorridorRef.current;
      pendingCorridorRef.current = null;
    } else if (pendingViewRef.current) {         ← else viewport
      kind = "view"; bbox = pendingViewRef.current;
      pendingViewRef.current = null;
    } else return;                               ← nothing pending → idle
    busyRef.current = true;
    (async () => {
      try { ... await fetchOverpass(bbox) ... }
      catch { /* keep last region */ }           ← Overpass fail → no crash
      finally { busyRef.current = false; pump(); } ← unlock + DRAIN next
    })();
  }, []);
        │
        └─ the finally-pump is load-bearing: it drains the next pending
           request (corridor first). Without it, a queued pan/route after a
           build would never fire. busyRef caps concurrency at 1 for rate limits
```

**The best-effort degrade** — `mobile/src/useTileGraph.ts` (lines 18-28):

```
  mobile/src/useTileGraph.ts  (lines 18-28)

  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return {
      async sample(points) {
        try { return await p.sample(points); }   ← try real elevation
        catch { return points.map(() => 0); }     ← FAIL → flat 0m, no throw
      },
    };
  }
        │
        └─ converts a hard elevation dependency into a soft one: a 429 storm
           degrades grades to 0 rather than failing the build. Coverage > fidelity
```

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

The canonical resilience stack is: timeout → retry → backoff → jitter → circuit breaker → bulkhead. flattr implements retry + backoff and a crude bulkhead (the single-in-flight lock isolates the build from a request storm), but skips timeout, jitter, and circuit breaking. For a hobby-scale app against free APIs that's a defensible subset — except the timeout, which is the one omission that can actually wedge the app (a hung connection holds the busy-lock forever, and no later pan can recover because `busyRef` never clears). The standard fix is `AbortSignal.timeout(ms)` passed to every `fetch`, with the timeout itself being a retryable condition. The free-tier 429 reality documented in `.aipe/project/context.md` is the concrete proof that this layer matters: it's not theoretical resilience, it's the difference between a working build and a quota-exhausted dead one. The general theory of overload, backpressure, and circuit breaking lives in `.aipe/study-distributed-systems/`; the async/event-loop mechanics that `sleep`-via-`setTimeout` and the `await`-in-loop ride on live in `.aipe/study-runtime-systems/`.

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "Walk me through your retry strategy."**

Answer: "Retry-with-backoff on transient statuses, with a give-up after N. Overpass retries 429 plus 502/503/504 with linear backoff; Open-Meteo retries only 429 with exponential backoff. I don't retry 4xx because a client error won't fix itself. The honest weaknesses: the two backoff curves are inconsistent, there's no jitter so retries can align, and Nominatim has no retry at all. And the biggest one — no client timeout, so a hung connection blocks the pipeline indefinitely."

```
  retryable set {429,5xx} · backoff (linear OR exp) · give up after N
  gaps: no jitter · no timeout · inconsistent policy across providers
```

Anchor: *the retryable-status set is the load-bearing part — it's what stops you retrying a permanent 4xx forever.*

**Q: "How do you avoid getting rate-limited in the first place?"**

Answer: "Three pre-request moves. Dedup collapses points in the same ~90m DEM cell to one elevation query. Batching packs 100 points per request. And at runtime I cap concurrency at exactly one in-flight build with a busy-lock, with a two-slot pending queue where a route corridor preempts a viewport pan — so a burst of pans collapses into a single follow-up build instead of a storm. The free-tier 429 is a real, documented problem here, so all of this is load-bearing, not premature."

```
  dedup (collapse) → batch 100 → throttle → 1-in-flight busy-lock
  burst of pans → overwrite pending slot → ONE follow-up build
```

Anchor: *the single-in-flight busy-lock is the part people forget — capping concurrency at 1 is the cheapest backpressure against a rate limit.*

**Q: "What's the worst networking bug waiting in this code?"**

Answer: "A hung provider connection. No `fetch` has a timeout, so if Overpass accepts the TCP connection but never responds, `await fetch` hangs. At runtime that's worse than a crash: the busy-lock stays held, `busyRef` never clears, and every subsequent pan or route silently does nothing because `pump` early-returns on the lock. The fix is `AbortSignal.timeout` on every fetch, treating the abort as a retryable failure."

Anchor: *no timeout + a concurrency lock = one stuck call wedges the whole pipeline.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** Write the retry kernel from memory, then name the four overload-containment layers (avoid/recover/cap/degrade) and one mechanism each.
2. **Explain:** Why does runtime use `retries: 1` while build uses `retries: 3`? (`mobile/src/useTileGraph.ts:111` vs `pipeline/run-build.ts:37`)
3. **Apply:** A user pans the map 8 times in 2 seconds. Trace what `pump` does (`mobile/src/useTileGraph.ts:89-129`) and how many builds actually fire.
4. **Defend:** Pick the single highest-leverage resilience fix for this repo and justify it over the alternatives (timeout vs jitter vs unifying backoff vs circuit breaker).

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `05-http-semantics-caching-and-cors.md` — the status codes the retry set is built on.
- `03-tcp-udp-connections-and-sockets.md` — why no timeout means a TCP hang is unbounded.
- `08-networking-red-flags-audit.md` — the no-timeout and retry-inconsistency findings, ranked.
- `.aipe/study-distributed-systems/` — backpressure, circuit breaking, overload theory.
- `.aipe/study-runtime-systems/` — the async/event-loop model `sleep` and `await`-in-loop ride on.
