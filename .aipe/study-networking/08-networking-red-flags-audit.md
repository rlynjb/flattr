# 08 — Networking red-flags audit
### ranked protocol and network-failure risks grounded in the repo
**Industry name:** network resilience audit — *Project-specific*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

This file is the ranked risk register — every networking weakness in the repo, ordered by *consequence*, each grounded in a real `file:line` and paired with the move that fixes it. It's the verdict-first summary the other seven files build toward.

```
  Zoom out — where each red flag lives

  ┌─ Pre-request (avoid) ────────────────────────────┐
  │  FLAG 4: no mirror rotation (pinned host)        │
  └─────────────────────────┬─────────────────────────┘
  ┌─ In-request (recover) ───▼────────────────────────┐
  │  ★ FLAG 1: NO TIMEOUT ★  FLAG 2: inconsistent     │ ← top risks
  │  retry policy  FLAG 5: unchecked .json()           │
  └─────────────────────────┬─────────────────────────┘
  ┌─ Cross-request (cap) ────▼────────────────────────┐
  │  FLAG 3: busy-lock + no timeout = wedge risk      │
  └─────────────────────────┬─────────────────────────┘
  ┌─ Secrets-adjacent ───────▼────────────────────────┐
  │  FLAG 6: API key in query string                  │
  └────────────────────────────────────────────────────┘
```

Zoom in: not all of these are equally dangerous. The ranking is by blast radius — what actually breaks for a user, how likely, how hard to fix.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** Same four resilience layers from `07` — avoid / recover / cap / degrade — plus a secrets-adjacent concern that crosses into `.aipe/study-security/`.

**Axis — consequence (what does a user actually lose?).** The ranking *is* the axis traced across every flag:

```
  Axis "what does the user lose?" — ranked by consequence

  FLAG 1 (no timeout)      → app WEDGES, silent, unrecoverable  ████ worst
  FLAG 2 (retry incons.)   → unpredictable recovery, geocode fails ███
  FLAG 3 (lock + hang)     → runtime tile-loading dies after 1 hang ███
  FLAG 4 (no mirror rot.)  → build/coverage dies if 1 host down   ██
  FLAG 5 (unchecked json)  → cryptic crash on HTML error page     ██
  FLAG 6 (key in query)    → key leaks to logs (not the wire)     █  (non-default)
```

**Seams.** The audit's seam is the test seam — every provider module injects `fetchImpl`, so all of these can be reproduced and regression-tested without hitting the network (`pipeline/overpass.test.ts`, `pipeline/elevation.test.ts`). The fixes are testable today.

═════════════════════════════════════════════════
HOW IT WORKS — the ranked register
═════════════════════════════════════════════════

#### Move 1 — the shape of the risk surface

You know how a code review sorts findings by severity, not by file order? This is that, for the wire. The pattern: each flag is `(consequence, likelihood, fix-cost)`, and the ranking weights consequence first.

```
  Pattern — each flag is a triple, ranked by consequence

   flag = { consequence: how bad for the user
            likelihood:  how often it fires
            fix-cost:    lines to fix }
   rank by consequence DESC, break ties by likelihood
```

#### Move 2 — the flags, ranked

---

**FLAG 1 — No client-side timeout on any request. `★ highest consequence ★`**

*Evidence:* No `fetch` call in the repo passes an `AbortSignal` or deadline — `pipeline/overpass.ts:33`, `pipeline/elevation.ts:75` & `:109`, `pipeline/geocode.ts:21` & `:47` & `:64`. The Overpass QL has a *server-side* `[timeout:60]` (`pipeline/overpass.ts:10`), which does not bound the client.

*Consequence:* If a provider accepts the TCP connection but never responds (half-open / black-hole), `await fetch` hangs for the OS default (minutes). At build time the CLI stalls. At runtime it's worse — see FLAG 3.

*Fix:* Add `signal: AbortSignal.timeout(ms)` to every `fetch`, and treat the resulting abort as a retryable failure in the retry loops. ~1 line per call site plus a retry-condition tweak.

```
  Comparison — today vs fixed

  TODAY:  await fetch(url)                  ← hangs forever on a black-hole
  FIXED:  await fetch(url,
            { signal: AbortSignal.timeout(8000) })  ← bounded, then retry
```

---

**FLAG 2 — Inconsistent retry policy across providers.**

*Evidence:* Three different policies. Overpass retries `{429,502,503,504}` with *linear* backoff (`pipeline/overpass.ts:18`, `:43`). Open-Meteo retries *only* `429` with *exponential* backoff (`pipeline/elevation.ts:114-115`). Nominatim retries *nothing* — one shot, throw (`pipeline/geocode.ts:24`, `:50`, `:67`).

*Consequence:* Unpredictable behavior; a reader can't reason about recovery without reading each module. Concretely, a transient Nominatim 503 fails a geocode that Overpass/Open-Meteo would have retried — the user sees "From not found" (`mobile/src/MapScreen.tsx:176`) for a blip that a retry would have survived.

*Fix:* Extract one `fetchWithRetry(url, init, { retryable, backoff, retries, jitter })` helper and use it for all three providers. Unify on exponential-with-jitter.

```
  Policy table — the inconsistency

  Overpass    {429,5xx}  linear      retries 3
  Open-Meteo  {429}      exponential retries 3 (build) / 1 (runtime)
  Nominatim   none       —           retries 0   ← the outlier that bites
```

---

**FLAG 3 — Busy-lock + no timeout = a single hang wedges runtime tile loading.**

*Evidence:* `useTileGraph` caps builds at one in-flight via `busyRef` and only clears it in a `finally` (`mobile/src/useTileGraph.ts:104`, `:124-126`). Combined with FLAG 1 (no timeout), a hung `fetchOverpass` never reaches the `finally`.

*Consequence:* `busyRef.current` stays `true` forever; every subsequent pan or route early-returns at `if (busyRef.current) return` (`:90`). Tile loading silently dies for the session — no error, no recovery, no crash.

*Fix:* FLAG 1's timeout fixes this transitively (the abort reaches `finally`, clears the lock). Belt-and-suspenders: a watchdog that force-clears `busyRef` after a max build duration.

```
  State — the wedge

  busy=true ──fetch hangs (no timeout)──► finally never runs
       │                                       │
       └── busyRef stuck true ◄────────────────┘
              │
              └─ every later pump() hits `if (busy) return` → dead
```

---

**FLAG 4 — Single pinned host per provider, no mirror rotation.**

*Evidence:* One hardcoded hostname each (`pipeline/overpass.ts:4`, `pipeline/geocode.ts:5`). Retry re-issues to the *same* host (`pipeline/overpass.ts:32-45`).

*Consequence:* If `overpass-api.de` is down or blocks flattr's User-Agent, the build fails outright and runtime coverage can't extend — retrying the same dead host doesn't help. Overpass specifically runs multiple public mirrors, so this is a real, avoidable single point of failure.

*Fix:* A host list + rotate-on-failure in the retry loop (try mirror B when mirror A gives a retryable error). Addressing-layer change, not transport.

---

**FLAG 5 — Unchecked `res.json()` assumes well-formed JSON.**

*Evidence:* Every module does `await res.json()` and uses the shape directly, no try/catch, no schema check (`pipeline/overpass.ts:41`, `pipeline/elevation.ts:111`, `pipeline/geocode.ts:25`).

*Consequence:* Overpass mirrors sometimes return HTTP 200 with an HTML error/"too busy" page under load. `.json()` throws a parse error (not a clean status error), which surfaces as a cryptic exception rather than a recognizable "provider busy" signal. It *is* caught upstream (the retry loop's caller or `useTileGraph`'s catch), so it degrades rather than crashes — but the error is misleading.

*Fix:* Check `Content-Type: application/json` before parsing, or wrap `.json()` and map a parse failure onto the retryable-failure path (so a busy-page 200 retries like a 503).

---

**FLAG 6 — Google Elevation API key in the URL query string. `(non-default provider)`**

*Evidence:* `pipeline/elevation.ts:72` — `&key=${apiKey}` in the URL.

*Consequence:* On the wire it's safe — HTTPS encrypts the full request (`04`). The risk is *off* the wire: query-string secrets leak into provider server logs, proxy logs, and any monitoring that records full URLs. Lower priority because Google is the non-default provider (Open-Meteo is default and keyless), so this path is rarely exercised.

*Fix:* If Google ever becomes primary, move the key to a header where the API supports it, and keep it out of any URL that gets logged. Cross-ref `.aipe/study-security/` for secrets handling.

#### Move 3 — the principle

Rank by consequence, not by how clever the fix is. The single timeout (FLAG 1) is one line per call site and fixes the worst failure mode *plus* FLAG 3 transitively — that's the highest-leverage networking change in the entire repo. Everything below it (consistency, mirror rotation, parse hardening) is real but secondary. A risk register that sorts by blast radius tells you what to do Monday morning.

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The full ranked register in one frame.

```
  flattr networking red flags — ranked by consequence

  RANK  FLAG                      EVIDENCE                  FIX
  ────  ────────────────────────  ────────────────────────  ──────────────
   1    no client timeout         overpass.ts:33,           AbortSignal.
        (app wedges)              elevation.ts:75,109,      timeout on every
                                  geocode.ts:21,47,64       fetch + retry it
   2    inconsistent retry        overpass.ts:18, elevation one fetchWithRetry
        (geocode fails on blip)   .ts:114, geocode.ts:24    helper, unify
   3    lock + hang = wedge       useTileGraph.ts:90,104,   fixed by #1
        (runtime tiles die)       124-126                   (+ watchdog)
   4    pinned host, no rotation  overpass.ts:4,            host list +
        (1 dead host = no build)  geocode.ts:5              rotate on fail
   5    unchecked res.json()      overpass.ts:41,           check Content-Type
        (cryptic crash on HTML)   elevation.ts:111          / map to retry
   6    key in query string       elevation.ts:72           header (if Google
        (logs, not wire)          (non-default)             becomes primary)
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** This audit is reached for in a code review, a reliability pass, or when prepping to widen the bbox / promote Google to primary (both of which raise request volume and thus the stakes on FLAGS 1–4).

**The clearest reproduction of FLAG 1+3** — `mobile/src/useTileGraph.ts` (lines 104-127):

```
  mobile/src/useTileGraph.ts  (lines 104-127)

  busyRef.current = true;                  ← lock acquired
  (async () => {
    try {
      const osm = await fetchOverpass(bbox); ← FLAG 1: no timeout → can hang
      ...
    } catch { /* keep last region */ }
    finally {
      busyRef.current = false;             ← FLAG 3: only cleared HERE…
      pump();
    }
  })();
        │
        └─ if fetchOverpass hangs (FLAG 1), control never reaches finally,
           busyRef stays true, and `if (busyRef.current) return` (line 90)
           kills every future pan/route. One hang = dead tile loading.
```

**The test seam that makes every fix verifiable** — `pipeline/overpass.test.ts` (lines 49-54):

```
  pipeline/overpass.test.ts  (lines 49-54)

  const fakeFetch = vi.fn(async () => new Response("rate", { status: 429 }));
  await expect(
    fetchOverpass(bbox, "https://example/api",
      fakeFetch as ..., { retries: 2, delayMs: 0 })  ← inject fake fetch
  ).rejects.toThrow(/429/);
  expect(fakeFetch).toHaveBeenCalledTimes(3);        ← initial + 2 retries
        │
        └─ the injectable fetchImpl means a timeout test (FLAG 1) can simulate
           a never-resolving fetch and assert the abort fires — no network.
           Every fix in this audit is regression-testable through this seam
```

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

The honest framing: flattr's networking is *better than typical hobby code* — it has real retry/backoff, request collapsing, a concurrency cap, and graceful degradation, all motivated by a documented free-tier rate limit (`.aipe/project/context.md`). The gaps are the *last mile* of resilience (timeout, jitter, consistency), and they cluster around one root cause — taking the platform `fetch` defaults without bounding them. The timeout is the keystone: it's the cheapest fix and it unblocks the worst failure mode. If you do one networking thing to this repo, add `AbortSignal.timeout` everywhere. The general theory behind these flags — overload control, retryable-vs-permanent failures, partial failure — lives in `.aipe/study-distributed-systems/`; whether the boundaries are *safe* (FLAG 6) lives in `.aipe/study-security/`.

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "If I gave you an hour to harden this app's networking, what would you do?"**

Answer: "Add `AbortSignal.timeout` to every `fetch`, and make the abort a retryable condition. That single change fixes the worst bug — no client timeout means a hung connection hangs forever — *and* it fixes a runtime-specific failure where that hang holds the single-build concurrency lock and silently kills all tile loading for the session. After that, I'd extract one `fetchWithRetry` helper to kill the three-different-policies inconsistency and add jitter. Mirror rotation and parse-hardening are real but secondary."

```
  hour 1: AbortSignal.timeout everywhere → fixes #1 AND #3
  then:   one fetchWithRetry helper + jitter → fixes #2
  later:  mirror rotation (#4), parse guard (#5)
```

Anchor: *the timeout is the keystone — one line per call site, fixes the worst failure plus the wedge transitively.*

**Q: "What's the most dangerous line of networking code in this repo?"**

Answer: "`await fetchOverpass(bbox)` inside `useTileGraph`'s build, because it has no timeout *and* sits inside a concurrency lock that only clears in a `finally`. A hung connection means the `finally` never runs, `busyRef` stays true, and every future pan or route silently no-ops. It's worse than a crash because there's no error and no recovery — the app just quietly stops loading tiles."

Anchor: *no timeout + a lock that clears only in finally = one stuck call wedges the whole runtime path.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** List the six flags from memory in consequence order, with the one-line fix for each.
2. **Explain:** Why does FLAG 1 (no timeout) make FLAG 3 (the lock wedge) possible? Trace `mobile/src/useTileGraph.ts:90, 104, 124`.
3. **Apply:** You promote Google Elevation to the default provider and widen the bbox 10×. Which flags get more dangerous, and in what order would you fix them now?
4. **Defend:** Someone says "just add a circuit breaker." Argue why the timeout (FLAG 1) is higher-leverage than a circuit breaker for *this* repo.

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `07-timeouts-retries-pooling-and-backpressure.md` — the resilience mechanisms these flags are gaps in.
- `05-http-semantics-caching-and-cors.md` — the status codes behind the retry inconsistency.
- `02-dns-routing-and-addressing.md` — the pinned-host single point of failure (FLAG 4).
- `.aipe/study-distributed-systems/` — overload, partial failure, circuit breaking.
- `.aipe/study-security/` — the API-key-in-query secrets concern (FLAG 6).
