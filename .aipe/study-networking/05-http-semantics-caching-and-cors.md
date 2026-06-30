# HTTP semantics, caching, and CORS

**Industry name(s):** HTTP methods/status semantics · application caching · CORS. **Type:** Industry standard.

## Zoom out, then zoom in

This is where flattr's networking code actually *lives*. Everything below TLS was
delegated; here flattr makes real choices — POST vs GET, which headers, how it reads
status codes, and an application-level cache that's the single biggest lever on request
volume. CORS, by contrast, is **not exercised** in either runtime, and this chapter
explains exactly why.

```
  Zoom out — the HTTP layer is flattr's real network code

  ┌─ flattr code ───────────────────────────────────────────┐
  │  ★ method (POST/GET) · headers (UA, content-type) ★      │ ← THIS CONCEPT
  │  ★ status-code branching (res.ok / 429 / 5xx) ★          │
  │  ★ application cache: elevCache (AsyncStorage) ★          │
  └───────────────────────────────┬──────────────────────────┘
                                  │ over TLS (04) over TCP (03)
  ┌─ Runtime fetch ───────────────▼──────────────────────────┐
  │  serializes request line + headers + body, parses response│
  └───────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **HTTP semantics**: the verbs, status codes, and headers flattr
chooses, plus the cache it layers on top and the CORS rule that never fires. This is the
chapter where flattr stops delegating and starts deciding.

## The structure pass

**Layers.** Request shape (method/headers/body) → response handling (status branching) →
application cache in front of it.

**Axis traced: which HTTP semantics does flattr *rely on* for correctness?**

```
  Axis: "which HTTP semantic is load-bearing?"

  ┌─ method choice ───────────┐  POST for Overpass (body too big for URL)
  │  GET for elevation/geocode │  GET = cacheable, idempotent reads
  └──────────┬─────────────────┘
  ┌─ status branching ────────▼┐  res.ok vs RETRYABLE set vs throw
  │  drives retry/fallback      │  ← THE load-bearing semantic
  └──────────┬─────────────────┘
  ┌─ app cache ───────────────▼┐  flattr's own cache, NOT HTTP cache headers
  │  AsyncStorage by DEM cell   │
  └────────────────────────────┘
```

**Seam.** The seam is `res.ok` / `res.status` — the boundary where an HTTP status code
becomes a flattr control-flow decision (return, retry, or throw). An axis flips there:
the server's *report* of what happened becomes flattr's *behavior*. That branch is where
`07`'s retry logic attaches.

## How it works

### Move 1 — the mental model

You know `fetch` returns a `Response` with `.ok`, `.status`, and a `.json()` body. flattr's
whole HTTP layer is a disciplined version of that: pick the right verb, send the headers
the API requires, branch on the status code, and cache the expensive responses yourself.
The pattern is **request-shape → status-branch → app-cache**.

```
  The pattern — flattr's HTTP request lifecycle

  build request ─► fetch ─► res.ok? ──yes──► parse JSON ─► (cache it)
                              │
                              └──no──► status in RETRYABLE? ─yes─► backoff+retry (07)
                                       │
                                       └──no──► throw
```

### Move 2 — the step-by-step walkthrough

**Method choice is driven by payload size, not habit.** Overpass uses POST; the other two
use GET. The reason is concrete: the Overpass *query* is a multi-line QL program too big
and too special-charactered to jam into a URL, so it goes in a form-encoded body. Elevation
and geocode are simple reads with short params, so GET.

```
  pipeline/overpass.ts:30-40 — POST because the body is a program
  ┌──────────────────────────────────────────────────────────────┐
  │ const body = "data=" + encodeURIComponent(buildOverpassQuery) │
  │ await fetchImpl(endpoint, {                                    │
  │   method: "POST",                                             │
  │   headers: {                                                  │
  │     "Content-Type": "application/x-www-form-urlencoded",  ◄── │ form-encode the QL
  │     "User-Agent": "flatr/0.1 (grade-aware routing graph…)",◄─ │ OSM policy
  │   },                                                          │
  │   body,                                                       │
  │ });                                                           │
  └──────────────────────────────────────────────────────────────┘
```

Contrast elevation — a GET with params in the query string (`elevation.ts:106`):
```
  https://api.open-meteo.com/v1/elevation?latitude=<lats>&longitude=<lngs>
                                          └─ comma-joined batch in the URL ─┘
```
A GET works here because ≤100 points (`OPEN_METEO_BATCH`, `elevation.ts:85`) fit the URL.
Push past the URL length limit and you'd be forced to POST — the batch cap is partly an
HTTP-semantics constraint.

**The required header is a politeness contract, not a technical one.** Every call sends a
`User-Agent` identifying flattr. Overpass and especially Nominatim's usage policies
*require* it — an anonymous request can be rejected. The Nominatim policy also caps you at
~1 req/s, which shapes the UI (see below and `07`).

```
  pipeline/geocode.ts:21-24 — required UA + status check
  ┌──────────────────────────────────────────────────────────────┐
  │ const res = await fetchImpl(`${ENDPOINT}?${params}`, {        │
  │   headers: { "User-Agent": "flattr/0.1 (grade-aware routing)" }│ ◄ Nominatim requires
  │ });                                                           │   a UA or it 403s
  │ if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);│ ◄ no retry — throws
  └──────────────────────────────────────────────────────────────┘
```

**Status-code branching is the load-bearing semantic — and it differs per client.** This
is the one place all three clients diverge, because each API's status meanings differ:

```
  Status handling, per client — the divergence is intentional

  Overpass  (overpass.ts:18,41-46):
    res.ok          → return JSON
    429/502/503/504 → retry (RETRYABLE set), linear backoff
    other non-2xx   → throw

  Open-Meteo (elevation.ts:110-118):
    res.ok          → return JSON
    429 ONLY        → retry, EXPONENTIAL backoff
    other non-2xx   → throw immediately

  Nominatim (geocode.ts:24):
    res.ok          → return JSON
    ANY non-2xx     → throw (NO retry at all)
```

Why three different curves? Overpass servers shed load with 5xx under heavy queries, so
flattr retries the whole `RETRYABLE` set. Open-Meteo's only transient signal is 429
(quota), so flattr retries *only* that. Nominatim's ~1 req/s policy means a 429 is "you
broke the rule" — retrying would make it worse, so flattr throws and lets the UI's
debounce prevent the 429 in the first place. The status branch *is* the API's failure
contract showing through. `07` walks the backoff math.

**The application cache is flattr's own — it is NOT HTTP cache headers.** flattr does not
read `Cache-Control`, `ETag`, or `Expires` from any response. Instead it keeps a
hand-rolled persistent cache keyed by DEM cell, because DEM elevation values *never
change* — so they're cacheable forever, no validation needed.

```
  mobile/src/elevCache.ts — flattr's own cache, no HTTP semantics involved
  ┌──────────────────────────────────────────────────────────────┐
  │ const STORAGE_KEY = "flattr.elevCache.v1";  // AsyncStorage    │
  │ export function putElev(key, value) {                         │
  │   if (mem.has(key)) return;        // ◄ never re-fetch a cell  │
  │   mem.set(key, value); dirty = true;                          │
  │   persistTimer ??= setTimeout(persistNow, 4000); // batched    │
  │ }                                                             │
  │  // "DEM samples never change, so cached values valid forever" │
  └──────────────────────────────────────────────────────────────┘
```

The cache sits *in front of* the elevation fetch in `useTileGraph.ts` — `cachedElevation`
(`useTileGraph.ts:38-62`) checks `getElev(cellKey(...))` per point and only fetches the
misses. Cache-hits cost **zero** HTTP requests. This is the single biggest lever on
request volume and the main defense against 429 (`elevCache.ts:1-4`). It's an
*application* cache making an *HTTP* request-rate problem disappear.

```
  Layers-and-hops — cache short-circuits the HTTP layer

  ┌─ useTileGraph ─┐ getElev(cell)  ┌─ elevCache (AsyncStorage) ─┐
  │ cachedElevation│ ──────────────►│  hit? → value, NO fetch    │
  │                │ ◄──────────────│  miss? → collect for batch  │
  │                │                └────────────────────────────┘
  │   only misses ─┼─ GET ──────────────────────► Open-Meteo
  └────────────────┘  (the fewer the better — that's the point)
```

**CORS: not yet exercised — and here's exactly why.** CORS is a *browser* enforcement: a
JS app on origin A calling origin B triggers a preflight/`Access-Control-*` dance. flattr
has **no browser runtime**. Build-time is Node (no origin concept). Runtime is React
Native, whose `fetch` is a native networking call, **not** subject to browser same-origin
policy. So no preflight ever fires for any of the three APIs.

```
  Why CORS never fires in flattr

  ┌─ Node (build) ─┐   no "origin" exists      → no CORS
  ┌─ React Native ─┐   native fetch, not a     → no CORS
  │                │   browser sandbox
  └────────────────┘
  CORS would ONLY appear in the spec's proposed Next.js WEB app
  (docs/flattr-spec.md §8) — which this repo did NOT build
```

The honest note: the *spec* proposes a Next.js + MapLibre web app, and **that** would hit
CORS the moment its browser JS called Overpass/Nominatim from a page origin (both APIs do
send permissive CORS headers, but a web build would have to care). The repo as built
sidesteps CORS entirely by not being a browser.

### Move 3 — the principle

HTTP is where flattr stops delegating and starts deciding, and the load-bearing decision
is **how a status code becomes behavior** — that single branch carries each API's failure
contract. The cache lesson generalizes too: when a resource is immutable (DEM samples),
the cheapest "networking" optimization isn't an HTTP cache header, it's *not making the
request at all*. The principle: **read the status code as the server's contract, and treat
the cheapest request as the one you never send.**

## Primary diagram

```
  flattr HTTP layer — request shape, status branch, app cache, no CORS

  ┌─ flattr HTTP code ─────────────────────────────────────────┐
  │  METHOD:  POST (Overpass, body=QL) · GET (elev, geocode)    │
  │  HEADERS: User-Agent (required) · Content-Type (form-enc)   │
  │  STATUS:  res.ok → parse ; RETRYABLE → backoff ; else throw │
  │           └─ Overpass {429,5xx} · Meteo {429} · Nominatim ∅ │
  │  CACHE:   elevCache (AsyncStorage, DEM cell) — flattr's own, │
  │           NOT Cache-Control/ETag ; cache-hit = 0 requests   │
  │  CORS:    not exercised (Node + RN have no browser origin)  │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

HTTP's verbs and status codes are a contract: GET is a safe idempotent read, 429 means
"slow down," 5xx means "my problem, maybe retry." flattr reads that contract precisely and
differently per API — which is what good HTTP client code looks like. The cache choice
(application-level, immutable-forever, persistent) is the kind of decision that only makes
sense once you know the *domain*: DEM values can't change, so HTTP validation headers would
be wasted ceremony. Where this grows: a first-party web app would force CORS into the
picture and might make HTTP `Cache-Control` worthwhile for mutable resources. Read `07`
next — it takes the status-branch from this chapter and builds the full retry/backoff
machine on top of it.

## Interview defense

**Q: Why POST for Overpass but GET for the other two?**
> Payload. The Overpass query is a multi-line QL program — too big and special-charactered
> for a URL — so it's form-encoded in a POST body (`overpass.ts:30`). Elevation and geocode
> are short-param reads, so GET. The elevation batch cap of 100 (`elevation.ts:85`) is
> partly a URL-length constraint — push past it and you'd be forced to POST too.

```
  big/complex body ⇒ POST ; short read ⇒ GET (until URL length forces POST)
```
> Anchor: *method follows payload, not convention.*

**Q: How does flattr cache, and is it HTTP caching?**
> No — it's an application cache, not HTTP cache headers. flattr keeps a persistent
> AsyncStorage map keyed by ~90m DEM cell (`elevCache.ts`), valid forever because DEM
> values never change. Cache-hits cost zero requests; it's the main defense against
> Open-Meteo 429s. flattr reads no `Cache-Control`/`ETag` at all.

```
  immutable resource ⇒ skip the request entirely ⇒ cheapest cache = no fetch
```
> Anchor: *the cache makes a rate-limit problem disappear by not sending the request.*

**Q: Does flattr deal with CORS?**
> Not yet exercised. Node (build) has no origin; React Native's `fetch` is native, not a
> browser sandbox — so no preflight fires. CORS would only appear if the spec's proposed
> Next.js *web* app were built, which this repo didn't.

```
  no browser runtime ⇒ no same-origin policy ⇒ no CORS
```
> Anchor: *CORS is browser-enforced; flattr has no browser.*

## See also

- `04-tls-and-trust-establishment.md` — the User-Agent vs cert identity distinction.
- `07-timeouts-retries-pooling-and-backpressure.md` — the retry machine built on the status branch.
- `study-security` — trusting third-party JSON bodies; User-Agent is unverified.
- `study-performance-engineering` — the cache as a throughput/cost lever.
