# Partial Failure, Timeouts & Retries

**Industry name(s):** partial failure / retry-with-backoff / deadline propagation · *Industry standard*

## Zoom out, then zoom in

This is the concept the repo exercises most directly — and the one with the sharpest gap. It lives right on the one boundary from the map: the HTTP call into a provider you don't own.

```
  Zoom out — where retry/backoff/timeout live

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  MapScreen → useTileGraph pump                           │
  └────────────────────────┬─────────────────────────────────┘
                           │ calls
  ┌─ Coordination layer ───▼─────────────────────────────────┐
  │  fetchOverpass()   ★ retry + backoff live HERE ★          │ ← we are here
  │  openMeteoProvider().sample()  ★ retry + backoff HERE ★   │
  │  geocode()         ✗ no retry, ✗ no timeout               │
  └────────────────────────┬─────────────────────────────────┘
                           │ HTTP (can hang / 429 / 503 / drop)
  ┌─ Provider layer ───────▼─────────────────────────────────┐
  │  Overpass · Open-Meteo · Nominatim                       │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Partial failure is the thing that makes distributed systems hard: a call can fail in ways a local function call never can — it can hang forever (no answer, no error), it can return "try again later" (429/503), or the answer can arrive but too late to matter. Retries, backoff, and timeouts are the three tools for turning those non-deterministic failures into something your code can reason about. flattr has the first two and is missing the third.

## Structure pass

**Layers.** The pump (caller) → the fetch wrapper (policy) → the provider (failure source).

**The axis: `failure` — what kind is it, and is it safe to retry?** The whole retry decision hinges on *classifying* the failure. Trace it across the boundary:

```
  Failure classification — the axis that decides "retry or give up"

  failure type        │ example       │ retryable? │ flattr's answer
  ────────────────────┼───────────────┼────────────┼──────────────────
  transient overload  │ 429, 503, 502 │ YES        │ backoff + retry ✓
  gateway timeout     │ 504           │ YES        │ backoff + retry ✓
  permanent client    │ 400, 404      │ NO         │ throw immediately ✓
  hung connection     │ (no response) │ N/A        │ ✗ HANGS FOREVER
```

**The seam where it flips.** Inside `fetchOverpass` the `RETRYABLE` set (`overpass.ts:18`) is the literal line where "retry" flips to "give up." A 503 loops; a 400 throws. That `Set` *is* the failure classifier — the load-bearing part of the whole pattern. The hung-connection row is the seam with no guard: there's no `AbortController`, so a TCP connection that opens but never responds sits in `await fetchImpl(...)` indefinitely.

## How it works

### Move 1 — the mental model

You know retry-with-backoff from the frontend: a flaky API call, you wrap it, wait a bit, try again, and wait *longer* each time so you don't hammer a struggling server. The kernel is four parts — and naming each by what breaks when it's gone is how you prove you built it, not read about it.

```
  The retry kernel — name each part by what breaks without it

  ┌──────────────────────────────────────────────────────────┐
  │  loop:                                                    │
  │    result = call()                                        │
  │    if success            → return        ← without: never stops │
  │    if NOT retryable      → throw         ← without: retries 404s forever │
  │    if attempts exhausted → throw         ← without: infinite loop │
  │    sleep(backoff(attempt)) ; retry       ← without: hammers the server │
  └──────────────────────────────────────────────────────────┘

  MISSING in flattr: a deadline around `call()` itself
  ← without it: a hung connection blocks the loop before any of
    the four guards ever runs
```

The four guards are all present in flattr. The missing fifth — a per-attempt deadline — is the gap, and it sits *outside* the four, wrapping the call, which is why none of the existing guards catch it.

### Move 2 — the walkthrough

**Part 1 — classify before you retry (Overpass).** Here's the real classifier, side by side with what each line does:

```ts
// pipeline/overpass.ts:17-18
// Overpass public servers commonly return these transiently under load.
const RETRYABLE = new Set([429, 502, 503, 504]);
```

```ts
// pipeline/overpass.ts:32-47 — the retry loop
for (let attempt = 0; ; attempt++) {              // unbounded counter, guarded below
  const res = await fetchImpl(endpoint, {...});    // ← NO timeout: can hang here forever
  if (res.ok) return (await res.json()) as ...;    // success guard → exits
  if (RETRYABLE.has(res.status) && attempt < retries) {  // classify + budget, BOTH must hold
    await sleep(delayMs * (attempt + 1));          // LINEAR backoff: 2s, 4s, 6s
    continue;                                      // retry
  }
  throw new Error(`Overpass request failed: ${res.status}`);  // not retryable OR budget spent
}
```

Line by line: the `for` has no terminating condition in the header — termination is entirely the two `if`s inside. A retryable status with budget left sleeps and continues; everything else throws. The backoff is **linear** (`delayMs * (attempt + 1)` → 2s, 4s, 6s). That's fine for a build script hitting Overpass a few times.

**Part 2 — exponential backoff (Open-Meteo).** The elevation provider does the same shape with a steeper curve, because run-time throttling needs to back off harder:

```ts
// pipeline/elevation.ts:108-119 — inside openMeteoProvider().sample()
for (let attempt = 0; ; attempt++) {
  const res = await fetchImpl(url);              // ← again, NO timeout
  if (res.ok) { json = ...; break; }            // success
  if (res.status === 429 && attempt < retries) {
    await sleep(delayMs * 2 ** (attempt + 1));   // EXPONENTIAL: 600ms, 1.2s, 2.4s...
    continue;
  }
  throw new Error(`Open-Meteo elevation: ${res.status}`);
}
```

Note the difference from Overpass: only `429` is treated as retryable here (`elevation.ts:114`), and the backoff is `delayMs * 2 ** (attempt+1)` — doubling. Two providers, two backoff strategies, deliberately. **Neither has jitter** — if two clients ever throttled in lockstep they'd retry in lockstep (the thundering-herd problem); with a single client it doesn't bite, so it's a fine omission to name and skip.

**Part 3 — the run-time tuning: fail fast on purpose.** The pump calls Open-Meteo with `retries: 1`, not the default 3:

```ts
// mobile/src/useTileGraph.ts:190-191
const elev = bestEffortElevation(
  cachedElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 })),
```

The comment two lines up says why: *"fail-fast elevation so a throttled build degrades to flat quickly instead of stalling on doomed 429 backoffs."* This is a real distributed-systems judgment call. At build time you *want* to wait out a 429 (you have no user). At run time a user is staring at a spinner, so you'd rather give up after one retry and fall back to flat grades (Part 4) than make them wait through 600ms + 1.2s + 2.4s of backoff. **Same provider, opposite retry budget, because the lifecycle changed.**

**Part 4 — the timeout gap (the red flag).** Every `await fetchImpl(...)` above assumes the request *eventually* returns — with `res.ok` or an HTTP error status. But a connection can open and then go silent: the server accepts the socket and never sends bytes. `fetch` has no default timeout. So:

```
  What a hung connection does — the missing deadline

  pump.busyRef = true
        │
        ▼
  await fetchOverpass(bbox)
        │
        ▼
  await fetchImpl(endpoint)  ──► [ connection opens, server goes silent ]
        │
        ▼
   ⌛ blocks FOREVER — never .ok, never throws, never enters the retry loop
        │
        ▼
  busyRef stays true  ──► pump is wedged  ──► NO further viewport/corridor
                                              builds ever run again
```

This is the top red flag in `09`. The fix is small: wrap each `fetchImpl` call with an `AbortController` + `setTimeout(() => controller.abort(), DEADLINE)`, pass `signal` into fetch, and treat the abort as a retryable failure. That converts "hang forever" into "timeout → retry → eventually fall back to flat," which the rest of the machinery already handles.

### Move 2.5 — current vs future

```
  Phase A (now)                    Phase B (with timeout added)
  ─────────────                    ────────────────────────────
  retry ✓  backoff ✓               retry ✓  backoff ✓
  classify ✓                       classify ✓
  timeout ✗ → hang wedges pump     timeout ✓ → hang becomes a retryable failure
  jitter ✗ (fine: 1 client)        jitter — still optional until multi-client
```

What *doesn't* have to change: the retry loops, the classifier, the fallback. The timeout slots in as one more retryable failure class. That's the migration cost — small, localized to the two fetch wrappers.

### Move 3 — the principle

Retries handle the failures that *announce themselves* (a 429 is the server politely saying "later"). Timeouts handle the failures that *don't* — silence. A retry loop without a deadline is half a solution: it survives every failure the server tells you about and none of the failures where the server says nothing. In a distributed system, silence is the most common failure mode of all.

## Primary diagram

```
  Partial-failure handling — full recap across the boundary

  ┌─ Coordination layer ─────────────────────────────────────────┐
  │  pump (busyRef = single in-flight)                            │
  │     │                                                         │
  │     ▼                                                         │
  │  ┌─ retry wrapper ──────────────────────────────────────┐    │
  │  │  call ──► classify(status)                            │    │
  │  │            ├─ ok          → return                    │    │
  │  │            ├─ 429/5xx + budget → backoff → retry      │    │
  │  │            │     Overpass: linear 2/4/6s              │    │
  │  │            │     Open-Meteo: exp 0.6/1.2/2.4s         │    │
  │  │            └─ else        → throw → bestEffort fallback│   │
  │  │  ✗ NO deadline around call → hang escapes all guards  │    │
  │  └──────────────────────────────────────────────────────┘    │
  └───────────────────────────┬───────────────────────────────────┘
            ════ HTTP boundary ╪══════════════════
                              ▼
          Overpass / Open-Meteo (transient 429/5xx, or silence)
```

## Elaborate

Retry-with-backoff is the oldest distributed-systems pattern there is (it predates the term — TCP itself backs off). The modern refinements flattr doesn't need yet: **jitter** (randomize the backoff so a fleet of clients doesn't synchronize — irrelevant with one client), **deadline propagation** (a top-level deadline that shrinks as it passes through layers, so a retry never outlives the user's patience — relevant the moment there's a request chain), and **circuit breakers** (stop calling a provider that's been failing, give it room to recover — relevant when one bad provider can starve others). The timeout gap is the one that bites *today*; the rest are `not yet exercised`. See sibling `study-networking` for the transport-level view of the same hang.

## Interview defense

**Q: "Walk me through your retry strategy and its weakness."**

```
  classify → backoff → budget → (missing) deadline

  429/5xx ──retryable──► sleep(backoff) ──► retry (≤ N)
  4xx     ──permanent──► throw
  silence ──?────────► HANGS  ← the weakness
```

"Both Overpass and Open-Meteo retry transient statuses with backoff — Overpass linear because it's a build script, Open-Meteo exponential and run-time-tuned to one retry so a throttled user gets a fast fallback instead of a long stall. The classifier is an explicit retryable-status set; non-retryable throws immediately. The weakness I'd fix first: no request timeout. `fetch` won't abort on its own, so a hung connection blocks the single-flight pump forever — it never reaches any of my retry guards because they only run *after* the response comes back. I'd wrap each call in an `AbortController` with a deadline and treat the abort as one more retryable failure."

**Anchor:** *Retries handle the failures the server announces; timeouts handle silence — and I'm only handling the first.*

**Q: "Why no jitter?"**
"Jitter prevents a *fleet* of clients from retrying in lockstep. flattr is one client, so there's no herd to thunder. I'd add it the moment this became a multi-user service — that's the trigger, not the absence of the line today."

**Anchor:** *Jitter is a fix for a problem one client can't have yet.*

## See also

- `01-distributed-system-map.md` — the boundary these calls cross.
- `04-consistency-models-and-staleness.md` — where `bestEffortElevation` catches the thrown failure and degrades.
- `06-queues-streams-ordering-and-backpressure.md` — the single-flight pump the hang would wedge.
- `09-distributed-systems-red-flags-audit.md` — the timeout gap ranked #1.
- sibling `study-networking` — DNS/TLS/connection-level view of the same hang.
