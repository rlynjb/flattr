# Partial failure, timeouts, and retries
### deadlines, retries, backoff, and failure classification at the network boundary
**Industry name:** retry-with-backoff, failure classification, partial-failure handling · **Type:** Industry standard

## Zoom out, then zoom in

This is the load-bearing file in the whole guide, because partial failure is the one classic distributed problem flattr genuinely has. The boundary from `01` — your process vs. their APIs — is exactly where a call can succeed, fail permanently, or fail *transiently*, and telling those three apart is the entire game.

```
  Zoom out — where retry/backoff logic lives

  ┌─ Coordination layer (yours) ────────────────────────────────┐
  │  run-build.ts / useTileGraph.ts                             │
  │     calls ▼                                                 │
  │  ┌──────────────────────────────────────────────────────┐  │
  │  │ ★ retry loops ★                                       │  │ ← we are here
  │  │   pipeline/overpass.ts   (linear backoff, RETRYABLE)  │  │
  │  │   pipeline/elevation.ts  (exponential backoff, 429)   │  │
  │  └──────────────────────────────────────────────────────┘  │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK (failures originate below) ═══
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  Overpass: 429/502/503/504 under load                        │
  │  Open-Meteo: 429 when free-tier quota exhausted              │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"the remote didn't give me a clean 200 — now what?"* Three answers, and choosing wrong is a real bug each way: retry a permanent failure and you waste time and hammer a service; *don't* retry a transient one and you fail a build that would have worked two seconds later. The mechanism that picks correctly is **failure classification**, and the mechanism that retries without making things worse is **backoff**.

## Structure pass

**Layers.** Caller (`run-build`/`useTileGraph`) → retry loop (`fetchOverpass`, `openMeteoProvider.sample`) → raw `fetch()` → remote. The retry loop is the layer that turns a flaky transport into a call the caller can treat as "mostly reliable."

**The axis: failure containment — "where does a failure stop?"** Trace it up the stack:

```
  One question — "where does a failure get contained?" — traced upward

  ┌──────────────────────────────────────┐
  │ caller (run-build / pump)             │  → sees: success, or a thrown
  └──────────────────────────────────────┘    Error after all retries spent
      ▲ contained-or-rethrown
  ┌──────────────────────────────────────┐
  │ retry loop (RETRYABLE set + backoff)  │  → CONTAINS transient failures
  └──────────────────────────────────────┘    (429/5xx), RETHROWS permanent
      ▲ classify
  ┌──────────────────────────────────────┐
  │ raw fetch()                           │  → contains NOTHING: any status,
  └──────────────────────────────────────┘    any network error, passes up
```

**The seam.** The `RETRYABLE` set is the seam where a raw HTTP status becomes a *decision*. Above it, callers never see a 504 — they see either a value or a final Error. Below it, every status is just data. That classification boundary is the contract: "I will hide transient blips from you; I will not hide a 400."

## How it works

#### Move 1 — the mental model

You know this shape from any `fetch()` with a `.catch()` — except here the catch is smart: it asks *what kind* of failure before deciding to try again. The pattern is a loop with three exits.

```
  The retry kernel — a loop with three exits

         ┌─────────────────────────────────────┐
         │  attempt = 0                         │
         └──────────────┬──────────────────────┘
                        ▼
              ┌──── fetch() ────┐
              │                 │
        200 ok│        non-200 / error
              ▼                 ▼
         ┌────────┐   ┌──────────────────────────┐
         │ RETURN │   │ retryable AND attempts<n? │
         └────────┘   └────┬──────────────┬───────┘
            exit 1      yes│            no │
                           ▼               ▼
                    sleep(backoff)     ┌───────┐
                    attempt++          │ THROW │
                    └──► loop          └───────┘
                                        exit 3 (give up)
```

Three exits — success, retry, give-up — and the *only* interesting line is the middle condition: `retryable AND attempts < n`. Get that predicate right and the loop is correct.

#### Move 2 — the load-bearing skeleton

This concept has a kernel, so let's isolate it and name each part by what breaks when it's gone.

**Part 1 — the classifier (the `RETRYABLE` set).** Bridge from a `switch` on response status. A fixed set of statuses — `429, 502, 503, 504` — that mean "transient, try again." Everything else means "permanent, stop." *What breaks if removed:* without it you either retry everything (so a 400 Bad Request gets hammered 3 times before failing — wasted, and rude to the server) or retry nothing (so a one-off 503 fails a build that would've worked). The classifier is the load-bearing part people forget; the retry loop without it is worse than no retry.

```
  Failure classification — the table that drives the decision

  status        meaning                       decision
  ─────         ───────                       ────────
  200           success                       RETURN
  429           rate-limited (transient)      RETRY (back off)
  502/503/504   upstream busy (transient)     RETRY (back off)
  400/404/...   client error (permanent)      THROW now, don't retry
  network throw transport died                propagates (no catch here)
```

**Part 2 — the backoff (sleep between attempts).** Bridge from `setTimeout`. Before retrying, wait — and wait *longer* each time. *What breaks if removed:* retry with zero delay is a tight loop that turns one 429 into a self-inflicted DoS, making the rate-limit worse, not better. Two flavors in the repo:

```
  Two backoff curves — linear vs exponential

  attempt:        1       2       3
  ─────────       ─       ─       ─
  Overpass        2s      4s      6s      ← delayMs * (attempt+1)   [linear]
  Open-Meteo      0.6s    1.2s    2.4s    ← delayMs * 2**(attempt+1) [exponential]

  exponential backs off HARDER — chosen for Open-Meteo because a 429
  there means quota exhausted, and quota recovers slowly; hammering
  every 2s won't help. Linear is fine for Overpass's transient-load 5xx.
```

**Part 3 — the attempt budget (`attempts < retries`).** Bridge from a `for` loop bound. A hard cap on tries. *What breaks if removed:* an infinite retry loop against a permanently-down service — the build never returns, the phone spinner never stops. The budget is what guarantees *termination*. This is the same "hard iteration budget" you'd put on an agent loop: the part that guarantees you stop.

**Optional hardening — what's NOT in the kernel.** flattr does *not* add jitter (randomized backoff to avoid thundering-herd sync), per-attempt timeouts (it relies on `fetch`'s default + Overpass's `[timeout:60]` server-side directive), or a circuit breaker (trip-open after N failures to stop trying entirely). Those are real hardening layers — see Elaborate for when they'd matter — but they're not required for the pattern to be correct at one-client scale.

#### Move 2.5 — the deadline that lives on the *other* side

One subtlety worth flagging: flattr sets almost no client-side timeout, but the Overpass query embeds `[out:json][timeout:60]` (`pipeline/overpass.ts:10`). That's a *server-side* deadline — Overpass promises to kill its own query after 60s and return an error, which flattr then classifies. So the deadline exists; it's just enforced by the remote, not the client. The phone path adds its own impatience instead: `retries: 1` on elevation (`useTileGraph.ts:111`) so a doomed 429 backoff gives up fast rather than stalling the screen.

#### Move 3 — the principle

A retry without classification is a bug, and a retry without backoff is a weapon. The whole pattern reduces to: *decide if the failure is worth retrying, then retry in a way that doesn't make the failure worse, and always have a budget that guarantees you stop.* That predicate — `retryable AND attempts < n` — is the entire load-bearing surface; everything else is tuning.

## Primary diagram

The full retry mechanism, both call sites, in one frame.

```
  Partial-failure handling across both boundaries — recap

  ┌─ caller ──────────────────────────────────────────────────┐
  │  run-build.ts / useTileGraph.pump()                        │
  └───────┬─────────────────────────────────────┬─────────────┘
          │ fetchOverpass(bbox)                  │ provider.sample(pts)
  ┌───────▼──────────────────┐         ┌─────────▼──────────────┐
  │ overpass.ts retry loop    │         │ elevation.ts retry loop│
  │  RETRYABLE={429,502,      │         │  status===429 only     │
  │            503,504}       │         │  backoff = 2**n         │
  │  backoff = delayMs*(n+1)  │         │  budget = retries (3)   │
  │  budget = retries (3)     │         │                        │
  └───────┬──────────────┬────┘         └────┬───────────────┬───┘
     ok   │       give up│              ok    │        give up │
          ▼              ▼                    ▼               ▼
       RETURN          THROW ──────┐       RETURN           THROW
                       ═══ NETWORK │═══                       │
          ┌────────────────────────▼──┐         ┌─────────────▼────────┐
          │ Overpass (429/5xx)         │         │ Open-Meteo (429)     │
          └────────────────────────────┘         └──────────────────────┘
```

## Implementation in codebase

**Use cases.** Both retry loops fire on every real graph build. Build-time: `run-build.ts` calls `fetchOverpass(BBOX)` once and `openMeteoProvider().sample()` once per build, both with default retries=3. Runtime: every map pan/route through `useTileGraph.pump()` does the same, but with elevation `retries: 1` for impatience. The Overpass retry path is directly tested at `pipeline/overpass.test.ts:37-55`.

The Overpass classifier + linear backoff:

```
  pipeline/overpass.ts  (lines 18, 32–47)

  const RETRYABLE = new Set([429, 502, 503, 504]);     ← the classifier (Part 1)

  for (let attempt = 0; ; attempt++) {                 ← unbounded loop; budget is inside
    const res = await fetchImpl(endpoint, { ... });
    if (res.ok) return (await res.json());             ← exit 1: success
    if (RETRYABLE.has(res.status) && attempt < retries) {  ← the load-bearing predicate
      await sleep(delayMs * (attempt + 1));            ← exit 2: linear backoff, retry
      continue;
    }
    throw new Error(`Overpass request failed: ${res.status}`); ← exit 3: give up / permanent
  }
       │
       └─ drop `RETRYABLE.has(res.status)` and a 400 retries 3× then fails anyway
          (waste). Drop `attempt < retries` and a persistent 429 loops forever
          (never terminates). Both clauses are load-bearing.
```

The Open-Meteo classifier + exponential backoff:

```
  pipeline/elevation.ts  (lines 96–119, openMeteoProvider.sample)

  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url);
    if (res.ok) { json = await res.json(); break; }    ← success
    if (res.status === 429 && attempt < retries) {     ← ONLY 429 is retryable here
      await sleep(delayMs * 2 ** (attempt + 1));        ← exponential: 2,4,8× delayMs
      continue;
    }
    throw new Error(`Open-Meteo elevation: ${res.status}`); ← any non-429, or budget spent
  }
       │
       └─ note the narrower classifier: only 429 retries, because that's the
          documented failure mode (quota). A 500 here throws immediately —
          retrying a server error on a free DEM isn't worth the wait.
```

Note the test at `pipeline/overpass.test.ts:49-55` asserts `toHaveBeenCalledTimes(3)` for `retries: 2` — proving the budget is "initial + N retries," the exact off-by-one that bites people writing these loops.

## Elaborate

Retry-with-backoff-and-classification is the oldest pattern in distributed systems and the one most often done wrong. The canonical hardening flattr omits, and when you'd add each:

- **Jitter** — randomize the backoff (`delay * random(0.5, 1.5)`). Pointless with one client (there's no herd to de-synchronize), essential the moment many clients retry the same downstream in lockstep after an outage. Add it when flattr becomes server-side (§11 D2) with many instances.
- **Per-attempt timeout** — `AbortController` with a deadline so a *hung* (never-responding) connection doesn't block the budget forever. flattr leans on Overpass's server-side `[timeout:60]` and `fetch` defaults instead; a hung TCP connection with no client timeout is the real gap here (see `09`).
- **Circuit breaker** — after N consecutive failures, stop trying for a cooldown window. Overkill for a one-shot build; valuable on the phone where repeated doomed Overpass calls during an outage waste battery. The `bestEffortElevation` degrade (`03`/`04`) is a poor-man's version: it fails *fast* to flat rather than tripping a breaker.

Read next: `03` (why these naive retries are *safe* — idempotency) and `06` (the `pump()` gate that ensures only one of these loops runs at a time).

## Interview defense

**Q: "Walk me through your retry strategy. What makes it correct?"**
Three parts, and I'll name the one people forget. First, a classifier — a `RETRYABLE` set of `429/502/503/504` — so I only retry transient failures and throw permanent ones (a 400) immediately. Second, backoff — linear for Overpass's load 5xx, exponential for Open-Meteo's 429 because quota recovers slowly. Third, and this is the load-bearing part: a hard attempt budget, so a permanently-down service makes the loop *terminate* instead of spinning forever. The predicate `retryable && attempt < retries` is the whole thing.

```
   non-200 ──► retryable? ──no──► THROW (don't waste retries on a 400)
                  │yes
                  ▼
             attempt<budget? ──no──► THROW (guarantees termination)
                  │yes
                  ▼
             sleep(backoff) ; retry
```
*Anchor: classify, back off, budget — the budget is what guarantees you stop.*

**Q: "Why exponential for one API and linear for the other?"**
Different failure semantics. Overpass 5xx is transient load — it clears in seconds, so linear (2s/4s/6s) recovers fast. Open-Meteo 429 is quota exhaustion that recovers slowly — exponential (0.6/1.2/2.4s) stops me from pointlessly hammering a quota that won't refill on a 2s cadence. Matching the backoff curve to the recovery curve is the judgment call. *Anchor: back off as fast as the remote recovers, not faster.*

## Validate

1. **Reconstruct:** write the retry kernel from memory — three exits, the predicate, the budget. Which single line guarantees termination?
2. **Explain:** why does `pipeline/elevation.ts:114` retry *only* 429 while `pipeline/overpass.ts:18` retries four statuses? What does each remote's failure mode justify?
3. **Apply:** Overpass returns 400 (malformed query). Trace `pipeline/overpass.ts:42-46`. How many times does `fetchImpl` get called, and why is that correct?
4. **Defend:** a reviewer says "add jitter to the backoff." Argue why it earns nothing at flattr's current scale and exactly what change (§11 D2) would make it necessary.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — why retrying these reads is *safe* (no double-apply).
- `04-consistency-models-and-staleness.md` — what `bestEffortElevation` does when retries are exhausted: degrade, don't fail.
- `06-queues-streams-ordering-and-backpressure.md` — the `pump()` gate that serializes these loops.
- `.aipe/study-networking/07-timeouts-retries-pooling-and-backpressure.md` — the same loops from the transport side.
- `.aipe/study-runtime-systems/` — `sleep`/`await` as event-loop mechanics.
