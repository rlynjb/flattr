# Timeouts, retries, pooling, and backpressure

**Industry name(s):** retry-with-backoff · rate limiting · backpressure · request collapse. **Type:** Industry standard.

## Zoom out, then zoom in

This is the load-bearing chapter. Everything flattr does to survive three free,
rate-limited APIs it doesn't control lives here: per-API retry curves, exponential vs
linear backoff, a single-in-flight concurrency cap, debounce, dedup, and best-effort
degradation. It's also where the **single biggest gap** lives — there is no client request
timeout anywhere.

```
  Zoom out — the resilience layer flattr wraps around every call

  ┌─ flattr resilience code ───────────────────────────────────┐
  │  ★ retry + backoff (per-API curves) ★                       │ ← THIS CONCEPT
  │  ★ concurrency cap = 1 (the pump) ★                         │
  │  ★ debounce · dedup · best-effort fallback ★                │
  │  ✗ NO request timeout (the gap)                            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ wraps every fetch (05) over TLS (04)
  ┌─ three rate-limited free APIs ▼──────────────────────────────┐
  │  Overpass (429/5xx) · Open-Meteo (429) · Nominatim (~1 req/s)│
  └───────────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **politeness under rate limits**: how flattr backs off, paces, and
collapses requests so it doesn't get 429'd off the free tiers — plus the one missing piece
(timeout) that makes a hung connection unrecoverable.

## The structure pass

**Layers.** Three nested rings of defense:
- **inner — per-request:** retry + backoff inside each client.
- **middle — per-trigger:** debounce + dedup + cache cut how many requests are even made.
- **outer — global:** the single-in-flight pump caps concurrency and prioritizes routing.

**Axis traced: cost — what does each layer spend to avoid a 429?**

```
  Axis: "what does each ring spend to stay under the limit?"

  ┌─ outer: pump (concurrency=1) ─┐  spends LATENCY (serializes builds)
  └──────────┬─────────────────────┘
  ┌─ middle: debounce/dedup/cache ─┐  spends FRESHNESS/SIMPLICITY (skips work)
  └──────────┬─────────────────────┘
  ┌─ inner: retry+backoff ────────┐  spends TIME (waits, then re-tries)
  └────────────────────────────────┘
  every ring trades a different cost for the same prize: no 429
```

**Seam.** The load-bearing seam is `res.status` → flattr's wait/throw decision (from
`05`). On one side the server reports a status; on the other flattr decides whether to
sleep-and-retry or give up. The retry *curve* is what flattr writes on its side of that
seam — and it's different per API.

## How it works

### Move 1 — the mental model

You've written a retry loop: try, if it fails wait a bit, try again, give up after N. The
whole chapter is that loop plus three refinements — *how long* you wait (backoff curve),
*how many* requests you make at all (collapse), and *what happens when you give up*
(degrade vs throw). The kernel is the same everywhere:

```
  The kernel — retry-with-backoff (what breaks if each part is removed)

  for attempt = 0, 1, 2, …:
     res = fetch(url)
     if res.ok:            return res          ← without this, never succeeds
     if retryable(res) and attempt < retries:  ← without the cap, retries forever
        sleep(backoff(attempt))                ← without backoff, hammers the server
        continue
     throw / degrade                           ← without this, hangs on permanent failure
```

Drop the attempt cap → infinite retry loop. Drop the backoff → you hammer an
already-overloaded server and get 429'd harder. Drop the retryable check → you retry a 404
that will never succeed. Each part is load-bearing; the rest is tuning.

### Move 2 — the step-by-step walkthrough

**Overpass: linear backoff over the load-shedding status set.** Overpass public servers
return 429/502/503/504 transiently under load, so flattr retries that whole set with a
backoff that grows *linearly* — `delayMs * (attempt + 1)` = 2s, 4s, 6s.

```
  pipeline/overpass.ts:42-45 — linear backoff, RETRYABLE set
  ┌──────────────────────────────────────────────────────────────┐
  │ const RETRYABLE = new Set([429, 502, 503, 504]); // line 18   │
  │ if (RETRYABLE.has(res.status) && attempt < retries) {        │
  │   await sleep(delayMs * (attempt + 1));  // ◄ 2s, 4s, 6s      │
  │   continue;                              //   LINEAR growth   │
  │ }                                                             │
  │ throw new Error(`Overpass request failed: ${res.status}`);   │
  └──────────────────────────────────────────────────────────────┘
```
Defaults: `retries=3`, `delayMs=2000` (`overpass.ts:27-28`). Linear is fine here because
Overpass overload clears in seconds, not minutes — a gentle ramp suffices.

**Open-Meteo: exponential backoff, 429 only.** Open-Meteo's only transient signal is 429
(quota), and quota recovery is slower/spikier, so flattr backs off *exponentially* —
`delayMs * 2^(attempt+1)` = 600ms, 1.2s, 2.4s. Anything that isn't a 429 throws
immediately (no point retrying a malformed request).

```
  pipeline/elevation.ts:114-118 — exponential backoff, 429 ONLY
  ┌──────────────────────────────────────────────────────────────┐
  │ if (res.status === 429 && attempt < retries) {               │
  │   await sleep(delayMs * 2 ** (attempt + 1)); // ◄ 600/1200/2400│
  │   continue;                                  //   EXPONENTIAL │
  │ }                                                            │
  │ throw new Error(`Open-Meteo elevation: ${res.status}`);      │
  └──────────────────────────────────────────────────────────────┘
```
Compare the two curves directly — the divergence is the whole point:

```
  Comparison — two backoff curves, two API failure shapes

  attempt:        0        1        2
  Overpass  →   2000ms   4000ms   6000ms    (linear · transient overload)
  Open-Meteo →   600ms   1200ms   2400ms    (exponential · quota recovery)

  same retry kernel, different curve per API's recovery behavior
```

**Nominatim: no retry at all — prevention over recovery.** Nominatim's ~1 req/s policy
means a 429 is *flattr's fault* for exceeding the rate, so retrying would dig the hole
deeper. flattr throws on any non-2xx (`geocode.ts:24`) and instead **prevents** the 429
upstream, in the UI:

```
  mobile/src/MapScreen.tsx:73-89 — debounce so the 429 never happens
  ┌──────────────────────────────────────────────────────────────┐
  │ const scheduleSuggest = useCallback((field, text) => {       │
  │   if (suggestTimer.current) clearTimeout(suggestTimer.current);│ ◄ cancel prior keystroke
  │   if (text.trim().length < 3) { setSuggestions([]); return; } │ ◄ don't fire on 1-2 chars
  │   suggestTimer.current = setTimeout(async () => {            │
  │     const results = await geocodeSuggest(text, …);           │ ◄ ONE request after
  │   }, 400);                                                   │   400ms of quiet typing
  │ });                                                          │
  └──────────────────────────────────────────────────────────────┘
```
And the two route geocodes run **sequentially**, not in parallel, with the policy noted in
the code itself (`MapScreen.tsx:189`): `const b = await geocode(to, …); // sequential:
Nominatim allows ~1 req/sec`. That's request pacing by structure, not by retry.

**The pump: concurrency capped at one, with priority — flattr's backpressure.** The
bluntest backpressure there is. At most one Overpass+elevation build runs at a time, and a
pending route corridor jumps the queue ahead of a panning viewport:

```
  mobile/src/useTileGraph.ts:166-180 — single-in-flight + priority
  ┌──────────────────────────────────────────────────────────────┐
  │ const pump = () => {                                          │
  │   if (busyRef.current) return;          // ◄ ONE build at a time│
  │   if (pendingCorridorRef.current) { kind="corridor"; … }      │ ◄ route BEATS pan
  │   else if (pendingViewRef.current) { kind="view"; … }         │
  │   else return;                                                │
  │   busyRef.current = true;                                     │
  │   …                                                           │
  │   finally { busyRef.current = false; pump(); } // drain next  │ ◄ self-clocking queue
  │ };                                                            │
  └──────────────────────────────────────────────────────────────┘
```
This is backpressure as a **collapse**: rapid pans don't queue up N builds — a new request
overwrites the single `pendingViewRef` slot (`useTileGraph.ts:239`), so only the latest
viewport gets fetched. Bounded work, newest-wins.

**Request collapse via dedup + cache — the volume never reaches the wire.** Two
collapses cut requests before any retry logic runs: (1) elevation dedup by DEM cell
(`elevation.ts:42`) means nodes in the same ~90m cell share one sample; (2) the persistent
cache (`elevCache.ts`) means revisited cells cost zero requests. Fewer requests = fewer
429s = retry logic rarely fires.

```
  Layers-and-hops — collapse cuts volume before the retry ring

  ┌─ N nodes ─┐ dedup by cell ┌─ M reps ─┐ cache hits ┌─ K misses ─┐ retry ┌─ Meteo ─┐
  │  (many)   │ ─────────────►│ (fewer)  │ ──────────►│ (fewest)   │──────►│         │
  └───────────┘ elevation.ts  └──────────┘ elevCache  └────────────┘backoff└─────────┘
   the retry/backoff ring only ever sees K, not N
```

**Best-effort degradation — what happens when you give up.** When elevation *still* fails
after its one retry, the mobile build doesn't throw — it flattens to 0 m elevation so the
streets still render and routing still connects, then flags the region for self-heal:

```
  mobile/src/useTileGraph.ts:20-31, 191 — fail-fast, then degrade
  ┌──────────────────────────────────────────────────────────────┐
  │ openMeteoProvider(fetch, { delayMs: 400, retries: 1 })  ◄──── │ only 1 retry: fail FAST
  │ bestEffortElevation(cachedElevation(…), () => degraded=true)  │
  │   async sample(points) {                                      │
  │     try { return await p.sample(points); }                    │
  │     catch { onFallback(); return points.map(() => 0); }  ◄──── │ degrade, don't throw
  │   }                                                          │
  └──────────────────────────────────────────────────────────────┘
```
Note `retries: 1` at runtime — on device, flattr deliberately gives up *fast* and degrades,
rather than stalling the UI on long backoffs. The build-time default is `retries: 3` (more
patient, no user waiting). Same code, different patience by context.

**The gap: no request timeout, anywhere.** This is the top finding (`08`). None of the
three clients pass an `AbortSignal`; there is no `AbortController` in the entire repo
(verified across `pipeline/`, `mobile/src/`, `lib/`, `features/`). The
`[out:json][timeout:60]` in `overpass.ts:10` is a *server-side* Overpass query budget —
it bounds how long Overpass computes, not how long flattr's `fetch` waits.

```
  Comparison — what flattr has vs the missing timeout

  HAS:  retry cap · backoff · concurrency cap · degrade
  MISSING:  fetch timeout (AbortController)

  consequence: server accepts the connection then HANGS
    → await fetch never resolves
    → the pump's busyRef stays true forever
    → NO further build ever runs (pump() early-returns)
    → degraded regions never self-heal
  the missing timeout doesn't just slow one call — it can freeze the
  whole single-in-flight pipeline
```
This is the sharp edge of combining a concurrency-of-one pump with no timeout: a single
hung connection deadlocks the *entire* runtime fetch pipeline, not just one request. A
~15s `AbortController` per `fetch` would close it.

### Move 3 — the principle

The retry kernel is universal — try, cap, backoff, give up — but the *curve* and the
*give-up behavior* must match each dependency's real recovery shape: linear for transient
overload, exponential for quota, no-retry-plus-prevention for a hard rate policy.
flattr gets all three right. The one thing every retry loop also needs — a bound on how
long a *single* attempt can hang — is the one thing flattr lacks, and with a
concurrency-of-one pump that omission is upgraded from "slow request" to "frozen
pipeline." The principle: **retries bound failure across attempts; a timeout bounds failure
within one — you need both, and flattr proves what happens when you ship only the first.**

## Primary diagram

```
  flattr resilience — three rings of defense + the one missing piece

  ┌─ OUTER: pump (useTileGraph.ts:166) ───────────────────────────┐
  │  concurrency = 1 · corridor > viewport · newest-wins collapse  │
  │  ┌─ MIDDLE: cut volume before the wire ──────────────────────┐ │
  │  │  debounce 400ms (MapScreen:88) · dedup by DEM cell         │ │
  │  │  (elevation:42) · persistent cache (elevCache) · sequential│ │
  │  │  geocodes (MapScreen:189)                                  │ │
  │  │  ┌─ INNER: per-request retry+backoff ───────────────────┐ │ │
  │  │  │  Overpass  : {429,5xx}, LINEAR   2/4/6s   retries 3   │ │ │
  │  │  │  Open-Meteo: {429},     EXP    .6/1.2/2.4s retries 3/1│ │ │
  │  │  │  Nominatim : no retry — prevented by debounce         │ │ │
  │  │  │  give up → degrade to flat (runtime) / throw (build)  │ │ │
  │  │  └────────────────────────────────────────────────────────┘ │ │
  │  └────────────────────────────────────────────────────────────┘ │
  │  ✗ MISSING: per-fetch timeout → a hang freezes the whole pump   │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

Retry-with-backoff, jitter, and circuit-breaking are the canon of resilient client
design; flattr implements the core (retry + backoff + caps + collapse) and skips the rest.
The two omissions worth naming: there's **no jitter** on the backoff (all clients of a
thundering herd would retry in lockstep — low risk for a single-user app, real for a
fleet), and **no timeout** (the top gap). The thing flattr does unusually well is
*prevention over recovery*: the cache, dedup, debounce, and single-in-flight pump mean the
retry ring rarely even fires — the cheapest 429 to recover from is the one you never
provoke. Read `08` next: it ranks these — timeout first — against their real consequence.

## Interview defense

**Q: Walk me through flattr's retry strategy.**
> Three different curves, one per API's recovery shape. Overpass: retry 429/5xx with linear
> backoff (2/4/6s) — transient overload clears fast. Open-Meteo: retry 429 only,
> exponential (.6/1.2/2.4s) — quota recovery is spikier. Nominatim: no retry — its ~1 req/s
> policy means a 429 is your fault, so flattr *prevents* it with a 400ms debounce and
> sequential calls instead.

```
  Overpass linear · Open-Meteo exponential · Nominatim prevent-don't-retry
```
> Anchor: *the retry curve matches the API's failure contract — same kernel, three shapes.*

**Q: What's the biggest networking risk in flattr?**
> No request timeout anywhere — no `AbortController` in the repo. With a concurrency-of-one
> pump, a single server that accepts then hangs leaves `await fetch` pending forever,
> `busyRef` stuck true, and the *entire* build pipeline frozen — not just one call. A ~15s
> `AbortController` per fetch fixes it. The server-side `[out:json][timeout:60]` is an
> Overpass compute budget, not a client timeout.

```
  hang + no timeout + pump(busyRef) ⇒ frozen pipeline (not just one slow call)
```
> Anchor: *retries bound failure across attempts; a timeout bounds it within one — flattr only shipped the first.*

**Q: How does flattr avoid hammering the free APIs?**
> Prevention over recovery. Persistent cache + DEM-cell dedup cut request volume before the
> wire; debounce + sequential geocodes pace the UI; a single-in-flight pump with
> newest-wins collapse caps concurrency at one and drops stale pans. The retry ring is the
> last resort, not the first.

```
  cache/dedup (volume) → debounce/sequential (pace) → pump (concurrency=1) → retry
```
> Anchor: *the cheapest 429 to recover from is the one you never provoke.*

## See also

- `05-http-semantics-caching-and-cors.md` — the status branch these curves attach to; the cache.
- `06-websockets-sse-streaming-and-realtime.md` — the self-heal timer as polling, not streaming.
- `08-networking-red-flags-audit.md` — these mechanisms ranked by risk; timeout is #1.
- `study-performance-engineering` · `study-distributed-systems` — backpressure and partial-failure framing.
