# 07 — Timeouts, Retries, Pooling, and Backpressure

**Resilience under load and failure** · *Industry standard*

## Zoom out, then zoom in

This is where flattr's networking gets interesting, because it's where the free-tier rate limits force real design. Three retry curves, a single-flight gate, a same-cell dedup, a persistent cache, and a self-heal loop — all aimed at one goal: *don't get 429'd by APIs you don't pay for.* And one conspicuous hole: no request timeout anywhere.

```
  Zoom out — the resilience machinery sits around every fetch

  ┌─ UI / pump scheduler ────────────────────────────────────┐
  │  debounce · single-flight gate · corridor priority        │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ ★ resilience band ★ ───▼─────────────────────────────────┐
  │  retry+backoff (per API) · dedup · cache · best-effort     │ ← we are here
  │  self-heal retry         · [NO timeout]                    │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ providers (free-tier, rate-limited) ───▼─────────────────┐
  │  429 when over quota · 5xx under load                      │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"when an API is slow, throttled, or down, what does flattr do?"* The answer is layered — first avoid the request (cache/dedup), then space it out (debounce/single-flight), then retry it (backoff), then give up gracefully (best-effort flat + self-heal). The missing layer is the *first* line of defense in most systems: a timeout to bound how long a single request can hang.

## Structure pass

**Layers.** Avoid → space → retry → degrade. Four layers of defense, applied in that order to every request.

```
  Layers — four defenses, applied in order

  ┌─ 1. AVOID ───────────────────────────────────────┐
  │  cache hit / dedup → no request at all            │
  └────────────────────────┬──────────────────────────┘
  ┌─ 2. SPACE ──────────────▼─────────────────────────┐
  │  debounce (600/400ms) · single-flight · throttle  │
  └────────────────────────┬──────────────────────────┘
  ┌─ 3. RETRY ──────────────▼─────────────────────────┐
  │  per-API backoff on retryable status              │
  └────────────────────────┬──────────────────────────┘
  ┌─ 4. DEGRADE ────────────▼─────────────────────────┐
  │  best-effort flat elevation + self-heal retry     │
  └────────────────────────────────────────────────────┘
```

**Axis = failure (where does an overloaded provider get absorbed?).** Trace it down the layers: layer 1 absorbs it by never asking; layer 2 by asking less often; layer 3 by asking again later; layer 4 by accepting a degraded answer. The failure is contained at whichever layer catches it first — and almost everything is caught before it reaches the user.

**Seam.** The retry/give-up boundary is the seam, and it's drawn three ways (the per-module status sets from `05`) plus a *count* boundary: Overpass `retries=3` linear (`overpass.ts:27`), Open-Meteo `retries=3` exponential (`elevation.ts:97`), runtime elevation `retries=1` fail-fast (`useTileGraph.ts:191`), geocode `retries=0`. Where the retry budget runs out, control flips from "try again" to "degrade or throw."

## How it works

### Move 1 — the mental model

You've written a `fetch` with a `try/catch`. flattr's resilience is that, scaled up: every request is wrapped in retry-with-backoff, but *before* it even gets there, a cache and a dedup try to skip the request, and a debounce + single-flight gate make sure too many don't fire at once. Think of it as concentric rings — the request only escapes to the network if it gets past the inner rings.

```
  Pattern — concentric defenses; a request escapes only if it must

   ┌─────────────────────────────────────────┐
   │ debounce (wait for pan/typing to settle) │
   │  ┌────────────────────────────────────┐  │
   │  │ single-flight (one build at a time)│  │
   │  │  ┌──────────────────────────────┐  │  │
   │  │  │ cache + dedup (skip request) │  │  │
   │  │  │   ┌────────────────────────┐ │  │  │
   │  │  │   │ retry + backoff        │ │  │  │
   │  │  │   │   → the actual fetch   │ │  │  │
   │  │  │   └────────────────────────┘ │  │  │
   │  │  └──────────────────────────────┘  │  │
   │  └────────────────────────────────────┘  │
   └───────────────────────────────────────────┘
```

### Move 2 — walk each mechanism

**Mechanism 1 — the three retry curves (the load-bearing skeleton).** This is the kernel: a loop that retries a retryable status with a growing delay, up to a budget. Here's the irreducible shape:

```
  Kernel — retry-with-backoff (what every API call shares)

  for attempt = 0, 1, 2, ...:
     res = fetch(...)
     if res.ok:          return parse(res)        // success
     if retryable(res) and attempt < budget:
        sleep(delay(attempt))                      // back off
        continue
     throw                                          // give up
```

Name each part by what breaks if removed: drop the `attempt < budget` check and a sustained outage retries *forever*; drop the `sleep` and you hammer a throttled server, guaranteeing more 429s; drop the `retryable()` filter and you retry a 400 that will never succeed. All three are load-bearing. Now the three real curves, side by side:

```ts
// overpass.ts:42-45 — LINEAR backoff: delayMs × (attempt+1) = 2s, 4s, 6s
if (RETRYABLE.has(res.status) && attempt < retries) {
  await sleep(delayMs * (attempt + 1));   // delayMs=2000, retries=3
  continue;
}
```

```ts
// elevation.ts:114-117 — EXPONENTIAL backoff: delayMs × 2^(attempt+1) = 600ms, 1.2s, 2.4s
if (res.status === 429 && attempt < retries) {
  await sleep(delayMs * 2 ** (attempt + 1));   // delayMs=300, retries=3
  continue;
}
```

Geocode has *no* loop — `if (!res.ok) throw` (`geocode.ts:24`). Three different curves because the failure modes differ (the `05` analysis), and the *delays* differ too: Overpass waits seconds (heavy build queries, infrequent), Open-Meteo starts sub-second (many small batches, quota-driven). The curve is tuned to the request's size and frequency.

**The hardening vs skeleton split:** the retry *loop* is the skeleton. The *specific* curve (linear vs exponential), the delay constants, and the retry budget are hardening tuned per API. Saying which is which is the lesson — the loop is universal; the numbers are flattr-specific knobs.

**Mechanism 2 — single-flight gate (backpressure at the scheduler).** `pump()` allows exactly one build in flight via `busyRef`, and corridor (route) requests preempt viewport (pan) requests:

```ts
// useTileGraph.ts:166-180 — one in-flight, corridor first
const pump = useCallback(() => {
  if (busyRef.current) return;            // already building → drop through, will drain later
  if (pendingCorridorRef.current) { kind = "corridor"; ... }   // priority
  else if (pendingViewRef.current) { kind = "view"; ... }
  else return;
  busyRef.current = true;
  // ... build ... finally { busyRef.current = false; pump(); }  // drain next
});
```

This is backpressure: when builds arrive faster than they complete (rapid panning), the gate collapses them — only the latest pending viewport survives (each `queueViewport` overwrites `pendingViewRef`), so flattr never queues a backlog of stale builds. Drop this gate and rapid panning fires concurrent Overpass+elevation builds, blowing the rate limit instantly.

```
  Execution trace — rapid pan, single-flight collapses the backlog

  t0  pan A → pendingView=A, pump() → busy, building A
  t1  pan B → pendingView=B           (A still building)
  t2  pan C → pendingView=C           (overwrites B — B never runs)
  t3  A done → busy=false → pump() → builds C   (B was collapsed)
  result: 2 builds (A, C), not 3 — backlog absorbed
```

**Mechanism 3 — cache + dedup (request collapse, the avoid layer).** Covered in depth in `05`, recapped here as resilience: the persistent AsyncStorage cache (`elevCache.ts`) means revisited areas issue *zero* elevation requests, and the same-cell dedup (`elevation.ts:42`) collapses many nearby coordinates into one query. This is the single biggest lever against throttling — far more than retry tuning. The comment says it outright: cache hits are "the main cause of throttling" eliminated (`useTileGraph.ts:34`).

**Mechanism 4 — best-effort degradation + self-heal (the give-up-gracefully layer).** When elevation fails despite retries, `bestEffortElevation` catches it and returns flat `0`m elevation rather than failing the whole build (`useTileGraph.ts:20-31`). The region is marked `degraded`, excluded from the heatmap, and *quietly re-queued* on a 12s timer up to 6 times (`useTileGraph.ts:209-218`, `RETRY_MS`, `MAX_RETRIES`):

```
  Layers-and-hops — elevation fails → degrade → self-heal

  ┌─ cachedElevation ─┐ miss → fetch throws (429, no budget left)
  └─────────┬──────────┘
            ▼ caught by
  ┌─ bestEffortElevation (useTileGraph:20) ─┐ return 0m, onFallback()
  └─────────┬───────────────────────────────┘
            ▼ build completes with degraded=true
  ┌─ region marked degraded ────────────────┐ excluded from displayGraph
  └─────────┬───────────────────────────────┘
            ▼ 12s timer (RETRY_MS), silent, ≤6×
  ┌─ re-queue same bbox ────────────────────┐ pump() → fresh attempt
  └──────────────────────────────────────────┘ real grades → stops retrying
```

This is the runtime's "reconnect" equivalent — not a stream reconnect (there's no stream, per `06`), but a re-issue of a fresh one-shot build until the API recovers.

**Mechanism 5 — pooling: NOT EXERCISED.** flattr sets no connection-pool size, no max-sockets, no keep-alive header, no HTTP/2 multiplexing knob. The platform pools by default (the `03` analysis), but flattr controls none of it. *(Inference from platform defaults; flattr-side fact: no pool config exists.)*

**The hole — NO TIMEOUT, anywhere.** Not one `fetch` is wrapped in `AbortController`/`AbortSignal`. Confirmed by repo-wide search: zero abort usage. The consequence is concrete: if Overpass accepts the TCP connection but never responds (a half-open connection, a hung server), the `await fetch` hangs until the *OS* TCP timeout fires — which can be minutes. At build time, the build stalls. At runtime, `busyRef` stays `true`, so the single-flight gate is *jammed* — no further builds run, panning loads nothing, and the user sees a stuck "Fetching streets" loader with no recovery. The retry budget never even engages, because retries only trigger on a *returned status*, not on a hang. This is the #1 red flag (`08`).

```
  Comparison — what a timeout would change

  now (no timeout):                 with AbortController (5s):
  ──────────────────────            ───────────────────────────
  hung fetch → await blocks         hung fetch → abort at 5s
  busyRef stuck true (runtime)      → throws → catch → busyRef freed
  gate jammed, loader stuck         → self-heal retry can run
  recovers only at OS TCP timeout   recovers in 5s
  (minutes)
```

### Move 3 — the principle

The cheapest request is the one you never send — flattr's resilience is *avoid → space → retry → degrade*, in that order, and the inner two rings (cache, dedup, single-flight) carry far more weight than the retry curves everyone fixates on. But retry-and-backoff is necessary, not sufficient: a retry loop only handles requests that *return*. A request that *hangs* needs a timeout, and that's the one defense flattr is missing. The principle: pair every retry budget with a timeout, because backoff handles errors and the timeout handles silence.

## Primary diagram

The complete resilience machine — four layers, three curves, the gate, and the hole.

```
  flattr resilience — complete

  ┌─ scheduler (backpressure) ─────────────────────────────────┐
  │  debounce 600/400ms → single-flight gate (busyRef) →        │
  │  corridor preempts viewport · backlog collapses to latest   │
  └────────────────────────┬────────────────────────────────────┘
                           ▼
  ┌─ avoid ────────────────────────────────────────────────────┐
  │  persistent cache (AsyncStorage) + same-cell dedup → skip   │
  └────────────────────────┬────────────────────────────────────┘
                           ▼  only misses reach here
  ┌─ retry + backoff (per API) ────────────────────────────────┐
  │  Overpass  linear  2/4/6s   {429,502,503,504} ×3            │
  │  Open-Meteo expo    .6/1.2/2.4s  {429} ×3 (runtime ×1)      │
  │  Geocode   none     throw immediately                       │
  │  ⚠ NO TIMEOUT — a hang blocks here forever (jams the gate)  │
  └────────────────────────┬────────────────────────────────────┘
                           ▼  budget exhausted
  ┌─ degrade ──────────────────────────────────────────────────┐
  │  best-effort flat 0m + self-heal re-queue (12s ×6)          │
  └─────────────────────────────────────────────────────────────┘
     not exercised: jitter · Retry-After · connection-pool config
```

## Elaborate

The thing flattr gets right that most juniors miss: retry without jitter causes a *thundering herd* — if many clients (or many batches) back off on the same fixed schedule, they retry in sync and re-overload the server. flattr's curves have no jitter (a gap — see `08`), but its *single-flight gate* accidentally mitigates it at runtime by ensuring only one build retries at a time. At build time, the sequential batch loop does the same. So the herd is small by construction. The proper fix is still jitter on the backoff (`delay * (1 + random())`), cheap to add. For the AI pivot: LLM provider calls have the exact same shape — rate limits, 429s, the need for backoff-with-jitter and a timeout — so this machinery transfers directly.

## Interview defense

**Q: What's the single biggest weakness in flattr's networking?**
No request timeout. Every `fetch` can hang indefinitely — confirmed, zero `AbortController` usage. At runtime a hung Overpass request leaves `busyRef` stuck true, jamming the single-flight gate so the whole map stops loading until the OS TCP timeout fires (minutes). The retry budget doesn't help because retries trigger on returned statuses, not on silence. The fix is a 5–10s `AbortController` on each fetch. Anchor: *backoff handles errors; a timeout handles silence — flattr has the first, not the second.*

**Q: Why do Overpass and Open-Meteo use different backoff curves?**
The curve is tuned to request size and frequency. Overpass uses linear 2/4/6s — heavy queries, infrequent, can afford to wait (`overpass.ts:44`). Open-Meteo uses exponential starting at 600ms — many small batches, quota-driven, wants to recover fast (`elevation.ts:114`). Geocode retries nothing because it's UI-debounced and a dropped suggestion is harmless. Anchor: *retry curve matches the request's size, frequency, and failure mode.*

**Q: What stops rapid panning from blowing the rate limit?**
The single-flight gate in `pump()` — one build in flight, and the pending viewport slot is overwritten by each new pan, so a backlog of stale builds collapses to just the latest (`useTileGraph.ts:166`). Combined with the persistent elevation cache, revisited areas issue zero requests. Anchor: *single-flight + cache; the cheapest request is the one never sent.*

## See also

- `05-http-semantics-caching-and-cors.md` — the status sets behind each retry curve, and the cache in depth
- `08-networking-red-flags-audit.md` — the missing timeout and jitter, ranked
- `03-tcp-udp-connections-and-sockets.md` — why pooling is the platform's, not flattr's
- `.aipe/study-performance-engineering/` — the cache/dedup/debounce as throughput levers
