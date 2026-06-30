# Networking — overview

> Study guide for the transport and protocol behavior the **flattr** repo actually
> exercises. Every claim is grounded in `file:line`. Inference is labelled. Concepts
> the repo does not touch are marked **not yet exercised** — honestly, with the note
> on when they'd become relevant.

## The verdict first

flattr is a TypeScript grade-aware router with **no backend of its own**. There is no
server flattr runs, no database it owns, no socket it listens on. All of flattr's
networking is **outbound client calls to three free, third-party HTTP/JSON APIs**, all
over `fetch`:

```
  flattr's entire network surface — three outbound HTTP clients

  ┌─ flattr code ────────────────────────────────────────────────┐
  │                                                               │
  │  pipeline/overpass.ts   ──POST form──►  Overpass API (OSM)    │
  │     fetchOverpass()                     overpass-api.de       │
  │                                                               │
  │  pipeline/elevation.ts  ──GET batch──►  Open-Meteo Elevation  │
  │     openMeteoProvider()                 api.open-meteo.com    │
  │                                                               │
  │  pipeline/geocode.ts    ──GET──────►    Nominatim (OSM)       │
  │     geocode()/Suggest()                 nominatim.osm.org     │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
           ▲                                        ▲
           │ build-time (Node, tsx)                 │ runtime (RN, on device)
           │ pipeline/run-build.ts                  │ mobile/src/useTileGraph.ts
           │ → writes graph.json once               │ + mobile/src/MapScreen.tsx
```

That's it. No WebSockets, no SSE, no streaming, no connection-pool tuning, no service
flattr exposes. The whole guide is about **how flattr behaves as an HTTP client against
rate-limited free APIs it does not control** — which turns out to be the most
consequential design force in the networking layer.

## The three clients, and what each one taught the code

| Client | File | Verb | Failure handling | Driving constraint |
|--------|------|------|------------------|--------------------|
| Overpass | `pipeline/overpass.ts:21` | POST (form-encoded) | retry + linear backoff on 429/502/503/504 (`overpass.ts:18,42-45`) | public-server load shedding |
| Open-Meteo | `pipeline/elevation.ts:92` | GET (batched ≤100) | retry + **exponential** backoff on 429 only (`elevation.ts:114-117`) | free-tier quota, dedup + cache to cut volume |
| Nominatim | `pipeline/geocode.ts:9` | GET | **no retry**; throws on non-2xx (`geocode.ts:24`) | ~1 req/s policy → debounce + sequential calls in UI |

Three APIs, three *different* retry curves. That difference is not an accident — it's
each API's published failure mode showing through into flattr's code. See
`07-timeouts-retries-pooling-and-backpressure.md` for why they diverge.

## Ranked findings — what's most consequential

1. **No client-side request timeout anywhere.** Not in Overpass, not in Open-Meteo,
   not in Nominatim. The `[out:json][timeout:60]` in `overpass.ts:10` is a *server-side*
   Overpass directive, not a `fetch` timeout. No `AbortController` exists in the repo
   (verified: zero matches across `pipeline/`, `mobile/src/`, `lib/`, `features/`). A
   hung TCP connection blocks until the OS gives up. **Highest-consequence gap.** See
   `07` and `08`.

2. **Free-tier rate limits are the dominant design force.** Dedup by DEM cell
   (`elevation.ts:42`), a persistent on-disk elevation cache (`elevCache.ts`), a
   single-in-flight build pump (`useTileGraph.ts:166`), debounced autocomplete
   (`MapScreen.tsx:80`), and sequential geocodes (`MapScreen.tsx:189`) all exist to
   **cut request volume**. The networking layer is shaped around *not getting 429'd*.

3. **Best-effort degradation over hard failure.** When elevation 429s, the mobile build
   falls back to flat (0 m) elevation rather than failing the whole region
   (`useTileGraph.ts:20-31`), then silently self-heals on a retry timer
   (`useTileGraph.ts:209-218`). Connectivity is prioritized over fidelity.

4. **TLS and DNS are fully delegated to the OS/runtime.** Every URL is `https://`
   (`overpass.ts:4`, `elevation.ts:106`, `geocode.ts:5`), and flattr writes zero code
   to manage certificates, cipher suites, or name resolution. Correct for an HTTP
   client — but it means the trust story lives entirely in the platform. See `04`.

## Reading order

```
  00-overview.md            ← you are here
  01-network-map.md         the full on-the-wire path, every boundary
  02-dns-routing-and-addressing.md   names → addresses (OS-delegated)
  03-tcp-udp-connections-and-sockets.md   transport beneath fetch
  04-tls-and-trust-establishment.md  https, certs, termination (OS-delegated)
  05-http-semantics-caching-and-cors.md  methods, status, headers, the app cache
  06-websockets-sse-streaming-and-realtime.md   NOT YET EXERCISED — what'd change
  07-timeouts-retries-pooling-and-backpressure.md  the load-bearing chapter
  08-networking-red-flags-audit.md   ranked risks with evidence
```

## not yet exercised — named honestly

- **WebSockets / SSE / streaming** — flattr has no long-lived connection and no
  streamed response. Every call is request/response JSON. `06` explains what would
  change if route progress or live traffic were added.
- **Connection pooling / keep-alive tuning** — flattr never configures an agent, pool
  size, or keep-alive. It relies on whatever the runtime's `fetch` does by default
  (Node undici / React Native). `03` and `07` cover this.
- **DNS / proxy / edge config** — no custom resolver, no proxy, no CDN flattr owns.
  `02` covers what the OS does on flattr's behalf.
- **CORS** — flattr's runtime calls are from Node (no origin) and React Native (no
  browser origin enforcement), so CORS preflight never fires. `05` explains why, and
  the one place it *would* bite (the spec's proposed Next.js web app).

## Cross-links to sibling guides

- `study-security` — **whether** each of these three trust boundaries is safe (User-Agent
  spoofing, unvalidated third-party JSON, no cert pinning).
- `study-system-design` — **where** the network boundaries sit in the build-time vs
  runtime split, and why the graph is a prebuilt artifact.
- `study-performance-engineering` — the latency/throughput cost of batching, dedup, and
  the single-in-flight pump.
- `study-distributed-systems` — partial failure across three independent third-party
  services flattr doesn't control.
- `study-runtime-systems` — the event loop and async I/O model beneath every `await fetch`.
