# Networking — overview
### the on-the-wire map of flattr

You've shipped network-heavy systems before: AdvntrCue streaming GPT-4 over a serverless function, buffr mirroring SQLite to Supabase, dryrun falling back from on-device Gemini Nano to a cloud API. flattr is a *different* network shape, and the difference is the whole lesson. There is no backend you own. There is no socket you keep open. Almost everything that touches the wire here is a `fetch()` to a **third-party public API you don't control and can't authenticate to** — Overpass, Open-Meteo, Nominatim, OpenFreeMap. The interesting engineering is entirely defensive: how do you stay polite to a free API, and what do you do when it says 429?

This guide walks the transport and protocol behavior the repo actually exercises. Read it verdict-first: here's the shape, here's what's load-bearing, here's what's missing.

```
  flattr — the whole network picture in one frame

  ┌─ BUILD TIME (your laptop, `npm run build:graph`) ───────────┐
  │  pipeline/run-build.ts                                      │
  │     │  POST                    GET                          │
  │     ▼                          ▼                            │
  │  Overpass API           Open-Meteo / Google Elevation       │
  │  (OSM streets)          (elevation per point)               │
  │     └──────────┬────────────────┘                           │
  │                ▼  writes once                                │
  │          data/graph.json  ──copied──►  mobile/assets/        │
  └─────────────────────────────────────────────────────────────┘
                         │  bundled into the app binary
                         ▼
  ┌─ RUN TIME (the phone, Expo / React Native) ─────────────────┐
  │  MapScreen.tsx                                               │
  │   ├─ map tiles ──GET──► tiles.openfreemap.org  (MapLibre)   │
  │   ├─ geocode  ──GET──► nominatim.openstreetmap.org          │
  │   └─ useTileGraph ──┬──POST──► Overpass  (more streets)     │
  │                     └──GET───► Open-Meteo (more elevation)  │
  │                                                             │
  │  loadGraph() reads the BUNDLED graph.json — zero network    │
  │  GPS via expo-location — device API, not the wire           │
  └─────────────────────────────────────────────────────────────┘

  every arrow crosses a NETWORK BOUNDARY into a provider you don't own
```

The single most important structural fact: **the same pipeline runs in two places.** `pipeline/overpass.ts`, `pipeline/elevation.ts`, and `pipeline/build-graph.ts` were written for the build-time CLI, and the mobile app imports the exact same modules to fetch more map area at runtime (`mobile/src/useTileGraph.ts:11-13`). One networking codebase, two lifecycles. The system-design guide owns *where* that build-vs-runtime split belongs (`.aipe/study-system-design/`); this guide owns *what happens on the wire* in both.

## Reading order

```
  00-overview.md ........... you are here — the map + ranked findings
  01-network-map.md ........ every hop, every provider boundary
  02-dns-routing-and-addressing.md ... 4 hostnames, no proxy, no edge you own
  03-tcp-udp-connections-and-sockets.. fetch over TCP, no sockets, no pooling control
  04-tls-and-trust-establishment ..... HTTPS to all four, trust delegated to the platform
  05-http-semantics-caching-and-cors . GET/POST, status codes, the headers you DO send
  06-websockets-sse-streaming-and-realtime .. not exercised — and why that's correct
  07-timeouts-retries-pooling-and-backpressure .. the real meat: retry/backoff + the busy-lock
  08-networking-red-flags-audit ...... ranked risks grounded in real lines
```

## Ranked findings — what's actually interesting on the wire

**1. Retry-with-backoff exists, but only for two of four providers, and there's no jitter.** `pipeline/overpass.ts:18-47` retries a fixed `RETRYABLE` set (429/502/503/504) with *linear* backoff (`delayMs * (attempt + 1)`). `pipeline/elevation.ts:108-119` retries Open-Meteo 429s with *exponential* backoff (`delayMs * 2 ** (attempt + 1)`). Two different backoff curves in one codebase. Nominatim geocoding (`pipeline/geocode.ts`) has **no retry at all** — one shot, throw on non-OK. Full walk in `07-timeouts-retries-pooling-and-backpressure.md`.

**2. No request timeout anywhere.** Not one `fetch()` in the repo passes an `AbortSignal` or any deadline. The only timeout that exists is *server-side*, embedded in the Overpass QL itself (`[out:json][timeout:60]`, `pipeline/overpass.ts:10`) — that's the Overpass server promising to give up after 60s, not the client. If any provider hangs the TCP connection open without responding, the client waits forever (bounded only by the OS default, typically ~minutes). This is the top red flag — see `08-networking-red-flags-audit.md`.

**3. The free-tier rate limit is a real, documented operational constraint, not a hypothetical.** Open-Meteo 429s when its free quota is exhausted by heavy testing — this is recorded in `.aipe/project/context.md` and the user's memory. The whole batching/dedup/throttle design (`OPEN_METEO_BATCH = 100`, `dedupePrecision`, `delayMs` between batches) exists to stay under it. This is the clearest case in the repo of protocol semantics (429 Too Many Requests) driving real design. See `05` and `07`.

**4. Runtime degrades to flat instead of failing — a deliberate partial-failure stance.** `mobile/src/useTileGraph.ts:18-28` wraps the elevation provider so a throttled/down elevation API yields `0 m` elevations rather than aborting the whole graph build. Streets still render, routing still connects, grades fill in on a later load. This is the partial-failure handling that `.aipe/study-distributed-systems/` reasons about generally; here it's eight lines of `try/catch`.

**5. A single in-flight build, gated by a busy-lock, prioritizing route corridors over viewport pans.** `mobile/src/useTileGraph.ts:89-129` runs exactly one network graph-build at a time (`busyRef`), with a two-slot pending queue where the route corridor preempts viewport panning. This is the only backpressure mechanism in the repo — it caps concurrency at 1 to stay under the same free rate limits. See `07`.

## `not yet exercised` — and why that's the right call

- **WebSockets / SSE / any streaming or realtime transport.** Nothing in the repo opens a long-lived connection. Routing is a pure local A\* over a bundled graph; there's no server to stream from. `06-websockets-sse-streaming-and-realtime.md` explains why this is correct for the architecture, not a gap.
- **Connection pooling / keep-alive control.** The code uses the platform `fetch`; it never configures an HTTP agent, pool size, or keep-alive. Inferred: the platform reuses connections under the hood, but the repo neither controls nor depends on it. See `03`.
- **DNS configuration, proxies, CDN/edge you own, load balancers.** Four hardcoded hostnames, resolved by the OS. No proxy, no edge layer, no origin you operate. See `02`.
- **Your own TLS termination / certificates.** All four providers are HTTPS; trust is fully delegated to the OS/platform trust store. You terminate nothing. See `04`.
- **CORS.** Build-time runs in Node (no same-origin policy). Runtime runs in React Native (no browser, no CORS preflight). The spec's *proposed* Next.js web app would face CORS; the app as built does not. See `05`.
- **Authentication on the wire.** Three of four providers are keyless. Only Google Elevation takes an API key, and it's a URL query param (`pipeline/elevation.ts:72`), not a header — and it's the non-default provider. See `04` and `05`.

## Cross-links

- `.aipe/study-system-design/` — owns the build-time-vs-runtime split as an *architecture* decision; this guide owns what crosses the wire in each.
- `.aipe/study-distributed-systems/` — owns rate limits and partial failure as *general* correctness problems; this guide grounds them in flattr's actual `fetch` calls.
- `.aipe/study-runtime-systems/` — owns the event loop, `setTimeout`-as-sleep, and the async execution model the retries and the busy-lock ride on.
