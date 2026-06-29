# 02 — DNS, Routing, and Addressing

**Name resolution, hosts, proxies, edge layers** · *Industry standard*

## Zoom out, then zoom in

Every `fetch` in flattr starts with a hostname, and a hostname is not an address — something has to turn `api.open-meteo.com` into an IP before a packet can leave the device. flattr does none of that work itself. It hands a URL string to `fetch` and the OS does the rest.

```
  Zoom out — where addressing sits in the request path

  ┌─ App code ───────────────────────────────────────┐
  │  fetch("https://api.open-meteo.com/v1/elevation") │ ← we are here
  └───────────────────────┬──────────────────────────┘
                          │ hostname string
  ┌─ ★ Resolution (OS / platform) ★ ─────────────────┐
  │  DNS lookup: name ──► IP   (getaddrinfo / native) │
  └───────────────────────┬──────────────────────────┘
                          │ IP + port 443
  ┌─ Network / routing (OS, ISP, internet) ──────────┐
  │  TCP connect ──► route to the provider's host     │
  └──────────────────────────────────────────────────┘
```

Zoom in: the only addressing decisions flattr makes are *which hostnames to use* — three of them, all hard-coded constants — and *what query/body to attach*. Resolution, routing, and edge layering are entirely the platform's job. So this concept is mostly "here's the three names, here's who owns turning them into addresses, here's what flattr does NOT control."

## Structure pass

**Layers.** Name → address → route. flattr lives only in the top layer (it picks names); the OS owns the bottom two.

```
  Layers — addressing, and who owns each layer

  ┌─ flattr owns ───────────────────────────────────┐
  │  the hostname constants + the URL/query/body     │
  └───────────────────────┬─────────────────────────┘
                          │ everything below is delegated
  ┌─ OS / platform owns ────────────────────────────┐
  │  DNS resolution · connection · routing · retry-  │
  │  of-resolution · happy-eyeballs (IPv4/IPv6)      │
  └─────────────────────────────────────────────────┘
```

**Axis = control (who decides the address?).** Trace it: flattr decides the *name*, the OS decides the *IP*, the provider's infrastructure decides which *backend* serves it. Three different deciders, and flattr is only the first.

**Seam.** The load-bearing boundary is the **URL string handed to `fetch`**. Above it, flattr's concern (correct host, correct query encoding). Below it, the platform's concern (resolution, connection). flattr cannot see or influence anything below that seam — no custom resolver, no `/etc/hosts` override in code, no DNS cache TTL control.

## How it works

### Move 1 — the mental model

You've typed a URL into `fetch` a thousand times. The hostname in that URL is a *name*, and names don't route — addresses do. Between your `fetch` call and the first byte leaving the device, the platform runs a name→address translation you never see. flattr's entire DNS story is: pick good names, encode the query correctly, and trust the OS for the lookup.

```
  Pattern — the hostname is the only DNS decision flattr makes

  "api.open-meteo.com"   ← flattr writes this (a name)
          │
          │  OS resolver (not flattr's code)
          ▼
   104.x.x.x : 443       ← OS produces this (an address)
          │
          ▼
   route over the internet to Open-Meteo's edge
```

### Move 2 — the three names and how they're addressed

**The three hostnames are hard-coded constants.** No env-var indirection, no service discovery, no config server. Each lives as a module constant:

```
  overpass-api.de       pipeline/overpass.ts:4   DEFAULT_ENDPOINT
  api.open-meteo.com    pipeline/elevation.ts:106 (inline in URL)
  maps.googleapis.com   pipeline/elevation.ts:72  (Google, key-gated)
  nominatim.openstreetmap.org  pipeline/geocode.ts:5,55  ENDPOINT / REVERSE_ENDPOINT
```

The Overpass endpoint is the only one parameterized — `fetchOverpass(bbox, endpoint = DEFAULT_ENDPOINT, ...)` lets a caller swap to a mirror (`overpass.ts:22`). That's the closest flattr comes to "routing": picking which Overpass mirror to resolve. It's never actually overridden in the app; the default always wins.

**Query construction is flattr's real addressing work.** For the GET APIs, the meaningful part is the query string, built two different ways:

```ts
// geocode.ts:14 — URLSearchParams: encodes spaces, &, etc. correctly
const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
// ...
const res = await fetchImpl(`${ENDPOINT}?${params.toString()}`, { headers: {...} });
```

`URLSearchParams` is the right tool — it percent-encodes the user's address string so a query like `5th & Pine` doesn't break the URL. Contrast the elevation API, which joins coordinates into the URL by hand:

```ts
// elevation.ts:104-106 — manual join; safe only because lat/lng are numbers
const lats = batch.map((p) => p.lat).join(",");
const lngs = batch.map((p) => p.lng).join(",");
const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
```

This is safe *only because* lats/lngs are numbers, never user text — no encoding needed. If a user string ever reached this path it would be an injection risk; it never does. The Google adapter does encode (`encodeURIComponent` at `elevation.ts:72`) because it's the same pattern but stays defensive.

**Resolution and routing: delegated, invisible.** There is no DNS code in the repo — confirmed: no custom resolver, no IP literals, no `lookup` option passed to `fetch`. On Node (build time) resolution goes through undici/`getaddrinfo`; on React Native (runtime) it goes through the native networking stack (NSURLSession on iOS, OkHttp on Android). flattr sees none of it. *(Inference, from the absence of any resolver code and the platform defaults — not from an explicit config.)*

```
  Layers-and-hops — name to first byte, who owns each hop

  ┌─ flattr ──┐ hop1: hand URL string   ┌─ platform fetch ──┐
  │ build URL │ ──────────────────────► │ parse host        │
  └───────────┘                         └─────────┬─────────┘
                          hop2: resolve name      ▼
                                        ┌─ OS resolver ─────┐
                                        │ name ──► IP (DNS) │
                                        └─────────┬─────────┘
                          hop3: TCP/TLS connect   ▼
                                        ┌─ provider edge ───┐
                                        │ serves the bytes  │
                                        └───────────────────┘
```

### Move 2.5 — current vs future

**Now:** three public names, OS-resolved, no edge layer flattr owns. **If flattr grew a backend:** it would gain a fourth name (its own API), and *that* is where DNS/routing decisions would start to matter — a CDN in front, a health-checked origin, maybe a custom resolver for the provider calls to fail over between Overpass mirrors. None of that exists yet, and for a no-backend app it shouldn't. The `endpoint` parameter on `fetchOverpass` is the one seam already in place for mirror failover if it's ever needed.

### Move 3 — the principle

Hard-coding three public hostnames is the right call for an app with no backend and no edge layer. The moment to add indirection (env vars, service discovery) is when a name changes per environment — dev/staging/prod. flattr has one environment (the user's device hitting public APIs), so a constant is honest. Adding config indirection now would be complexity with nothing behind the seam.

## Primary diagram

The complete addressing picture — what flattr decides vs what's delegated.

```
  flattr addressing — decided vs delegated

  ┌─ DECIDED by flattr (in code) ───────────────────────────┐
  │  3 hostname constants  ·  query via URLSearchParams      │
  │  (geocode)  ·  query via string-join (elevation, numbers)│
  │  1 swappable endpoint param (Overpass mirror)            │
  └────────────────────────┬────────────────────────────────┘
                           │ URL string crosses the seam
  ┌─ DELEGATED to platform (no flattr code) ────────────────┐
  │  DNS resolution · IPv4/IPv6 selection · routing ·        │
  │  connection reuse · resolver caching/TTL                 │
  └─────────────────────────────────────────────────────────┘
       not exercised: CDN · reverse proxy · custom resolver ·
                      service discovery · multi-region routing
```

## Elaborate

DNS is the layer everyone forgets until it's the outage. flattr's exposure is real but not in its control: if `overpass-api.de` has a DNS or routing problem, every build and every live tile fails, and flattr's only defense is the `endpoint` parameter (manual mirror swap) plus the runtime's degrade-to-cached behavior. The deeper lesson for the AI-engineering pivot: when you add a vector DB or an LLM provider, *that* hostname becomes a single point of failure with the same shape, and the move is the same — keep the endpoint swappable, and degrade gracefully when resolution fails.

## Interview defense

**Q: How does flattr resolve `api.open-meteo.com` to an IP?**
It doesn't — it hands the URL to `fetch` and the platform resolver does the lookup (undici on Node at build time, native stack on RN at runtime). There's no resolver code in the repo. flattr's only addressing decision is the hostname constant and the query encoding. Anchor: *flattr picks names; the OS picks addresses.*

**Q: A user types an address with an ampersand. Does the URL break?**
No, because `geocodeSuggest`/`geocode` build the query with `URLSearchParams` (`geocode.ts:14,41`), which percent-encodes it. The elevation path joins values into the URL by hand (`elevation.ts:106`) and is safe only because those are numbers, never user text. Anchor: *user text → URLSearchParams; numbers → safe to join.*

## See also

- `04-tls-and-trust-establishment.md` — what happens after the name resolves (the 443 handshake)
- `07-timeouts-retries-pooling-and-backpressure.md` — the `endpoint` param as the mirror-failover seam
- `05-http-semantics-caching-and-cors.md` — the methods and query semantics per host
