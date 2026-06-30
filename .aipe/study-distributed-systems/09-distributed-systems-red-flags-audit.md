# 09 — Distributed Systems Red-Flags Audit

**Industry names:** failure-mode audit / reliability review / production-readiness
checklist. **Type:** Industry standard.

> Ranked by consequence, grounded in real `file:line` evidence. flattr's distributed
> surface is one seam (`01`) — client/build ⇄ three free APIs — so this audit is
> deep on that seam and honest about everything beyond it being `not yet exercised`.
> Strengths are ranked alongside risks, because "what's done right" is as much a part
> of a review as "what's wrong."

## Zoom out, then zoom in

You know how a code review sorts comments into "blocking," "should fix," and "nit"?
A red-flags audit does that for failure modes — but ranked by *blast radius under
partial failure*, not by code cleanliness. The question is never "is this pretty,"
it's "when the third party is slow / down / throttling, what does this do to the
user?"

```
  Zoom out — where each red flag lives on the one seam

  ┌─ Client / Build (you own) ────────────────────────────────────┐
  │  fetchOverpass ──┐  openMeteoProvider ──┐  geocode ──┐         │
  │  retry, NO timeout│  backoff, NO timeout │  NO retry  │        │ ← findings
  │       ▼           │       ▼              │  NO timeout│          live here
  │  single-flight pump (one worker — hung call freezes all)       │
  └───────────────────────┬───────────────────────────────────────┘
                          │  HTTP
                          ▼
  ┌─ Third-party fleet (slow / 429 / down) ───────────────────────┐
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the audit ranks six findings on this seam (three risks, three strengths)
plus the `not yet exercised` frontier. Verdict-first per finding: the call, then the
evidence, then the fix or the trigger.

## The structure pass

**Axis — every finding is ranked on one axis: `blast radius under partial failure`.**
Hold that question constant and the ranking falls out.

```
  One axis — "when a third party misbehaves, how far does the damage spread?" 

  widest blast radius ◄──────────────────────────────────► narrowest
  ① hung call freezes ALL loading   ④ self-heal cap   ⑥ cache poisoning (prevented)
  ② retry has no time budget        (bounded outage)
  ③ geocode has no retry at all
  ───────────────────────────────────────────────────────────────────
  strengths ride the SAME axis: ③graceful-degrade, ⑤single-flight,
  ⑥cache-only-real keep the blast radius SMALL — that's why they're strengths.
```

**Seam.** The load-bearing finding sits at the same seam every other file pointed
to: the un-timed `await fetchImpl(...)`. Findings ①②③ are all facets of that one
missing primitive; ④⑤⑥ are the defenses that already contain the seam well.

## How it works — the ranked findings

### ① NO client-side timeout on any fetch — RISK, highest blast radius

**Verdict:** the single highest-value distributed-systems fix in the repo. A remote
node that accepts the socket then goes silent hangs the call indefinitely; the
single-flight pump (`06`) means one hung call freezes *all* tile loading.

```
  evidence — every remote await is un-timed (verified by grep: no AbortController,
  no signal, no Promise.race anywhere in pipeline/ mobile/ features/)

  overpass.ts:33     await fetchImpl(endpoint, {…})   ← no signal
  elevation.ts:109   await fetchImpl(url)             ← no signal
  geocode.ts:21      await fetchImpl(`${ENDPOINT}…`)  ← no signal
  ── note: overpass.ts:10 `[out:json][timeout:60]` is Overpass QL (server-side),
     does NOT bound your socket.
```

**Blast radius:** TCP's own timeout is minutes; a black-holed connection stalls a
build for minutes, and the one-worker pump (`useTileGraph.ts:167`) holds `busyRef`
true the whole time → *every* pan and route is blocked behind it.
**Fix:** one wrapper — `AbortController` + `setTimeout(() => c.abort(), DEADLINE)`
passed as `signal` to every `fetchImpl`. The hung call then *throws*, which the
existing retry loops (`02`) already classify and retry. Small change, removes the
worst failure mode. → full walk in `02`.

### ② Retry budget bounds attempts, not wall-clock time — RISK

**Verdict:** correct as far as it goes, incomplete without ①. The retry loops bound
the *number* of attempts but not total time, so they can't rescue you from a hang
(②'s symptom is ①'s cause).

```
  evidence
  overpass.ts:42    attempt < retries        ← count bound (3), no deadline
  elevation.ts:114  attempt < retries        ← count bound (3), no deadline
  ── a count bound never fires if a single attempt never returns.
```

**Fix:** ① supplies the missing time bound; with per-attempt timeouts, the count
bound becomes sufficient. Secondary: Overpass backoff is linear with **no jitter**
(`overpass.ts:44`) — harmless at one client, a thundering-herd risk the day flattr
is a multi-client server. → `02`.

### ③ Geocode has no retry and no timeout — RISK, narrow

**Verdict:** the geocode paths are the *least* defended of the three APIs — a single
un-retried, un-timed call that throws on any non-200.

```
  evidence
  geocode.ts:21-24   single fetch, `if (!res.ok) throw` — no retry loop at all
  geocode.ts:47-50   geocodeSuggest — same, no retry
  geocode.ts:65-67   reverseGeocode — same, no retry
  ── contrast: overpass.ts + elevation.ts BOTH retry; geocode does not.
```

**Blast radius:** narrow — a failed geocode fails one address lookup (the user
re-types), it doesn't freeze the app or corrupt data. **Fix:** wrap in the same
retry+timeout pattern as Overpass; lower priority than ① because the blast radius is
one user action, not the whole loader. Note Nominatim's "~1 req/sec" policy
(`geocode.ts:2`) means any retry here *must* carry backoff.

### ④ Self-heal retry is capped — STRENGTH

**Verdict:** done right. Degraded regions self-heal toward real grades, but the
retry is bounded so a sustained outage doesn't loop forever.

```
  evidence
  useTileGraph.ts:209  if (degraded && retryCountRef.current < MAX_RETRIES)  ← cap 6
  useTileGraph.ts:71   RETRY_MS = 12000   ← paced, not a tight loop
  useTileGraph.ts:238  retryCountRef.current = 0  ← a fresh area resets the budget
```

This is eventual local consistency with a circuit-breaker-like cap. The one gap: it
caps *count* (6 retries), not *time* — same shape as ②, but low-consequence here
because each retry is silent and 12s apart. → `04`.

### ⑤ Single-flight pump as backpressure — STRENGTH

**Verdict:** the right primitive, hand-rolled. One build at a time, corridor
prioritized, keeps flattr under the free-tier rate limits without a broker.

```
  evidence
  useTileGraph.ts:167  if (busyRef.current) return       ← one-worker gate
  useTileGraph.ts:170-180  corridor drains before view   ← priority
  useTileGraph.ts:224  pump() in finally                 ← self-drain
```

The caveat is the flip side of ①: one worker means one hung call (no timeout)
freezes everything — strength and blast-radius amplifier are the same mechanism. →
`06`.

### ⑥ Cache stores only real values; degradation is honest — STRENGTH

**Verdict:** the subtle correctness win. Flat-fallback zeros never poison the cache,
and the `degraded` flag keeps available-but-wrong data from masquerading as fresh.

```
  evidence
  useTileGraph.ts:52-58  putElev only on successful fetch (throw skips the writes)
  useTileGraph.ts:190-195 bestEffort wraps cache → 0s produced OUTSIDE, never cached
  useTileGraph.ts:150-162 displayGraph EXCLUDES degraded → no fake-green over real
  elevCache.ts:36        putElev: if has(key) return → idempotent write
```

This is dedup + consistency done correctly: only cache values you'd serve forever
(`03`), mark stale data and hide it where it'd mislead (`04`).

## Primary diagram — the audit at a glance

```
  flattr distributed red-flags, ranked by blast radius

  RISKS (fix these)                          evidence            → file
  ① no client timeout    freezes ALL loading  overpass/elev/geocode  02,06
  ② retry: count not time  can't rescue hang   *.ts:42/114            02
  ③ geocode: no retry      one lookup fails    geocode.ts:21          02

  STRENGTHS (keep these)
  ④ self-heal capped       bounded outage      useTileGraph:209       04
  ⑤ single-flight pump     under rate limit    useTileGraph:167       06
  ⑥ cache only real +      no poison, honest   useTileGraph:52,150    03,04
    degraded flag          staleness

  NOT YET EXERCISED (trigger named)
  replication/quorum(05) · clocks/leases(07) · sagas/outbox(08)
  → trigger: a shared server / multi-device sync / cross-service write
```

## Elaborate

A production-readiness audit ranks by what hurts users under failure, not by code
aesthetics — and the highest-value finding here (① no timeout) is invisible in local
testing because the "silent server" case never happens on localhost. That's the
recurring trap: the worst distributed-systems bugs live in the failure modes you
can't reproduce on your machine. flattr's strengths (④⑤⑥) are notably *more* mature
than its one real gap is severe — graceful degradation, honest staleness marking,
and dedup-without-poisoning are things many production codebases get wrong. The
single fix that closes the gap (an `AbortController` wrapper) is also the one that
unlocks everything else: it turns hangs into the retryable failures the existing
machinery already handles.

## Interview defense

**Q: "If you had one day to harden this app's reliability, what would you do?"**
Verdict first: "Add a client-side timeout to every fetch — one `AbortController`
plus an `abort()` on a `setTimeout`, passed as `signal`. Right now no remote call
has a time bound, so a silent server hangs the call, and because there's a single
build worker, that one hang freezes *all* tile loading. The fix is small and it
converts hangs into the retryable failures the existing retry loops already handle.
Second, give geocode the retry+timeout the other two APIs have." Naming the
*interaction* (no timeout × single worker = total freeze) is the senior signal.

```
  the sketch you draw

  one day → AbortController on every fetch
            hung call ─► aborts ─► throws ─► existing retry catches it
            (and the single-worker freeze goes away)
```

**Q: "What's already good here?"**
"Three things most codebases miss: graceful degradation (elevation 429 → flat grades
so the app stays up), honest staleness (the `degraded` flag hides wrong data from
the heatmap while keeping it for routing connectivity), and a single-flight pump
that gives free-tier-safe backpressure without a broker. The reliability *posture*
is good; it's missing exactly one primitive — the timeout." Praising specifically,
with evidence, shows you actually read it.

**Anchor:** *One seam, one missing primitive — no client-side timeout — and because
there's a single build worker, that one gap freezes everything; the strengths
(degrade, mark, single-flight) are more mature than the gap is severe.*

## See also

- `02` — the timeout/retry walk behind findings ①②③.
- `03` — the cache-only-real correctness behind ⑥.
- `04` — the degraded-flag honesty behind ⑥.
- `06` — the single-worker blast radius behind ① and ⑤.
- `00` — the same ranked findings in the overview.
- siblings **debugging-observability** (the `degraded`/`loadingStep` surface),
  **networking** (where the timeout sits in transport), **performance-engineering**
  (backoff/debounce as budgets).
