# Distributed-Systems Red-Flags Audit

Ranked coordination and partial-failure risks, grounded in real files. Ranked by consequence: what breaks, how likely, how bad. This is the audit file — it walks every lens, names the evidence, and emits `not yet exercised` honestly for the lenses that don't apply to a one-node app.

## The ranking, at a glance

```
  risk                                    │ severity │ likelihood │ status
  ────────────────────────────────────────┼──────────┼────────────┼────────
  1. no client request timeout            │  HIGH    │  MEDIUM    │ REAL gap
  2. no jitter on retry backoff           │  LOW     │  LOW       │ fine (1 client)
  3. unbounded retry loop header          │  LOW     │  LOW       │ guarded inside
  4. build-time hard dependency on 3 APIs │  MEDIUM  │  MEDIUM    │ accepted
  5. silent catch-all error swallowing    │  LOW     │  MEDIUM    │ intentional, untraced
  ────────────────────────────────────────┴──────────┴────────────┴────────
  everything else (replication, quorum, leadership, saga, outbox,
  real queues, ordering, poison messages): NOT YET EXERCISED
```

## Risk 1 — No client-side request timeout (the real one)

**Severity: HIGH. Evidence: `pipeline/overpass.ts:33`, `pipeline/elevation.ts:109`, `pipeline/geocode.ts:21`, `mobile/src/useTileGraph.ts:186`.**

Every `fetch` in the codebase calls the provider with no `AbortController` and no deadline. `fetch` does not time out on its own. A connection that opens and then goes silent — server accepts the socket, sends nothing — hangs the `await` forever.

```
  The hang, and where it propagates

  await fetchOverpass(bbox)
        └─► await fetchImpl(endpoint)  ── [silent connection] ──► ⌛ forever
                                                                    │
  consequence (run-time): busyRef stays true ──► pump WEDGED ──► no
   further viewport/corridor builds EVER run. The map silently stops
   loading new regions; the user just sees nothing happen.
```

This is the one risk that bites *today*, with one client, no scale required. The retry loops in `02` don't help — they only run *after* a response arrives; a hang never arrives, so it escapes every guard. The fix is small and localized: wrap each `fetchImpl` in `AbortController` + `setTimeout(abort, DEADLINE)`, pass `signal`, and treat the abort as a retryable failure so the existing backoff/fallback machinery takes over. → full walk in `02-partial-failure-timeouts-and-retries.md` Part 4.

## Risk 2 — No jitter on retry backoff

**Severity: LOW (today). Evidence: `overpass.ts:43` (`delayMs * (attempt + 1)`), `elevation.ts:117` (`delayMs * 2 ** (attempt + 1)`).**

Both backoffs are deterministic — no randomization. With a fleet of clients, deterministic backoff means they retry in lockstep after a shared outage (thundering herd). flattr is **one client**, so there's no herd to synchronize; this is correctly a non-issue today. Flagged only so it's named: the trigger to add jitter is "flattr becomes multi-user." Don't add it before then.

## Risk 3 — Unbounded `for` loop headers

**Severity: LOW. Evidence: `overpass.ts:32` (`for (let attempt = 0; ; attempt++)`), `elevation.ts:108`.**

Both retry loops have empty termination conditions in the `for` header. Read in isolation that looks like an infinite loop. It isn't — termination is enforced *inside* by `attempt < retries` plus the throw on non-retryable status. It's correct, but it's the kind of construct that invites a future edit to drop a guard and create a real infinite loop. Low risk, worth a comment; not worth a change.

## Risk 4 — Build-time hard dependency on three external APIs

**Severity: MEDIUM. Evidence: `pipeline/run-build.ts:43-46`, `pipeline/config.ts:10`.**

`npm run build:graph` cannot produce `graph.json` without Overpass *and* an elevation source reachable. If Overpass is down, the build fails outright (no fallback — `run-build.ts:54-57` exits non-zero). The project context already documents the Open-Meteo 429 hazard as a known build-time footgun.

This is **accepted, not a bug**: it's a developer-run build script, failures are loud and re-runnable, and there *is* a fallback path (`FLAT_ELEVATION=1`, `run-build.ts:28-31`) for the elevation leg. The blast radius is a developer re-running a command, not a user. The honest note: the elevation provider chain (Google > Open-Meteo > flat) has graceful degradation; the Overpass leg does not — a down Overpass just fails the build. Acceptable for now; the fix (cache last-good OSM) only earns its place if builds get frequent or automated.

## Risk 5 — Silent catch-all error swallowing, untraced

**Severity: LOW. Evidence: `useTileGraph.ts:219-220` (`catch {}` keeps last region), `useTileGraph.ts:21-30` (bestEffort swallows to flat), `elevCache.ts:26-28`, `elevCache.ts:54-56`.**

Several `catch` blocks swallow errors silently and degrade — which is *correct behavior* for graceful degradation (a throttle shouldn't crash the map). The risk isn't the swallowing; it's that it's **invisible**. There's no log, metric, or counter when a region degrades or an Overpass fetch fails. In production you'd have no signal that the elevation API has been throttling all your users for an hour.

```
  Degradation happens — but leaves no trace

  Open-Meteo 429 ─► bestEffortElevation catches ─► flat fallback
                                                    │
                                                    └─► (no log, no metric)
                                                        you never know it happened
```

The degradation is the right call; the silence is the gap. The fix is observability, not behavior change: increment a counter / emit a log on each fallback and each swallowed Overpass failure. This is a debugging-observability finding as much as a distributed-systems one. → sibling `study-debugging-observability`.

## Lens audit — every concept, status named

```
  lens                              │ status            │ where
  ───────────────────────────────────┼───────────────────┼──────────
  partial failure / retries          │ EXERCISED         │ 02
  timeouts                           │ GAP (Risk 1)      │ 02, 09
  idempotency / delivery semantics   │ EXERCISED (by     │ 03
                                     │  construction)    │
  consistency / staleness            │ EXERCISED (rich)  │ 04
  graceful degradation / CAP         │ EXERCISED         │ 04
  backpressure                       │ EXERCISED (pump)  │ 06
  replication                        │ not yet exercised │ 05
  partitioning / sharding            │ not yet exercised │ 05 (key latent)
  quorums                            │ not yet exercised │ 05
  real queues / streams              │ not yet exercised │ 06
  ordering / poison messages         │ not yet exercised │ 06
  clocks / logical time              │ not yet exercised │ 07
  leadership / leader election       │ not yet exercised │ 07
  leases / split-brain               │ not yet exercised │ 07
  consensus (Raft/Paxos)            │ not yet exercised │ 07
  sagas / compensation               │ not yet exercised │ 08
  transactional outbox               │ not yet exercised │ 08
  reconciliation                     │ not yet exercised │ 08
```

## The one thing to fix

If you do exactly one thing from this audit: **add request timeouts** (Risk 1). It's the only risk that's a real, present bug rather than a "not yet" — a single hung connection silently wedges the run-time pump, and it's a small, localized fix that plugs into machinery you already have. Everything below it is either correctly absent (the `not yet exercised` rows) or a deliberate, defensible tradeoff.

## See also

- `02-partial-failure-timeouts-and-retries.md` — Risks 1–3 in depth.
- `04-consistency-models-and-staleness.md` — Risk 5's degradation is the CAP choice working as designed.
- `06-queues-streams-ordering-and-backpressure.md` — the pump Risk 1 would wedge.
- sibling `study-debugging-observability` — Risk 5's missing signal.
- sibling `study-networking` — Risk 1 at the transport layer.
