# Study — Networking (flattr)

What actually happens on the wire in flattr, where it can fail, and which protocol semantics the code relies on. flattr's network surface is small: **three free third-party APIs over the platform `fetch`**, at two altitudes (build-time Node + runtime Expo/RN). No backend, no realtime, no HTTP libraries.

## Reading order

```
  00  overview ......................... repo-grounded map + ranked findings
  01  network-map ..................... the full path + every boundary (start here)
  02  dns-routing-and-addressing ...... names → addresses → which host
  03  tcp-udp-connections-and-sockets . transport, sockets, lifecycle
  04  tls-and-trust-establishment ..... HTTPS, certs, termination
  05  http-semantics-caching-and-cors . methods, status, headers, the caches
  06  websockets-sse-streaming ........ realtime  → NOT YET EXERCISED
  07  timeouts-retries-pooling ........ the retry curves + the missing timeout
  08  networking-red-flags-audit ...... ranked risks with evidence
```

Read `00` then `01` for orientation. `02`–`04` are short (transport/TLS/DNS are all delegated to the platform). `05` and `07` are the meat — HTTP semantics and the resilience machinery. `06` is honestly empty (no realtime). `08` ranks what's wrong.

## The three APIs, at a glance

```
  API          host                         method  retry curve        used at
  ───────────  ───────────────────────────  ──────  ─────────────────  ─────────────
  Overpass     overpass-api.de              POST    linear, 4 codes    build + runtime
  Open-Meteo   api.open-meteo.com           GET     exponential, 429   build + runtime
  Nominatim    nominatim.openstreetmap.org  GET     none (throws)      runtime (UI)
  (Google      maps.googleapis.com          GET     none, key-gated    build, opt-in)
```

Files: `pipeline/overpass.ts`, `pipeline/elevation.ts`, `pipeline/geocode.ts`, `mobile/src/useTileGraph.ts`, `mobile/src/elevCache.ts`.

## Top findings

1. **No request timeout anywhere** (HIGH) — zero `AbortController`; a hung fetch jams the runtime single-flight gate until the OS TCP timeout fires. See `08` R1 / `07`.
2. **The cache is the rate-limit strategy** — persistent AsyncStorage cache + same-cell dedup + single-flight gate beat retry tuning as the throttle defense. See `07` / `05`.
3. **Three deliberately different retry curves** — each matched to its API's real failure modes (Overpass 502/503/504 under load; Open-Meteo 429 quota; geocode harmless, no retry). See `05` / `07`.

## not yet exercised

Realtime transports (WebSocket/SSE/streaming, `06`), connection-pool control (`07`), DNS/proxy/edge config (`02`), CORS/cookies (`05`). Each file explains when its absent topic becomes relevant.

## Cross-links to sibling guides

- `.aipe/study-system-design/` — WHERE the network boundaries sit (build-time/runtime split)
- `.aipe/study-security/` — WHETHER each outbound call is safe (User-Agent, Google key)
- `.aipe/study-performance-engineering/` — cache/dedup/debounce as latency-throughput levers
- `.aipe/study-distributed-systems/` — partial failure across three independent external services
- `.aipe/study-debugging-observability/` — how a hung request surfaces (or doesn't)
- `.aipe/study-ai-engineering/` — LLM token streaming (SSE) as the next realtime pattern to learn
