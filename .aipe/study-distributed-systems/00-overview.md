# Distributed Systems — flattr

> The one-page orientation. Read this first, then follow the reading order at the bottom.

flattr is **not** a distributed system in the textbook sense — there's no server, no replicas, no workers, no queues, no consensus. It's a single TypeScript engine plus one Expo/React-Native client that reads a graph. So most of this guide is **curriculum-style**: it teaches the concept and names the exact trigger that *would* introduce it here, rather than pretending the repo exercises it.

But there is one real distributed boundary, and it's a good one to learn on: **the client (and the build pipeline) calling third-party HTTP APIs it doesn't own** — Overpass (OSM streets), Open-Meteo (elevation), Nominatim (geocoding). Every concept that *is* exercised lives at that boundary.

## The whole system, one diagram

```
  flattr — where coordination crosses a boundary (and where it doesn't)

  ┌─ Single client (Expo / React Native) ──────────────────────────┐
  │  MapScreen.tsx → useTileGraph.ts (single-flight pump)           │
  │  loadGraph.ts (reads bundled graph.json — STALE BY DESIGN)      │
  │  elevCache.ts (AsyncStorage — local eventual consistency)       │
  └───────────────┬───────────────────────────────┬────────────────┘
                  │                                │
   ════ THE ONE DISTRIBUTED BOUNDARY ════════════════════════════════
   client ⇄ third-party APIs it does NOT own, can be slow/down/throttled
                  │                                │
  ┌─ Overpass ────▼──┐  ┌─ Open-Meteo ──▼──┐  ┌─ Nominatim ──────────┐
  │ OSM streets      │  │ elevation (DEM)  │  │ geocode (address↔xy) │
  │ overpass.ts      │  │ elevation.ts     │  │ geocode.ts           │
  │ retry+backoff    │  │ retry+backoff    │  │ NO retry, NO timeout │
  └──────────────────┘  └──────────────────┘  └──────────────────────┘

  same APIs are also called at BUILD TIME by pipeline/run-build.ts
  → graph.json is baked once, then shipped. That bake is the staleness source.
```

Everything left of the double line is one process — no partial failure between those boxes. Everything that crosses the double line is the real lesson: a call that can hang, 429, or vanish, with another participant you can't control.

## The ranked findings — what's actually here

The verdict first, then the breakdown:

1. **Partial failure handling is real and decent — with one sharp gap.** `overpass.ts` and `elevation.ts` both retry retryable statuses with backoff (linear and exponential respectively). The gap: **no client-side request timeout anywhere**. A hung TCP connection to Overpass blocks the pump forever; `fetch` has no deadline. This is the top red flag. → `02-partial-failure-timeouts-and-retries.md`, `09-...-red-flags-audit.md`

2. **Delivery semantics are trivially correct — by construction, not by mechanism.** Every remote call is a pure READ keyed by a bbox or a coordinate. Retrying a GET for the same bbox returns the same streets. There are no writes crossing the boundary, so there's nothing to make idempotent — no idempotency keys, no dedup table needed. Naming *why* you don't need them is the signal. → `03-idempotency-deduplication-and-delivery-semantics.md`

3. **Consistency is "stale by design" + "eventually consistent locally."** `graph.json` is frozen at build time (`run-build.ts`) and shipped in the bundle — the map shows whatever the world looked like when you last ran `npm run build:graph`. The elevation cache (`elevCache.ts`) is best-effort and self-heals: a throttled region renders flat, gets marked `degraded`, and a background retry upgrades it to real grades once the API recovers. That's local eventual consistency with a convergence mechanism you can point at. → `04-consistency-models-and-staleness.md`

4. **Graceful degradation is the CAP tradeoff made concrete.** `bestEffortElevation` in `useTileGraph.ts:20` catches a throttle and returns flat (0 m) elevation rather than failing the build. The streets still render, routing still connects — **availability chosen over consistency**, then repaired asynchronously. This is the cleanest distributed-systems decision in the repo. → `04-consistency-models-and-staleness.md`, `02-...`

5. **Backpressure exists — as a single-flight pump.** `useTileGraph.ts` runs exactly one graph build at a time (`busyRef`), with the route corridor prioritized over the viewport, plus a 600 ms debounce. That's load-shedding against the free-tier rate limits, framed as a client-side concurrency-of-1 queue. → `06-queues-streams-ordering-and-backpressure.md`

6. **Everything else is `not yet exercised`** — replication, partitioning, quorums, real distributed queues/streams, clocks/leadership/consensus, sagas/outbox. There's no second node to coordinate with, so none of it applies *yet*. Each file teaches the concept and names the trigger (a multi-user service, multi-device sync) that would force it into the design. → `05`, `06`, `07`, `08`

## The honest gap

Per `me.md`: Rein's portfolio is strong on frontend, DSA, and five shipped single-node system shapes — and explicitly thin on **horizontal-scale distributed systems** (multi-region replication, hot-path queue infrastructure, consensus, load balancing under sustained traffic). This guide does not overclaim. Where the repo has evidence, it's grounded to `file:line`. Where it doesn't, the file says `not yet exercised` and teaches the concept anyway, because that's where the growth is.

## Reading order

```
  00  overview ........................ you are here
  01  distributed-system-map ......... the coordination map: what talks to what
  02  partial-failure ................ retries, backoff, the missing timeout  ← exercised
  03  idempotency .................... why reads-only means no idempotency keys ← exercised
  04  consistency-and-staleness ...... stale-by-design + self-healing cache    ← exercised (richest)
  05  replication-partitioning ....... not yet exercised — taught + triggers
  06  queues-streams-backpressure .... pump = exercised; queues = not yet
  07  clocks-coordination-leadership . not yet exercised — taught + triggers
  08  sagas-outbox ................... not yet exercised — taught + triggers
  09  red-flags-audit ................ ranked risks with evidence
```

Start with `01` for the map, then `02`–`04` for the concepts the repo actually exercises. `05`, `07`, `08` are forward-looking — read them when you want to know what the *next* version of flattr forces you to learn.

## See also (sibling guides)

- `study-system-design` — architectural shape and scale tradeoffs (the *what to build* next to this guide's *what stays correct*).
- `study-networking` — the transport layer beneath these calls: DNS, TLS, connection pooling, HTTP semantics. The missing timeout is also a networking finding.
- `study-database-systems` — datastore-local consistency (the elevCache persistence story has a sibling there).
- `study-performance-engineering` — the pump as backpressure, the cache as request-elimination, batching.
