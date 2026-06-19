# Distributed systems red-flags audit
### ranked coordination & partial-failure risks, grounded in the repo
**Industry name:** failure-mode audit, distributed red-flags review · **Type:** Project-specific

## Zoom out, then zoom in

This is the consequence-ranked risk register for everything the rest of the guide taught. Verdict first: **flattr's distributed surface is small and mostly handled well** — the retry/backoff/degradation story is solid. The real risks are narrow: a couple of genuine gaps at the client⇄API boundary (no client-side timeout on a *hung* connection; a graph build that can render a confusingly empty screen), and a set of `not yet exercised` topics that are correctly absent today but are the things to design for *before* shipping §11 D2/E2.

```
  Zoom out — where each risk lives

  ┌─ Coordination layer (yours) ────────────────────────────────┐
  │  pump() ─ R3 (silent build drop)                            │
  │  bestEffortElevation ─ (handled: degrade) ─ R4 (silent)     │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK ═══
  │  fetchOverpass / sample ─ R1 (no hung-connection timeout)   │ ← biggest real risk
  │  geocode ─ R2 (no retry, throws to UI)                      │
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  Overpass / Open-Meteo / Nominatim — uncontrolled remotes    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a red-flag audit ranks by *consequence × likelihood*, names the evidence (`file:line`), and says what to do. Below, real risks first (ranked), then the `not yet exercised` topics as *design-ahead* flags, then a one-line verdict on each lens the spec asked me to check.

## Structure pass

**The axis: failure consequence — "if this goes wrong, how bad and how likely?"** Three bands:

```
  Risks ranked by consequence × likelihood

  ┌─ REAL & worth fixing ──────────────────────────────────────┐
  │  R1 no client timeout on a HUNG remote   (med×med)          │
  │  R2 geocode has no retry, throws to UI    (low×med)         │
  │  R3 a failed build is silently dropped    (low×med)         │
  │  R4 degrade-to-flat is invisible to user  (low×high)        │
  └──────────────────────────────────────────────────────────────┘
  ┌─ HANDLED WELL (no action) ─────────────────────────────────┐
  │  retry+classify (overpass) · backoff (elev) · dedup ·        │
  │  single-flight+priority · best-effort degrade · idempotent   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ `not yet exercised` (design-ahead, not bugs) ─────────────┐
  │  replication · consensus · clocks · sagas · durable queue    │
  └──────────────────────────────────────────────────────────────┘
```

**The seam.** Every real risk sits at the network boundary or just inside it — which confirms `01`'s thesis: in a single-process system, *all* distributed risk concentrates at the one seam where you talk to machines you don't control.

## How it works — the ranked findings

#### R1 — No client-side timeout on a hung connection · consequence: medium, likelihood: medium

The biggest *real* gap. Both `fetchOverpass` (`pipeline/overpass.ts:33`) and the elevation providers (`pipeline/elevation.ts:75,109`) call `fetchImpl(...)` with **no `AbortController` / timeout**. The retry logic in `02` handles a remote that *answers* with a 429/5xx — but a remote that *accepts the connection and never responds* (a hung TCP socket) is a different failure, and there's no client deadline to catch it.

```
  The gap — retries catch a RESPONSE, not a HANG

  remote answers 503 ──► classified ──► backoff ──► retry   ✓ handled
  remote HANGS (no response ever) ──► await fetch(...) ──► ⧖ blocks forever
                                          │
                                          └─ no AbortController ⇒ the build
                                             (or pump) waits indefinitely
```

Mitigations that soften it: Overpass embeds a *server-side* `[timeout:60]` (`overpass.ts:10`), so Overpass itself will usually cut a long query. But Open-Meteo and Nominatim have no such embedded deadline, and a dead-socket (vs. a slow query) defeats even the server-side timeout. **Fix:** wrap each `fetch` in an `AbortController` with a deadline (e.g. 20s), classify the abort as retryable. Low effort, closes the one partial-failure mode the retry loop misses.

#### R2 — Geocode has no retry and throws straight to the UI · consequence: low, likelihood: medium

`geocode`/`geocodeSuggest`/`reverseGeocode` (`pipeline/geocode.ts:24,50,67`) throw on any non-OK status with no retry and no degradation — unlike Overpass (retries) and elevation (degrades). Nominatim's usage policy is ~1 req/s and it *will* 429 under autocomplete bursts. **Consequence:** a transient Nominatim blip surfaces as a failed search/empty dropdown. It's low-severity (search retry is a user re-type) but it's an *inconsistency* in the resilience story — two of three providers are hardened, one isn't. **Fix:** either a small retry-with-backoff matching Overpass, or at minimum debounce autocomplete to stay under 1 req/s (likely already partly handled in the UI layer — verify in `AddressBar.tsx`).

#### R3 — A failed build is silently dropped · consequence: low, likelihood: medium

In `pump`, an Overpass failure is caught and swallowed: `catch { /* keep last region; a later pan retries */ }` (`useTileGraph.ts:121-122`). The recovery (retry on next pan) is *correct*, but it's **silent** — no error surfaced, no "couldn't load this area" toast. **Consequence:** a user in a dead zone pans and sees… nothing new, with no explanation, and `setLoadingStep(null)` clears the spinner so it doesn't even look like it tried. **Fix:** distinguish "covered, nothing to do" from "tried and failed" and surface the latter (a subtle banner). Low effort, real UX clarity.

#### R4 — Degrade-to-flat is invisible · consequence: low, likelihood: high

`bestEffortElevation` (`useTileGraph.ts:18-28`) silently returns flat 0m grades when elevation fails. This is the *right* availability call (`04`), but the user has **no signal** that the grades they're seeing are degraded/fake. **Consequence:** high likelihood (every elevation 429 triggers it) but low severity — a user might trust a "flat" route that's actually hilly, since the whole product premise is grade-awareness. **Fix:** when a region built with degraded elevation, mark it (gray styling already implies it; an explicit "grades unavailable here" hint would close the trust gap). This is the one place the degradation philosophy and the product premise (grade accuracy) are in mild tension.

#### Handled well — no action needed

State plainly what's *good*, because an audit that only lists problems misleads: failure classification + linear backoff on Overpass (`overpass.ts:18,42`, tested `overpass.test.ts:37-55`); exponential backoff on Open-Meteo 429 (`elevation.ts:114`); dedup-to-DEM-cell + batching (`elevation.ts:42-59,100`); single-flight + corridor>view priority (`useTileGraph.ts:67,93`); best-effort degradation (`useTileGraph.ts:18`); idempotent-read design making all retries safe (`03`). This is a well-handled partial-failure surface for its scale.

#### `not yet exercised` — design-ahead flags (not bugs today)

These are correctly absent. They're listed so they're *designed for* before §11 D2/E2, not discovered in production:

| Topic | When it becomes a risk | What to design |
|---|---|---|
| Durable queue / DLQ | §11 E2 build farm | replace `pump`'s RAM refs with a durable broker; DLQ for poison tiles |
| Replication / failover | §11 D2 served graph | read replicas; route around a dead instance |
| Leader election / leases | §11 D2 centralized rebuilds | lease-based single rebuilder; split-brain guard |
| Saga / outbox | §11 E2 multi-write tile build | compensation or transactional outbox once a build commits >1 side effect |
| Consensus / quorum | replicated rebuild writes | quorum to avoid serving a half-rebuilt graph |
| Logical clocks | cross-instance event ordering | or keep single-writer to avoid entirely |

## Primary diagram

The whole audit in one frame.

```
  flattr distributed red-flags — recap

  REAL RISKS (at/near the network seam)        FIX
  ─────────────────────────────────────        ───
  R1 no timeout on hung remote   med×med   ►   AbortController + deadline
  R2 geocode no retry/degrade    low×med   ►   retry or debounce
  R3 build failure silent        low×med   ►   surface "failed to load"
  R4 degrade-to-flat invisible   low×high  ►   signal degraded grades

  HANDLED WELL ─ retry/classify · backoff · dedup · single-flight ·
                 priority · degrade · idempotency

  `NOT YET EXERCISED` ─ durable queue · replication · leadership ·
                        saga/outbox · quorum · clocks
                        └─ trigger: §11 D2/E2 served multi-city graph
```

## Implementation in codebase

**Use cases.** This file is the consequence-ranked index into the others. The two highest-leverage fixes touch one line each, at the network seam:

```
  R1 fix sketch — pipeline/overpass.ts:33 and pipeline/elevation.ts:75,109

  // today (no deadline — hangs forever on a dead socket):
  const res = await fetchImpl(endpoint, { method: "POST", headers, body });

  // hardened (abort after a deadline, then let the RETRYABLE path catch it):
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);     ← client deadline
  try { res = await fetchImpl(endpoint, { ..., signal: ctl.signal }); }
  finally { clearTimeout(t); }
       │
       └─ an aborted fetch throws; classify it as retryable so the existing
          backoff loop handles a hung remote the same way it handles a 503.
```

```
  R4 evidence — mobile/src/useTileGraph.ts:18–28 (the silent degrade)

  catch { return points.map(() => 0); }   ← correct availability call, but no
                                              signal escapes that grades are fake.
       │
       └─ the fix is not to change this behavior (it's right) — it's to RECORD
          that a region degraded, so the UI can hint "grades unavailable here."
```

## Elaborate

A good red-flags audit ranks by *blast radius*, separates *bugs* from *design-ahead*, and names what's *working* so the reader can calibrate. flattr's profile is healthy: the partial-failure handling is real and tested, the gaps are narrow and cheap to close, and the big-ticket distributed topics are honestly absent rather than half-built (a half-built consensus protocol would be a far bigger red flag than no consensus at all).

The single highest-value takeaway: **the one place a single-process system carries distributed risk is its boundary with uncontrolled remotes** — so audit *that seam* exhaustively and you've audited the whole distributed surface. R1 (hung-connection timeout) is the textbook gap there; it's the failure mode every "we added retries" system forgets, because retries handle a *bad response* and not a *no response*. Fix R1 first.

When §11 D2/E2 lands, this audit's `not yet exercised` rows become live lenses — re-run it then with the durable-queue, replication, and leadership findings filled in. Read the per-topic files (`02`–`08`) for the mechanism behind each line here.

## Interview defense

**Q: "What's the biggest reliability risk in this system?"**
A hung remote with no client-side timeout. My retry logic classifies and backs off on a *bad response* — a 429 or 503 — but a remote that accepts the connection and never answers just blocks the `await fetch` forever, because there's no `AbortController` deadline. Overpass softens it with a server-side `[timeout:60]`, but Open-Meteo and Nominatim don't, and a dead socket defeats even that. The fix is one wrapper: abort after ~20s and classify the abort as retryable so the existing backoff loop handles it. It's the classic gap — retries catch a bad answer, not the absence of one.

```
   bad response (503) ──► classified ──► retried   ✓
   NO response (hang)  ──► await blocks ──► ⧖       ✗  ← add AbortController
```
*Anchor: retries handle a bad response; only a timeout handles no response.*

**Q: "You silently degrade to flat elevation and silently drop failed builds. Defend that."**
The behaviors are right; the silence is the risk. Degrading to flat is the correct availability call — a usable gray map beats no map. Dropping a failed build and retrying on the next pan is correct recovery. But both are *invisible*: a user can't tell grades are fake (and grade-accuracy is the whole product premise) or that a load failed. So I wouldn't change the behavior — I'd add a signal: mark degraded regions and surface a "couldn't load this area" hint. The audit separates "wrong behavior" (none here) from "correct-but-silent" (the real, low-severity gap). *Anchor: the behavior is correct; the missing user signal is the fix.*

## Validate

1. **Reconstruct:** name flattr's four real distributed risks and rank them by consequence. Which sits at the network seam? (All of them.)
2. **Explain:** why does the retry loop in `pipeline/overpass.ts:42` *not* protect against a hung connection? What's the one-line fix?
3. **Apply:** Nominatim 429s during autocomplete. Trace `pipeline/geocode.ts:50` — what does the user see, and which hardening (present on Overpass) is missing here?
4. **Defend:** justify why the `not yet exercised` topics (replication, consensus, sagas) are *correctly* absent today, and name the exact trigger (§ reference) that turns each into a live lens.

## See also

- `02-partial-failure-timeouts-and-retries.md` — R1/R2 mechanism (the retry/timeout gap).
- `04-consistency-models-and-staleness.md` — R4 mechanism (degrade-to-flat).
- `06-queues-streams-ordering-and-backpressure.md` — R3 mechanism (silent build drop) + durable-queue design-ahead.
- `00-overview.md` — the ranked-findings summary this audit expands.
- `.aipe/study-system-design/` — the §11 D2/E2 scaling decision that activates the design-ahead flags.
