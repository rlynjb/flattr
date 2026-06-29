# 08 — Networking Red-Flags Audit

**Ranked protocol and network-failure risks** · *Project-specific audit*

## Zoom out, then zoom in

Every other file in this guide taught a mechanism. This one ranks what's *wrong or missing*, by consequence, with evidence. flattr's networking is small and mostly clean — three `fetch`-based APIs with sensible retry and a strong cache. The risks are concentrated: one is genuinely serious, the rest are low-to-medium polish items. No risk here is "this is broken"; the top one is "this fails badly under a failure mode that will eventually happen."

```
  Zoom out — where the risks live on the map

  ┌─ scheduler ──────────────────────────────────────────────┐
  │  single-flight gate  ←── ⚠ R1 jams here on a hang         │
  └────────────────────────┬──────────────────────────────────┘
  ┌─ resilience band ───────▼─────────────────────────────────┐
  │  retry+backoff  ←── ⚠ R2 no jitter, ⚠ R4 no Retry-After   │
  │  cache          ←── ⚠ R5 no integrity/version guard       │
  └────────────────────────┬──────────────────────────────────┘
  ┌─ UI ────────────────────▼─────────────────────────────────┐
  │  debounced geocode  ←── ⚠ R3 in-flight not cancelled       │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the audit answers *"where will flattr's networking hurt first, and what's the cheapest fix?"* Ranked by consequence × likelihood, with the verdict first on each.

## The ranked findings

```
  rank  finding                              severity   fix cost
  ────  ───────────────────────────────────  ─────────  ────────
  R1    no request timeout on any fetch      HIGH       low
  R2    no jitter on retry backoff           MEDIUM     low
  R3    in-flight geocode not cancelled      LOW-MED    low
  R4    Retry-After header ignored           LOW-MED    low
  R5    elev cache no integrity/version guard LOW       low
```

---

## R1 — No request timeout on any fetch (HIGH)

**Verdict:** the one serious risk. Every `fetch` in the codebase can hang indefinitely; at runtime a single hang jams the whole map-loading pipeline until the OS TCP timeout fires (minutes).

**Evidence.** Repo-wide search for `AbortController`, `AbortSignal`, and any `signal:` option returns nothing across `pipeline/`, `mobile/src/`, `lib/`, `features/`. The raw fetches:
- `pipeline/overpass.ts:33` — `await fetchImpl(endpoint, { method, headers, body })`, no signal
- `pipeline/elevation.ts:109` — `await fetchImpl(url)`, no signal
- `pipeline/geocode.ts:21,47,64` — no signal

**Why it bites.** Retries only trigger on a *returned* status (`overpass.ts:42`, `elevation.ts:114`). A connection that opens but never responds — a half-open socket, a hung server — never returns a status, so the retry loop never engages. The `await` just blocks.

```
  Failure trace — runtime hang jams the gate

  pump() → busyRef = true → await fetchOverpass(bbox)
                                  │ server accepts, never responds
                                  ▼
                            await blocks (no status, no retry)
                                  │
  busyRef STAYS true ─────────────┘
        │
        ▼ consequence
  every later pump() returns early ("if busyRef.current return")
  → no viewport loads, no route builds, loader stuck "Fetching streets"
  → recovers only when OS TCP timeout fires (minutes), then catch frees busyRef
```

At build time the symptom is milder (the script just stalls) but the same root cause.

**Fix.** Wrap each fetch in an `AbortController` with a 5–10s timeout; the abort throws, which the existing `catch`/retry already handles, and `busyRef` frees in the `finally`. Low cost, removes the jam entirely. Detailed comparison in `07` Move 2.

---

## R2 — No jitter on retry backoff (MEDIUM)

**Verdict:** the backoff curves are fixed-schedule, so synchronized retries can re-overload a recovering server (thundering herd). Partially mitigated by single-flight, not eliminated.

**Evidence.**
- `overpass.ts:44` — `sleep(delayMs * (attempt + 1))` — deterministic 2/4/6s
- `elevation.ts:115` — `sleep(delayMs * 2 ** (attempt + 1))` — deterministic .6/1.2/2.4s

No `Math.random()` anywhere in the delay computation.

**Why it bites.** If a provider returns `429` to many in-flight batches at once (build time, sequential batches that all start hitting quota), they all back off on the *identical* schedule and retry in sync, re-spiking the load right when the server is trying to recover.

```
  Comparison — fixed vs jittered backoff

  fixed (now):           batch1 ──2s──► retry ┐ all retry
                         batch2 ──2s──► retry ┤ at the SAME
                         batch3 ──2s──► retry ┘ instant → re-spike

  jittered (fix):        batch1 ──2.3s──► retry  spread out,
                         batch2 ──1.7s──► retry  no synchronized
                         batch3 ──2.9s──► retry  re-spike
```

**Mitigation already present.** The runtime single-flight gate (`useTileGraph.ts:166`) ensures only one build retries at a time, and the build-time batch loop is sequential — so the herd is small by construction. The risk is real but bounded.

**Fix.** `sleep(base * factor * (1 + Math.random()))`. One-line change per curve.

---

## R3 — In-flight geocode request not cancelled (LOW-MED)

**Verdict:** the autocomplete debounce cancels the *timer* but not an already-fired request, so a slow earlier suggestion can land after a newer one and show stale results.

**Evidence.** `MapScreen.tsx:73-89` — `scheduleSuggest` clears `suggestTimer` (the pending timer) but once `geocodeSuggest` is awaited (`MapScreen.tsx:82`), there's no `AbortController` to cancel it. If request A (slow) fires, then the user types more and request B fires and returns first, A can still resolve afterward and call `setSuggestions(A)`, overwriting B's fresher results.

```
  Sequence — last-write-wins goes wrong without cancellation

  type "pik"  → debounce → fire A (slow)
  type "pike" → debounce → fire B (fast)
  B resolves  → setSuggestions(B)   ✓ correct
  A resolves  → setSuggestions(A)   ✗ stale, overwrites B
```

**Why it's only LOW-MED.** It's a stale-suggestion flicker, not a correctness bug in routing. The 400ms debounce makes the overlap window small. Still a real out-of-order race.

**Fix.** Same `AbortController` from R1 — abort the previous suggest before firing a new one. Or track a request sequence number and ignore stale resolutions.

---

## R4 — Retry-After header ignored (LOW-MED)

**Verdict:** when a provider returns `429` *with* a `Retry-After` header telling flattr exactly how long to wait, flattr ignores it and uses its own backoff guess instead.

**Evidence.** The retry blocks (`overpass.ts:42-45`, `elevation.ts:114-117`) read only `res.status`, never `res.headers.get("Retry-After")`. The wait is always the computed backoff.

**Why it bites.** If the server says "wait 30s" and flattr's backoff says "wait 2s," flattr retries too early and eats another `429`, wasting a retry from its budget and adding load. Conversely if the server says "wait 1s" flattr over-waits.

**Why it's only LOW-MED.** Overpass and Open-Meteo don't reliably send `Retry-After` on their free tiers (provider-dependent), so the header is often absent anyway. *(Inference — flattr never inspects it, so whether the providers send it is unverified from the code.)* The cost is suboptimal retry timing, not failure.

**Fix.** `const wait = Number(res.headers.get("Retry-After")) * 1000 || computedBackoff;` — honor it when present, fall back when not.

---

## R5 — Elevation cache has no integrity or version guard on read (LOW)

**Verdict:** the persistent cache trusts whatever JSON it parses from AsyncStorage; a corrupt or schema-changed blob is partially absorbed but could feed bad elevations.

**Evidence.** `elevCache.ts:21-28` — `JSON.parse(raw)` inside a `try/catch`, and the catch handles a *parse* failure (corrupt JSON) gracefully. But if the JSON parses yet contains wrong-typed or stale-schema values (e.g. a future format change), they're loaded as-is into `mem` (`elevCache.ts:24`). The `STORAGE_KEY` is versioned (`flattr.elevCache.v1`, `elevCache.ts:7`), which is the right instinct, but there's no per-value validation.

**Why it's only LOW.** DEM elevation values never change (the comment at `elevCache.ts:3` is correct), the key is already versioned so a format bump can use `v2`, and a bad cached elevation only mis-colors a grade band — it doesn't break routing connectivity. The blast radius is cosmetic.

**Fix.** Validate value types on load (`typeof v === "number" && isFinite(v)`), skip bad entries. Cheap defense-in-depth.

---

## What's clean (the non-findings)

Worth stating, because an audit that only lists problems misleads:

```
  ✓ all HTTPS, no verification bypass        (04 — no rejectUnauthorized)
  ✓ User-Agent sent everywhere               (good free-tier citizenship)
  ✓ fetch injected everywhere for tests      (overpass/geocode/elevation)
  ✓ retry sets matched to each API's errors  (05 — per-module, deliberate)
  ✓ persistent cache + dedup = strong rate-  (07 — the real throttle defense)
    limit defense
  ✓ best-effort degradation + self-heal      (07 — graceful runtime failure)
  ✓ single-flight gate = real backpressure   (07 — collapses pan backlog)
```

## Primary diagram

The complete audit — risks placed on the request path, ranked.

```
  flattr networking audit — risks on the path

  user gesture
      │
      ▼ debounce ──── R3: in-flight not cancelled (stale suggest)
  single-flight gate ─ R1: HANGS here on a no-response fetch ⚠ HIGH
      │
      ▼ cache/dedup ── R5: no per-value integrity check (low)
      │
      ▼ retry+backoff ─ R2: no jitter (herd)  R4: ignores Retry-After
      │
      ▼ fetch ──── ⚠ R1 again: no AbortController = unbounded wait
      │
      ▼ degrade (best-effort + self-heal) ── clean
```

## Elaborate

The pattern across these findings: flattr handles the failures it *can see* (a returned `429`, a parse error) and is exposed to the failures that are *silent* (a hang, an out-of-order resolution, a header it never reads). That's a common maturity gap — you build for the errors you've observed in testing, and the silent ones show up only in production under real network conditions. The single highest-leverage move is R1: one `AbortController` pattern, applied to all five fetch sites, closes the worst risk and incidentally enables the fix for R3. For the AI-engineering pivot, carry this forward: LLM provider calls hang too (a stalled stream, a slow first token), and the same timeout discipline is the first thing to add.

## Interview defense

**Q: You've got 30 minutes to harden flattr's networking. What do you do?**
R1 first — wrap all five fetch sites in a shared `AbortController` helper with a 5–10s timeout. It closes the only HIGH risk (a hang jamming the single-flight gate, `useTileGraph.ts:166`), reuses the existing `catch`/retry path, and the same helper fixes R3 (cancel stale geocode suggestions). Then add jitter to the two backoff curves (R2). Everything else is polish. Anchor: *timeout first — it's the failure flattr can't currently see.*

**Q: What does flattr's networking get right?**
The rate-limit defense is genuinely good: persistent semantic-key cache + same-cell dedup + single-flight gate means revisited areas issue zero requests and rapid panning collapses to one build. Retry sets are matched per-API to real failure modes, all traffic is HTTPS with no verification bypass, and failure degrades gracefully (flat elevation + self-heal). The gaps are silent-failure handling, not architecture. Anchor: *strong on avoiding requests; weak on bounding the ones that hang.*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the mechanisms these findings critique, in depth
- `05-http-semantics-caching-and-cors.md` — the retry status sets and the cache design
- `.aipe/study-security/` — the trust-boundary view of these same outbound calls
- `.aipe/study-debugging-observability/` — how a hung request would (not) surface today
