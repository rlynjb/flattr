# Distributed Systems — overview
### what stays correct when flattr talks to a machine it doesn't own

Here's the verdict up front, because it's the whole frame: **flattr is not a distributed system.** It's a single-process TypeScript engine plus a single-device Expo app reading one prebuilt JSON artifact. There are no replicas, no consensus, no leader, no message queue you operate, no shard map, no two nodes of yours that have to agree on anything. If you came here expecting Raft and quorums, the honest answer for most of this guide is `not yet exercised`.

But there is exactly one genuine distributed-systems surface, and it's worth studying carefully because it's the *real* one — the one every distributed system reduces to once you strip the infrastructure away: **flattr makes calls to remote machines it does not control, over a network that can fail, and it has to stay correct anyway.** Three public APIs at build time and two of them again at runtime on the phone. They time out. They rate-limit. They return stale or smoothed data. They can be down. Everything interesting in this guide lives at that client⇄third-party boundary.

```
  flattr — the only coordination boundaries in the system

  ┌─ YOUR FAILURE DOMAIN (one process at a time) ───────────────┐
  │                                                             │
  │  BUILD TIME                       RUN TIME (the phone)       │
  │  pipeline/run-build.ts            mobile/src/useTileGraph.ts │
  │      │                                  │                    │
  │      │ (in-process function calls,      │ single-flight pump │
  │      │  no network, no coordination)    │ corridor > view    │
  │      ▼                                  ▼                    │
  └──────┼──────────────────────────────────┼───────────────────┘
         │   ═══ NETWORK BOUNDARY ═══        │   ═══ NETWORK ═══
         ▼   (partial failure lives here)    ▼
  ┌─ THEIR FAILURE DOMAIN (you don't control these) ────────────┐
  │  Overpass API        Open-Meteo / Google      Nominatim     │
  │  (OSM streets)       (elevation per point)    (geocode)     │
  │  429 / 502 / 504     429 free-tier limit      ~1 req/s      │
  └─────────────────────────────────────────────────────────────┘

  the only place two machines coordinate = the network boundary.
  everything above it is one process; everything below it is theirs.
```

So read this guide verdict-first. The repo's real distributed concerns are **partial failure, retries, idempotency, rate-limit handling, batching, de-duplication, and best-effort degradation.** The classic big-iron topics — replication, consensus, sagas, clocks — are absent, and each concept file says so plainly and names the trigger that would introduce it (mostly: building the spec's §11 D/E server-side A* over a multi-city served graph).

## Ranked findings — the real partial-failure handling

Ranked by how load-bearing each is to the system actually working:

1. **Best-effort degradation to flat elevation** (`mobile/src/useTileGraph.ts:18-28`, used at `:111`). The single most important distributed-systems decision in the repo. When Open-Meteo 429s on the phone, the build does **not** fail — it catches and returns `0` for every point, so streets still render and routing still connects; grades fill in on a later load when the API recovers. This is the CAP-theorem choice made concrete: **availability over consistency.** A throttled elevation API degrades fidelity, not function.

2. **Single-flight concurrency gate with priority** (`mobile/src/useTileGraph.ts:67,89-129`). `busyRef` lets exactly one graph build touch the network at a time; `pendingCorridorRef`/`pendingViewRef` form a 2-slot priority queue where a pending route corridor always preempts a viewport pan. This is the repo's only piece of concurrency *coordination*, and it exists to stay under the free-tier rate limits — a self-imposed backpressure / admission-control mechanism.

3. **Retry with backoff + failure classification on Overpass** (`pipeline/overpass.ts:18,32-47`). A `RETRYABLE` set (`429,502,503,504`) splits transient from permanent failures; retryable statuses get linear backoff (`delayMs * (attempt+1)`), everything else (e.g. 400) throws immediately without burning retries. Tested at `pipeline/overpass.test.ts:29-55`.

4. **Exponential backoff on Open-Meteo 429** (`pipeline/elevation.ts:96-119`). Same idea, steeper curve: `delayMs * 2 ** (attempt+1)` specifically for 429s, because the documented failure mode is free-tier quota exhaustion (see `.aipe/project/context.md` external-data caveat).

5. **Request de-duplication / batching to respect rate limits** (`pipeline/elevation.ts:42-59,62,85`). Elevation samples are collapsed to one query per ~90m DEM cell (`dedupePrecision`), then batched 100/request (Open-Meteo) or 256/request (Google). Fewer requests = fewer chances to get throttled, and it's also correct: you can't sample finer than the DEM resolution anyway.

6. **Idempotency by construction** (`pipeline/build-graph.ts`, `pipeline/elevation.ts:22-60`). Every remote call is a pure read — `fetchOverpass`, `sample`, `geocode` — keyed only by a bbox or a point list, with no server-side mutation. A retry is *automatically* safe because there is nothing on the other side to double-apply. This is why the retry loops above can be naive (no idempotency keys, no de-dup tokens) and still correct.

7. **Provider abstraction for graceful source swap** (`pipeline/elevation.ts:7-19,65,92`; `pipeline/run-build.ts:22-38`). The `ElevationProvider` interface lets the system fall through Google → Open-Meteo → flat-fixture by environment, and lets `bestEffortElevation` wrap *any* of them with degradation. The seam is what makes degradation composable.

## `not yet exercised` — the classic topics that aren't here

Each file expands these honestly. The short list:

| Topic | Status | Trigger that would introduce it |
|---|---|---|
| Replication / quorums | `not yet exercised` | Spec §11 D(2)/E(2): a served multi-city graph behind an API with >1 instance |
| Consensus / leader election | `not yet exercised` | Multiple server instances needing to agree on a shared mutable graph or job ownership |
| Consistency models / staleness | `barely exercised` | Today: the bundled `graph.json` is a stale snapshot; live read-your-writes appears only if the graph becomes server-served and rebuilt |
| Queues / streams / backpressure | `partially exercised` | The in-process `pump()` gate is the only queue; a real broker (SQS/Kafka) appears with a multi-tile build farm |
| Clocks / ordering / leases | `not yet exercised` | Coordinating ≥2 workers or leader leases over shared state |
| Sagas / outbox / compensation | `not yet exercised` | A multi-step workflow with a mutation that must be undone on partial failure |
| Exactly-once delivery | `not needed` | All remote calls are idempotent reads; at-least-once + idempotency = effectively-once for free |

## Reading order

```
  00-overview.md ......... you are here — the map + ranked findings
  01-distributed-system-map.md ... nodes, boundaries, failure domains
  02-partial-failure-timeouts-and-retries.md ... the load-bearing file
  03-idempotency-deduplication-and-delivery-semantics.md
  04-consistency-models-and-staleness.md
  05-replication-partitioning-and-quorums.md ... mostly `not yet exercised`
  06-queues-streams-ordering-and-backpressure.md ... the pump() gate
  07-clocks-coordination-and-leadership.md ... `not yet exercised`
  08-sagas-outbox-and-cross-boundary-workflows.md ... `not yet exercised`
  09-distributed-systems-red-flags-audit.md ... ranked risks
```

## See also (sibling guides)

- `.aipe/study-networking/` — the transport beneath these calls: DNS, TLS, HTTP semantics, the actual `fetch()`. This guide assumes the wire works; that guide explains the wire.
- `.aipe/study-system-design/` — the build/runtime split, the static-artifact architecture, the boundary diagram at the system level.
- `.aipe/study-runtime-systems/` — the single-flight `pump()` gate as an *execution-model* concern (event loop, async, cancellation), where this guide treats it as *coordination*.
- `.aipe/study-database-systems/` — datastore-local consistency; the `graph.json` snapshot as a read-only store.
