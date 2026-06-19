# 05 — HTTP semantics, caching, and CORS
### methods, status codes, headers, caching, cookies, CORS, and browser policy
**Industry name:** HTTP application semantics — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

This is the layer where flattr makes actual choices. Below it (TCP, TLS, DNS) flattr just takes platform defaults. At the HTTP layer, flattr decides methods, sends specific headers, and *reads status codes to drive control flow* — the 429 that triggers a retry is an HTTP decision. This is the richest networking layer in the repo.

```
  Zoom out — where HTTP semantics sit

  ┌─ App / Build layer ──────────────────────────────┐
  │  ★ flattr chooses: method, headers, status logic ★│ ← we are here
  │  fetch(url, { method, headers, body })            │
  │  if (res.ok) ... if (res.status === 429) retry    │
  └─────────────────────────┬─────────────────────────┘
  ┌─ TLS layer ──────────────▼────────────────────────┐
  │  encrypts the HTTP request/response               │
  └────────────────────────────────────────────────────┘
```

Zoom in: HTTP semantics is "what method, what headers, and what does this status code *mean for my control flow?*" flattr uses GET and POST, sends a `User-Agent` (and one `Content-Type`), and branches on `res.ok` and specific status codes. There's no caching layer flattr owns, no cookies, and no CORS in the app as built.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** Request shaping (method + headers + body) → Response handling (status code → control flow) → Body parsing (`.json()`). One axis runs through all three.

**Axis — failure (where does it originate, propagate, get contained?).** Status codes are *the* failure signal at this layer:

```
  Axis "how is failure signaled and handled?" — across HTTP handling

  ┌──────────────────────────────────────────────────┐
  │ Request: shaped politely (UA header)              │ → pre-empts failure
  └──────────────────────────────────────────────────┘
      ┌──────────────────────────────────────────────┐
      │ Status: res.ok? 429? 5xx?                     │ → FAILURE DECISION
      └──────────────────────────────────────────────┘
          ┌──────────────────────────────────────────┐
          │ Body: .json() — assumed well-formed       │ → unchecked
          └──────────────────────────────────────────┘

  the status-code check is where failure becomes a control-flow branch
```

**Seams.** The load-bearing seam is `res.ok` / `res.status`. Above it the request is just bytes going out; at this seam the response's status code becomes a *decision* — return the body, retry, or throw. Every provider module flips behavior here, and they flip it *differently* (Overpass retries a status set, Open-Meteo retries only 429, Nominatim retries nothing). That divergence is the most interesting thing at this layer.

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how you check `if (res.ok)` after a `fetch` and branch on it — success path vs error path? flattr does exactly that, but the *error* branch is where the intelligence lives: a 429 means "back off and retry," a 5xx means "transient, retry," a 4xx means "my request is wrong, give up." The status code isn't just an error flag; it's a routing instruction for what to do next.

```
  Pattern — status code drives the next move

   fetch ──► response
              │
        ┌─────┴───────────────────────┐
        │ res.ok (2xx)?               │ → parse body, return
        │ status in RETRYABLE set?    │ → sleep, retry
        │ status === 429?             │ → back off, retry
        │ everything else (4xx)       │ → throw, give up
        └─────────────────────────────┘
```

#### Move 2 — walking the HTTP semantics

**Methods: GET for reads, POST for the one big query.** Overpass is the only POST in the codebase (`pipeline/overpass.ts:34`) — because the Overpass QL query is large and goes in the request body as form-encoded data, not the URL. Everything else is GET: elevation, geocoding, reverse-geocoding, tiles. The method choice is semantic, not arbitrary: GET for idempotent reads with params in the URL, POST when the "query" is a body too big or structured for a query string.

```
  Method inventory

  POST  overpass-api.de/api/interpreter   body: data=<QL query>
  GET   api.open-meteo.com/v1/elevation   params in query string
  GET   nominatim.../search · /reverse    params in query string
  GET   tiles.openfreemap.org/...         MapLibre fetches
```

**Headers: the polite-client headers, deliberately.** flattr sends two kinds of request headers, both load-bearing for being a good guest on free APIs:

- **`User-Agent`** on Overpass (`pipeline/overpass.ts:37`) and Nominatim (`pipeline/geocode.ts:22`, `:48`, `:65`). This isn't cosmetic — Nominatim's usage policy *requires* an identifying User-Agent and will block requests without one. flattr sends `"flattr/0.1 (grade-aware routing)"`. Drop it and Nominatim can 403 you.
- **`Content-Type: application/x-www-form-urlencoded`** on the Overpass POST (`pipeline/overpass.ts:36`) — because the body is form-encoded `data=...`, and Overpass parses the QL out of that field.

```
  Layers-and-hops — the headers that matter

  ┌─ flattr ─────┐  POST + UA + Content-Type   ┌─ Overpass ──────┐
  │ fetchOverpass│ ──────────────────────────► │ needs form body │
  │              │                              └─────────────────┘
  │ geocode      │  GET + User-Agent            ┌─ Nominatim ─────┐
  │              │ ──────────────────────────► │ REQUIRES UA or  │
  │              │                              │ 403s you        │
  └──────────────┘                              └─────────────────┘
```

**Status codes drive control flow — and each module reads them differently.** This is the part to internalize. Three modules, three status-handling policies:

```
  Status-handling policy per provider

  Overpass    res.ok → return · {429,502,503,504} → retry · else → throw
  Open-Meteo  res.ok → return · 429 ONLY → retry      · else → throw
  Nominatim   res.ok → return · anything else → throw (NO retry)
  Google      json.status !== "OK" → throw (a BODY field, not HTTP status!)
```

Note the Google oddity: it returns HTTP 200 with an error *in the JSON body* (`json.status !== "OK"`, `pipeline/elevation.ts:77`), so flattr checks the body status, not the HTTP status. That's a real API-semantics trap — a 200 that isn't a success — and flattr handles it correctly by inspecting the body.

**Body parsing assumes well-formed JSON.** Every module calls `await res.json()` and immediately uses the shape (`pipeline/overpass.ts:41`, `pipeline/elevation.ts:111`, `pipeline/geocode.ts:25`). There's no schema validation, no try/catch around the parse. If a provider returned a 200 with an HTML error page (which Overpass mirrors sometimes do under load), `.json()` throws and the error propagates up — caught by the retry loop's caller or `useTileGraph`'s try/catch, but not specifically handled.

**Caching: none flattr owns; one cache flattr leans on by accident.** flattr sets no `Cache-Control`, reads no `ETag`, stores no response cache. The *only* caching is the build-time bake: `graph.json` is effectively a permanent cache of the Overpass+elevation responses, but it's a file flattr writes, not HTTP caching. The elevation dedup (`dedupePrecision`, `pipeline/elevation.ts:42-50`) is a *request-collapsing* optimization — multiple nodes in one DEM cell share one query — which is cache-like but happens before the request, not on the response.

**Cookies: none.** No `Set-Cookie` is read, no cookie is sent, no session. Every request is stateless and anonymous (except Google's URL key).

**CORS: not exercised — and correctly so.** CORS is a *browser* same-origin policy. flattr runs in two non-browser environments: Node at build time (no same-origin policy at all) and React Native at runtime (a native runtime, no browser, no CORS preflight). So no `OPTIONS` preflight, no `Access-Control-*` headers, no CORS errors — ever. The spec's *proposed* Next.js web frontend (`docs/flattr-spec.md` §8) would hit CORS the moment it called Overpass/Nominatim from browser JS; the app as built sidesteps it entirely by not being a browser.

```
  Comparison — CORS: built vs proposed

  AS BUILT (RN + Node)          PROPOSED (Next.js web, spec §8)
  ──────────────────            ─────────────────────────────
  no browser → no CORS          browser fetch → preflight OPTIONS
  direct fetch to provider      provider must send Access-Control-*
  works today                   OR proxy through your own server
```

#### Move 3 — the principle

The status code is a protocol-level instruction, not just an error flag — `429` says "back off," `503` says "I'm overloaded, try later," `400` says "fix your request." Reading them precisely is what separates a polite, resilient client from one that hammers a struggling server or gives up on a transient blip. flattr reads them precisely in two of four modules; the inconsistency (Nominatim's zero-retry, the two backoff curves) is the thing to clean up.

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The full HTTP-semantics picture — request shaping, the status-code decision, body parsing.

```
  flattr HTTP semantics — request → status decision → body

  ┌─ Request shaping (flattr decides) ─────────────────────────┐
  │  GET (reads) or POST (Overpass QL body)                    │
  │  headers: User-Agent (Overpass, Nominatim) ·               │
  │           Content-Type (Overpass POST)                     │
  └────────────────────────────┬───────────────────────────────┘
                               │  over HTTPS
  ┌─ Response: STATUS-CODE DECISION (the seam) ─▼──────────────┐
  │  res.ok → parse + return                                   │
  │  429 → back off + retry (Overpass, Open-Meteo)             │
  │  5xx → retry (Overpass only)                               │
  │  4xx / other → throw                                       │
  │  Google: HTTP 200 but body status !== OK → throw           │
  └────────────────────────────┬───────────────────────────────┘
                               │
  ┌─ Body parse ─▼─────────────────────────────────────────────┐
  │  await res.json() — assumed well-formed, no schema check   │
  └─────────────────────────────────────────────────────────────┘
   no flattr-owned cache · no cookies · no CORS (non-browser runtime)
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** HTTP semantics are reached on every call. The decisions are most visible in the Overpass fetch (method, headers, status-driven retry all in one function) and the Google body-status check (a 200-isn't-success case).

**Request shaping + status decision in one place** — `pipeline/overpass.ts` (lines 32-47):

```
  pipeline/overpass.ts  (lines 32-47)

  const res = await fetchImpl(endpoint, {
    method: "POST",                                ← POST: QL too big for URL
    headers: {
      "Content-Type": "application/x-www-form-urlencoded", ← form body
      "User-Agent": "flatr/0.1 (...)",             ← polite-client identity
    },
    body,                                          ← "data=" + encoded QL
  });
  if (res.ok) return (await res.json()) ...;       ← 2xx → parse + return
  if (RETRYABLE.has(res.status) && attempt < retries) { ← 429/5xx → retry
    await sleep(delayMs * (attempt + 1));
    continue;
  }
  throw new Error(`Overpass request failed: ${res.status}`); ← else give up
        │
        └─ every HTTP decision lives here: method, headers, status branch.
           RETRYABLE = {429,502,503,504} is the set that means "transient"
```

**A 200 that isn't success** — `pipeline/elevation.ts` (lines 75-78):

```
  pipeline/elevation.ts  (lines 75-78)

  const res = await fetchImpl(url);
  const json = (await res.json()) as { status: string; results: ... };
  if (json.status !== "OK")                        ← check BODY status,
    throw new Error(`Google Elevation API: ${json.status}`); │ not HTTP status
        │
        └─ Google returns HTTP 200 even on quota/auth errors; the real
           status is in the body. Checking res.ok alone would miss it.
           This is the API-semantics trap flattr handles correctly.
```

**Nominatim's zero-retry — the inconsistency** — `pipeline/geocode.ts` (lines 21-25):

```
  pipeline/geocode.ts  (lines 21-25)

  const res = await fetchImpl(`${ENDPOINT}?${params}`, {
    headers: { "User-Agent": "flattr/0.1 (...)" },  ← UA: required by Nominatim
  });
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`); ← throw, no retry
        │
        └─ one shot. A transient 429/503 here fails the geocode outright,
           unlike Overpass/Open-Meteo which retry. The caller (MapScreen)
           catches and shows "not found" — see 07 for the consequence
```

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

The HTTP status code vocabulary is the original distributed-systems failure protocol — `4xx` = "you (client) messed up, don't retry," `5xx` = "I (server) messed up, retrying might help," `429` = "you're going too fast." flattr's retry sets encode exactly that semantics: it retries `5xx` and `429` (server-side / rate) but not `4xx` (client-side, retrying won't help). The general theory of which failures are retryable — idempotency, transient vs permanent — lives in `.aipe/study-distributed-systems/`. The thing flattr gets right is *not* retrying 4xx; the thing it gets inconsistent is *which* transient codes each provider retries and *how* it backs off (`07`).

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "Walk me through how you handle HTTP status codes."**

Answer: "Status code drives control flow. 2xx, I parse and return. For Overpass I retry a set — 429, 502, 503, 504 — because those are transient or rate-limit signals; for Open-Meteo I retry only 429. Anything 4xx I throw immediately, because retrying a client error won't fix it. The trap I handle is Google Elevation: it returns HTTP 200 even on errors, with the real status in the body, so I check `json.status`, not `res.ok`. The gap is consistency — Nominatim has no retry at all, and my two retrying modules use different backoff curves."

```
  2xx → parse · 429/5xx → retry · 4xx → throw
  Google: 200 + body.status !== OK → throw (200 isn't success)
  gap: Nominatim no retry; two backoff curves
```

Anchor: *the status code is a protocol instruction — 4xx vs 5xx tells you whether retrying can possibly help.*

**Q: "Do you have to worry about CORS?"**

Answer: "No — and that's a property of the runtime, not luck. CORS is a browser same-origin policy. flattr builds in Node and runs in React Native; neither is a browser, so there's no preflight and no `Access-Control` requirement. The catch is that the spec proposes a Next.js web frontend — the moment that calls Overpass or Nominatim from browser JS, it'd hit CORS and need either provider CORS headers or a proxy. The native app sidesteps it entirely."

```
  RN + Node = no browser = no CORS
  proposed web app = browser fetch = CORS preflight problem
```

Anchor: *CORS is a browser policy; flattr isn't a browser, so it's not exercised — but the proposed web version would face it.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** Which method does each provider use and why is Overpass the only POST? (`pipeline/overpass.ts:34`)
2. **Explain:** Why does flattr check `json.status` instead of `res.ok` for Google Elevation? (`pipeline/elevation.ts:77`)
3. **Apply:** Nominatim starts returning transient 503s under load. Trace what happens today (`pipeline/geocode.ts:24`) and what you'd change to match the Overpass policy.
4. **Defend:** Why is it correct that flattr retries 5xx but not 4xx? What would break if you retried 400s?

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `07-timeouts-retries-pooling-and-backpressure.md` — the retry/backoff mechanics behind the status branches.
- `04-tls-and-trust-establishment.md` — the API key header/param and where it can leak off the wire.
- `08-networking-red-flags-audit.md` — the unchecked `.json()` parse and the retry inconsistency, ranked.
- `.aipe/study-distributed-systems/` — retryable-vs-not as a general correctness problem.
