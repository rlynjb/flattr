# Distributed Systems — flattr

> Curriculum-style guide. flattr is a single client (Expo/React Native) plus a
> build-time pipeline. There is **no server, no replica set, no worker pool, no
> queue infrastructure** you own. So this is not an audit of a distributed
> backend — it's a study of the *one real distributed boundary* this repo has,
> taught honestly, with the rest of the field marked `not yet exercised` and
> teed up for when it becomes relevant.

## The one boundary that matters

```
  flattr's only distributed seam — client ⇄ third-party APIs

  ┌─ Your code (the only node you own) ───────────────────────┐
  │                                                            │
  │   build pipeline (Node)        mobile app (Expo/RN)        │
  │   pipeline/run-build.ts        mobile/src/useTileGraph.ts  │
  │                                                            │
  └───────────┬───────────────────────────┬───────────────────┘
              │  HTTP (the network)        │  HTTP
              ▼                            ▼
  ┌─ Third parties you do NOT own — can be slow / down / throttle ─┐
  │  Overpass API        Open-Meteo Elevation     Nominatim       │
  │  (OSM streets)       (90m DEM heights)         (geocoding)     │
  └────────────────────────────────────────────────────────────────┘
```

Everything in distributed systems is "what stays correct when a participant you
don't control is slow, duplicated, stale, or unavailable?" flattr has exactly
one class of such participant: the public OSM/weather APIs. Every concept in
this guide either anchors *there* or is taught as a concept you'll need the day
flattr grows a second node (a shared server, a second device).

## Verdict-first — what's actually here

flattr's distributed story is **a read-only client talking to flaky free APIs,
defended by retries, caching, and graceful degradation.** That's it, and it's
done with more care than most production code. The three things worth knowing:

1. **Every remote call is a pure READ keyed by geography** (bbox or coords).
   That single fact makes retries safe *by construction* — no idempotency keys,
   no dedup logic, no exactly-once machinery needed. The hardest problem in
   distributed systems (delivery semantics) is sidestepped, not solved, and
   that's the right call here. → `03`.

2. **Availability is chosen over consistency at every failure point.** Elevation
   API throttles? Build the graph with flat (0 m) grades so streets still render
   and routing still connects (`useTileGraph.ts:20-31`). The grades are wrong,
   but the app works. CAP made concrete: pick A, mark the data degraded, self-heal
   later. → `02`, `04`.

3. **The graph is stale by design.** It's baked at build time into
   `mobile/assets/graph.json` and read-only forever after. Streets change in OSM;
   flattr won't know until the next `npm run build:graph`. On-device tile fetches
   layer fresher data on top, converging toward local consistency. → `04`.

## Ranked findings (evidence in `09`)

```
  risk / strength            where                         verdict
  ───────────────────────────────────────────────────────────────────
  ① NO client-side timeout   overpass.ts, geocode.ts,      real gap —
     on any fetch            elevation.ts                  a hung socket
                                                           blocks forever
  ② retry without a deadline overpass.ts:32-47             backoff bounds
     budget (count, not time) elevation.ts:108-119         attempts, not
                                                           wall-clock
  ③ graceful degradation     useTileGraph.ts:20-31         strength —
     (flat fallback)                                       A over C, done well
  ④ self-heal retry, capped  useTileGraph.ts:209-218       strength —
                                                           eventual local consistency
  ⑤ single-flight pump as    useTileGraph.ts:166-227       strength —
     backpressure                                          1 build at a time, prioritized
  ⑥ best-effort cache,       elevCache.ts, useTileGraph    strength —
     only-real-values cached :38-62                        no poisoning the cache
```

## Reading order

```
  01-distributed-system-map ............ the coordination map: who talks to whom,
                                         what fails, what you own
  02-partial-failure-timeouts-and-retries  the load-bearing concept here —
                                         retries, backoff, the missing timeout
  03-idempotency-deduplication-and-      why retries are safe for free
     delivery-semantics                  (pure reads keyed by geography)
  04-consistency-models-and-staleness .. stale-by-design graph + best-effort
                                         cache → eventual local consistency
  05-replication-partitioning-and-quorums  NOT YET EXERCISED — taught + triggers
  06-queues-streams-ordering-and-        single-flight pump IS backpressure;
     backpressure                        real queues NOT YET EXERCISED
  07-clocks-coordination-and-leadership  NOT YET EXERCISED — taught + triggers
  08-sagas-outbox-and-cross-boundary-    NOT YET EXERCISED — taught + triggers
     workflows
  09-distributed-systems-red-flags-audit  ranked risks, evidence per verdict
```

## `not yet exercised` — and the trigger for each

These are real distributed-systems concepts flattr does **not** contain. Listed
honestly so you don't claim repo evidence you don't have, and tagged with the
single change that would pull each one into scope.

```
  concept                        not here because        becomes relevant when…
  ──────────────────────────────────────────────────────────────────────────────
  replication / quorums          one read-only graph     flattr runs a shared
  (05)                           file, no second copy     server with replicas
  partitioning / sharding (05)   one graph, one bbox     the graph won't fit one
                                                          node / one region
  queues / streams (06)          no async work handoff   background route jobs,
                                                          a push pipeline
  poison messages (06)           no message consumer     you process a real queue
  clocks / leases / leader       no coordinating peers   multi-device sync, any
  election / split-brain (07)    (single client)         "who's authoritative" call
  sagas / compensation (08)      every call is a read,   a multi-step WRITE crosses
                                 no multi-step write      services (book + pay + notify)
  transactional outbox (08)      no DB + no external      a local commit must reliably
                                 publish in one txn       trigger a remote effect
  read-your-writes (04)          no user writes at all    a user saves a route and
                                                          must see it back immediately
```

**The honest framing (from `me.md`):** Rein's gap is horizontal-scale
distributed systems — replication, quorums, queue infra under sustained load.
This guide teaches those concepts so they're not a black box in an interview,
but it does **not** pretend flattr exercises them. Where flattr is silent, the
guide says so and points at the trigger.

## Cross-links to sibling guides

- **system-design** — the architectural shape and scale tradeoffs of flattr
  overall (the build-time-vs-runtime split, the on-device tile system). This
  guide owns *correctness across the API boundary*; system-design owns *shape*.
- **networking** — the transport mechanics under these same fetches (DNS, TLS,
  HTTP semantics, connection reuse, where a timeout would actually live).
- **database-systems** — datastore-local consistency. flattr's "store" is a JSON
  file + an AsyncStorage cache; that guide owns the storage-engine view.
- **performance-engineering** — the batching, debounce, dedup, and rate-limit
  budgets these same files exercise, viewed as throughput/latency rather than
  correctness.
- **runtime-systems** — the single-flight pump and async lifecycle as an
  execution-model question (event loop, bounded work, cancellation).
- **debugging-observability** — the `degraded` flag and `loadingStep` as the
  observability surface for these failures.
