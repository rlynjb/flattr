# 05 — HTTP Semantics, Caching, and CORS

**Methods, status codes, headers, caching, CORS** · *Industry standard*

## Zoom out, then zoom in

This is the layer flattr actually writes code against. DNS, TCP, and TLS are all delegated — but the HTTP *method*, the request *body* and *headers*, the interpretation of *status codes*, and the *caching* are all flattr's own decisions, spread across three modules.

```
  Zoom out — HTTP is the layer flattr authors

  ┌─ flattr code ────────────────────────────────────────────┐
  │  ★ chooses method · builds body/headers · reads status ★  │ ← we are here
  │     interprets 429/5xx · caches responses                 │
  └────────────────────────┬─────────────────────────────────┘
                           │ over delegated TLS/TCP/DNS
  ┌─ platform fetch ────────▼────────────────────────────────┐
  │  sends bytes, returns Response{ status, ok, json() }      │
  └────────────────────────┬─────────────────────────────────┘
  ┌─ providers ─────────────▼────────────────────────────────┐
  │  200 / 429 / 5xx + JSON body                              │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: flattr uses exactly two methods (POST for Overpass, GET for everything else), reads two status families (`ok` vs retryable error codes), sends one custom header (User-Agent), and runs **two caches** — but neither is HTTP caching. There are no cookies and no CORS, and the reason why is itself a lesson.

## Structure pass

**Layers.** Method/headers (flattr authors) → status interpretation (flattr authors) → caching (flattr authors, app-level). All three are flattr's, unusually — this is the one concept where flattr is mostly *above* the platform floor.

**Axis = guarantees (what does each status code promise, and how does flattr treat it?).** Trace it: `res.ok` (2xx) → success, parse JSON. `429/502/503/504` → transient, retry. Any other non-ok → fatal, throw. The same status axis produces three different behaviors, and the split is where the contracts live.

```
  axis traced: how does flattr treat each status class?

  ┌─ 2xx ────────┐   ┌─ 429/5xx (set) ─┐   ┌─ other non-ok ─┐
  │ ok → json()  │   │ retry w/ backoff │   │ throw → fatal  │
  └──────────────┘   └──────────────────┘   └────────────────┘
       success            transient              permanent
   each module draws the "retryable" boundary slightly differently → seam
```

**Seam.** The retryable/fatal boundary is the load-bearing seam, and it's drawn *differently per module*: Overpass treats `{429,502,503,504}` as retryable (`overpass.ts:18`); Open-Meteo treats *only* `429` as retryable (`elevation.ts:114`); geocode treats *nothing* as retryable — any non-ok throws immediately (`geocode.ts:24`). Same axis (status → action), three different contracts. That's the seam worth studying.

## How it works

### Move 1 — the mental model

You know `fetch` gives you a `Response` with `.ok`, `.status`, and `.json()`. flattr's whole HTTP semantics layer is a set of decisions about those three: which method to send, what `.status` values to retry vs throw on, and what to do with the parsed `.json()`. Everything is request/response — ask, get an answer, done. No long-lived state, no streaming, no cookies.

```
  Pattern — the request/response decision flattr makes per call

   build request (method + headers + body/query)
                │
                ▼
        await fetch ──► Response
                │
        ┌───────┼────────────────┐
        ▼       ▼                ▼
     res.ok   retryable        other
     parse    backoff+retry    throw
     json()   (per-module set)
```

### Move 2 — walk the HTTP decisions

**Decision 1 — method: POST for Overpass, GET for the rest.** Overpass is the only POST, because Overpass QL queries are large and go in a form-encoded body:

```ts
// overpass.ts:30,33-40 — POST with form-encoded body
const body = "data=" + encodeURIComponent(buildOverpassQuery(bbox));
const res = await fetchImpl(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded",
             "User-Agent": "flatr/0.1 ..." },
  body,
});
```

The `Content-Type: application/x-www-form-urlencoded` and the `data=` prefix are the Overpass API's required shape — the QL query is one big form field. Everything else (elevation, geocode) is a GET with the query in the URL, because those inputs are small (coordinates, an address string).

**Decision 2 — the User-Agent header is mandatory, not optional.** Every request sends a `User-Agent` identifying flattr:

```
  overpass.ts:38    "flatr/0.1 (grade-aware routing graph builder)"
  geocode.ts:22     "flattr/0.1 (grade-aware routing)"
```

This isn't cosmetic. Nominatim's usage policy *requires* a real User-Agent and bounces requests without one (`geocode.ts:2` comment). Overpass and Open-Meteo are friendlier, but flattr identifies itself everywhere as good free-tier citizenship. *(Note the spelling drift — `flatr` in overpass vs `flattr` in geocode; harmless but real, `overpass.ts:38` vs `geocode.ts:22`.)*

**Decision 3 — status interpretation, drawn per module.** This is the seam from the structure pass, in code:

```ts
// overpass.ts:18,42-46 — retryable SET, then throw
const RETRYABLE = new Set([429, 502, 503, 504]);
if (res.ok) return (await res.json()) as OverpassResponse;
if (RETRYABLE.has(res.status) && attempt < retries) { await sleep(...); continue; }
throw new Error(`Overpass request failed: ${res.status}`);
```

```ts
// elevation.ts:110-118 — only 429 retried, else throw
if (res.ok) { json = await res.json(); break; }
if (res.status === 429 && attempt < retries) { await sleep(...); continue; }
throw new Error(`Open-Meteo elevation: ${res.status}`);
```

```ts
// geocode.ts:24 — no retry at all
if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
```

Why the difference? Overpass's public servers commonly return `502/503/504` under load (`overpass.ts:17` comment), so those join the retry set. Open-Meteo's only transient signal is `429` (quota), so that's the only one retried. Geocode is debounced in the UI and a failed suggestion is harmless, so it doesn't bother retrying — it throws and the UI's `catch` ignores it (`MapScreen.tsx:85`). The contract matches the failure mode of each specific API.

**Decision 4 — caching, but NOT HTTP caching.** flattr runs two caches, neither of which uses HTTP cache headers:

```
  cache 1 — in-request dedup (elevation.ts:42-59)
     same ~90m cell → one query, not one per node
     scope: a single sample() call

  cache 2 — persistent elevation cache (elevCache.ts + useTileGraph.ts:38)
     AsyncStorage, survives restarts, keyed by ~90m DEM cell
     scope: the whole app, forever (DEM values never change)
```

There is no `Cache-Control`, no `ETag`, no `If-None-Match`, no `Last-Modified` handling anywhere. flattr ignores HTTP caching entirely and instead does *application-level* caching, because the cache key it cares about (a 90m elevation cell) isn't a URL — many different URLs map to the same cell. HTTP caching keys on the URL; flattr keys on the *semantic* unit. That's why it rolled its own.

```
  Layers-and-hops — cache check before the network, per elevation point

  ┌─ flattr cachedElevation (useTileGraph.ts:38) ──┐
  │ for each point: getElev(cellKey)               │
  │   hit  → use it, NO request                    │
  │   miss → collect into missPts[]                │
  └──────────────────────┬─────────────────────────┘
            hop: only misses cross the network
                         ▼
  ┌─ Open-Meteo ──────────────────────────────────┐
  │  GET elevation for miss cells only             │
  └──────────────────────┬─────────────────────────┘
            hop: results written back
                         ▼
  ┌─ AsyncStorage (elevCache.ts:35 putElev) ───────┐
  │  persist real values (debounced 4s, batched)   │
  └────────────────────────────────────────────────┘
```

**Decision 5 — CORS and cookies: not exercised, and correctly so.** No `fetch` sets `credentials`, no response is read for `Set-Cookie`, no `mode: 'cors'`. CORS is a *browser* same-origin policy; flattr runs in Node (build time) and React Native (runtime), neither of which enforces CORS — there's no browser origin to protect. So flattr never hits a preflight, never needs `Access-Control-Allow-Origin`. *(This is why the spec's proposed Next.js web frontend would change the picture: a browser would suddenly enforce CORS on these same calls. The app as built sidesteps it entirely.)*

### Move 3 — the principle

When your cache key isn't a URL, HTTP caching can't help you — and rolling an application-level cache keyed on the *semantic* unit (here, a DEM cell) is the right move, not a workaround. The deeper rule: match the retry contract to each API's actual failure modes rather than sharing one helper. flattr's three different retryable-status sets look inconsistent until you see each mirrors its API's real behavior.

## Primary diagram

The full HTTP picture — methods, the per-module status seam, the two app-level caches.

```
  flattr HTTP semantics — complete

  ┌─ requests flattr authors ──────────────────────────────────┐
  │  POST overpass  (form body, User-Agent)                     │
  │  GET  open-meteo / nominatim / google  (query, User-Agent)  │
  └────────────────────────┬───────────────────────────────────┘
                           ▼  Response.status
  ┌─ status seam (per module) ─────────────────────────────────┐
  │  Overpass  retry {429,502,503,504}   else throw            │
  │  Open-Meteo retry {429}              else throw            │
  │  Geocode   retry {}                  always throw          │
  └────────────────────────┬───────────────────────────────────┘
                           ▼  on 2xx
  ┌─ app-level caching (NOT HTTP caching) ─────────────────────┐
  │  in-request dedup (cell)  +  persistent AsyncStorage (cell)│
  │  no Cache-Control · no ETag · no cookies · no CORS         │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The absence of HTTP caching here is a feature, not a gap. HTTP caching shines when one URL = one resource you fetch repeatedly. flattr's elevation problem is the opposite: thousands of nearby coordinates collapse to one DEM cell, and that collapse can't be expressed in a URL cache. The app-level cache encodes domain knowledge (90m DEM resolution) that HTTP caching structurally can't. For the AI-engineering pivot, the same pattern recurs: caching LLM responses by *semantic* key (normalized prompt, embedding bucket) beats caching by exact URL/string — same lesson, different layer.

## Interview defense

**Q: Why do the three APIs retry on different status codes?**
Because each set mirrors that API's real failure modes. Overpass's public servers throw `502/503/504` under load, so those are retryable (`overpass.ts:18`); Open-Meteo's only transient signal is quota `429` (`elevation.ts:114`); geocode is debounced and a dropped suggestion is harmless, so it retries nothing and just throws (`geocode.ts:24`). Anchor: *the retryable set is per-API, matched to its actual transient errors.*

**Q: Does flattr use HTTP caching? CORS?**
Neither. It caches at the application level keyed on a 90m DEM cell (`elevCache.ts`), because many URLs map to one cell and HTTP caching keys on the URL. CORS doesn't apply — flattr runs in Node and React Native, not a browser, so there's no same-origin policy to satisfy. Anchor: *semantic-key cache, not URL cache; no browser, no CORS.*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the retry curves behind these status sets, in depth
- `06-websockets-sse-streaming-and-realtime.md` — why responses are read whole, never streamed
- `.aipe/study-performance-engineering/` — the cache hit-rate as a latency/throughput lever
