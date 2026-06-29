# Networking — Overview

flattr's networking surface is small, honest, and entirely **outbound HTTP over the platform `fetch`**. There is no server, no socket you own, no realtime channel. Three free third-party APIs are the whole network story, and they all sit at one of two altitudes: **build-time** (Node, run once to bake `graph.json`) and **runtime** (the Expo app, fetched live as you pan and route).

Let's put the whole thing on one map before any single concept.

```
  flattr — the entire on-the-wire surface

  ┌─ BUILD TIME (Node, `npm run build:graph`) ───────────────────────┐
  │                                                                  │
  │  pipeline/run-build.ts                                           │
  │     │                                                            │
  │     ├─► fetchOverpass()      POST  overpass-api.de    (OSM ways) │
  │     └─► openMeteoProvider()  GET   api.open-meteo.com (elevation)│
  │                                                                  │
  │  output: data/graph.json  ──baked──►  mobile/assets/graph.json   │
  └──────────────────────────────────────────────────────────────────┘
                                 │ bundled, no network at app launch
                                 ▼
  ┌─ RUNTIME (Expo / React Native app) ──────────────────────────────┐
  │                                                                  │
  │  MapScreen.tsx                                                    │
  │     ├─► geocode / geocodeSuggest / reverseGeocode                │
  │     │        GET  nominatim.openstreetmap.org   (address↔coord)  │
  │     │                                                            │
  │  useTileGraph.ts  (live coverage on top of the bundled graph)    │
  │     ├─► fetchOverpass()      POST overpass-api.de    (live OSM)  │
  │     └─► openMeteoProvider()  GET  api.open-meteo.com (live elev) │
  │              │                                                   │
  │              └─► elevCache.ts  AsyncStorage  (persistent cache)  │
  └──────────────────────────────────────────────────────────────────┘
```

Three providers, two of them reused across both altitudes. That reuse is the cleanest thing about the design: `fetchOverpass` and `openMeteoProvider` are the same functions whether Node runs them at build time or React Native runs them live (`pipeline/overpass.ts:21`, `pipeline/elevation.ts:92`).

## Verdict-first — what's actually here

- **Everything is `fetch`.** No axios, no undici, no `ws`, no `node-fetch`. Zero HTTP libraries in either `package.json`. TLS, DNS, and connection pooling are all delegated to the platform (Node's undici / RN's native networking stack). You configure none of it.
- **Three retry curves, deliberately different.** Overpass uses linear backoff on `{429,502,503,504}` (`overpass.ts:18,44`); Open-Meteo uses exponential backoff on `429` only (`elevation.ts:114`); Nominatim and geocode have **no retry at all** — a failed status just throws (`geocode.ts:24`). The shape of each curve is driven by the free-tier rate-limit policy of that specific API, not by a shared helper.
- **The cache is the rate-limit strategy.** The single largest design force is "don't get 429'd by free APIs." The answer is a persistent elevation cache (`elevCache.ts`) plus a same-cell dedup (`elevation.ts:42`) plus one-build-at-a-time serialization (`useTileGraph.ts:166`). Volume reduction, not retry tuning, is what keeps flattr under quota.
- **No client timeout anywhere.** This is the sharpest risk. Not a single `fetch` is wrapped in `AbortController`/`AbortSignal`. A hung Overpass connection hangs the build (or the pump's one busy slot) until the OS gives up — minutes, not seconds. Ranked #1 in the red-flags audit.

## Ranked findings (full evidence in `08-networking-red-flags-audit.md`)

```
  rank  finding                              where               severity
  ────  ───────────────────────────────────  ──────────────────  ────────
  1     no request timeout on any fetch      all 3 API modules   high
  2     no jitter → retry stampede risk      overpass/elevation  medium
  3     unbounded suggest debounce in flight geocode via UI      low-med
  4     no Retry-After header honored        overpass/elevation  low-med
  5     cache has no integrity/version guard elevCache.ts        low
```

## Reading order

```
  00  overview .................. you are here
  01  network-map ............... the full path + every boundary
  02  dns-routing-and-addressing  names → addresses → which host
  03  tcp-udp-connections ....... sockets, transport, lifecycle
  04  tls-and-trust ............. HTTPS, certs, who terminates
  05  http-semantics-caching .... methods, status, headers, the cache
  06  websockets-sse-streaming .. realtime  → NOT YET EXERCISED
  07  timeouts-retries-pooling .. the retry curves + the missing timeout
  08  red-flags-audit ........... ranked risks with evidence
```

## not yet exercised — say it plainly

- **Realtime transports** (WebSocket / SSE / long-polling / streaming bodies): none. flattr is request/response only. `06` explains when they'd become relevant and what they'd replace.
- **Connection pooling control**: not exercised. The platform pools under the hood; flattr never touches a keep-alive setting, a max-sockets value, or an HTTP/2 multiplexing knob. Covered in `07`.
- **DNS / proxy / edge config**: none. No CDN, no reverse proxy, no custom resolver. Three public hostnames, resolved by the OS. Covered in `02`.
- **CORS / cookies**: not exercised. No browser origin policy applies (Node + native RN, not a web page), and no API sets or reads a cookie. Covered in `05`.

## Cross-links to sibling guides

- **`.aipe/study-system-design/`** — WHERE these network boundaries sit in the architecture (build-time vs runtime split, the baked-artifact seam).
- **`.aipe/study-security/`** — WHETHER each outbound call is safe (User-Agent identity, no secrets on the free APIs, the Google key path).
- **`.aipe/study-performance-engineering/`** — the cache hit-rate, batching, and debounce as latency/throughput levers.
- **`.aipe/study-distributed-systems/`** — partial failure across three independent external services and the best-effort degradation.
