# Study — Distributed Systems (flattr)

The question this guide answers: **what stays correct when coordination crosses a boundary and any participant can be slow, duplicated, stale, or unavailable?**

flattr is a single client with no server, replicas, workers, or queues — so most distributed-systems concepts are taught **curriculum-style** here: the concept plus the exact trigger that would force it into the design. The one real distributed boundary — **client/build ⇄ third-party APIs (Overpass, Open-Meteo, Nominatim)** — is where every *exercised* concept lives.

## Reading order

| # | File | Status | What it covers |
|---|------|--------|----------------|
| 00 | `00-overview.md` | — | Map, ranked findings, the honest gap. Read first. |
| 01 | `01-distributed-system-map.md` | exercised | The coordination map: one node, three external deps, one boundary. |
| 02 | `02-partial-failure-timeouts-and-retries.md` | **exercised** | Retry + backoff (Overpass linear, Open-Meteo exp), the missing timeout. |
| 03 | `03-idempotency-deduplication-and-delivery-semantics.md` | **exercised** | Reads-only → retries safe by construction; why no idempotency keys. |
| 04 | `04-consistency-models-and-staleness.md` | **exercised (richest)** | Stale-by-design graph + self-healing elevation cache; the CAP choice. |
| 05 | `05-replication-partitioning-and-quorums.md` | not yet exercised | Taught + triggers; the latent bbox shard key. |
| 06 | `06-queues-streams-ordering-and-backpressure.md` | **mixed** | Pump = exercised backpressure; real queues = not yet. |
| 07 | `07-clocks-coordination-and-leadership.md` | not yet exercised | Taught + trigger (multi-device sync). |
| 08 | `08-sagas-outbox-and-cross-boundary-workflows.md` | not yet exercised | Taught + trigger (multi-system writes). |
| 09 | `09-distributed-systems-red-flags-audit.md` | audit | Ranked risks with evidence. #1 = add request timeouts. |

## The fastest path

- **Just the real stuff:** 01 → 02 → 03 → 04 → 06 (the exercised concepts).
- **The one fix to make:** 09, Risk 1 (no request timeout → wedged pump).
- **The growth map:** 05 → 07 → 08 (what the next version of flattr forces you to learn).

## Anchors

- `pipeline/overpass.ts`, `pipeline/elevation.ts`, `pipeline/geocode.ts` — the boundary.
- `mobile/src/useTileGraph.ts` — pump (backpressure), best-effort fallback, self-heal retry.
- `mobile/src/elevCache.ts`, `mobile/src/loadGraph.ts` — local consistency + stale-by-design.
- `pipeline/run-build.ts` — the build-time caller that bakes `graph.json`.

## Sibling guides

`study-system-design` (architecture/scale) · `study-networking` (transport beneath these calls) · `study-database-systems` (datastore-local consistency) · `study-debugging-observability` (the missing degradation signal) · `study-performance-engineering` (pump/cache as throughput).
