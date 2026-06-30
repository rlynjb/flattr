# DNS, routing, and addressing

**Industry name(s):** name resolution / DNS / origin addressing. **Type:** Industry standard.

## Zoom out, then zoom in

Every one of flattr's three arrows starts with the same invisible step: turning a
hostname like `overpass-api.de` into an IP address the OS can open a socket to. flattr
writes **zero** code for this. It hands a `https://…` string to `fetch` and the runtime,
then the OS, does the rest.

```
  Zoom out — where addressing sits, below everything flattr writes

  ┌─ flattr code ───────────────────────────────────────────────┐
  │  const url = "https://api.open-meteo.com/v1/elevation?…"     │
  │  await fetch(url)            ← flattr stops here             │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ hands the hostname down
  ┌─ Runtime (Node undici / RN) ──▼──────────────────────────────┐
  │  ★ resolve "api.open-meteo.com" → A/AAAA record ★            │ ← THIS CONCEPT
  └───────────────────────────────┬──────────────────────────────┘
                                  │ IP address
  ┌─ OS resolver + network ───────▼──────────────────────────────┐
  │  stub resolver → recursive DNS → root/TLD/authoritative      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **DNS resolution and origin addressing**: the hostname-to-IP
lookup that precedes the TCP connect on every call. In flattr it is **fully delegated** —
which is the correct posture for an HTTP client, but worth understanding because it's a
hidden latency and failure source flattr can neither see nor control.

## The structure pass

**Layers.** Resolution is a stack flattr sits on top of:
- **flattr:** a hardcoded hostname inside a URL string.
- **runtime:** `fetch` extracts the host and asks the OS to resolve it.
- **OS:** stub resolver, `/etc/hosts` / cache, then a recursive resolver upstream.

**Axis traced: who decides the address, and can flattr see it?**

```
  Axis: "who controls the name→address mapping?"

  ┌─ flattr ──────────────┐   flattr picks the NAME ("overpass-api.de")
  │  hardcoded hostname    │   but NOT the address it resolves to
  └──────────┬─────────────┘
  ┌─ OS/DNS ─▼─────────────┐   the resolver + DNS owners pick the ADDRESS
  │  resolves to an IP      │   flattr has zero visibility or override
  └────────────────────────┘
  the name is flattr's; the address is the internet's
```

**Seam.** The seam is `fetch(hostname)` → OS. An axis flips: flattr controls the *name*,
the world controls the *address*. flattr has no code on the OS side of that seam — no
custom resolver, no `/etc/hosts` override, no DNS-over-HTTPS config, no proxy.

## How it works

### Move 1 — the mental model

You know how typing a URL in a browser "just works" — you never think about the IP. Same
here: flattr names a host, the runtime resolves it. The pattern is a **lookup table you
don't own**: name in, address out, cached by TTL somewhere you can't see.

```
  The pattern — resolution flattr delegates entirely

  "overpass-api.de"
        │  (flattr supplies the name)
        ▼
  ┌─ resolver (OS) ─┐  cache hit? → return IP
  │  TTL-cached map  │  cache miss? → walk root→TLD→authoritative
  └────────┬─────────┘
           ▼
     93.184.x.x  (an address flattr never sees in code)
```

### Move 2 — the step-by-step walkthrough

**The hostname is the only addressing flattr writes.** Three constants, three hosts —
that's the entire addressing surface.

```
  flattr's complete addressing surface — three hardcoded origins

  pipeline/overpass.ts:4    "https://overpass-api.de/api/interpreter"
  pipeline/elevation.ts:106 "https://api.open-meteo.com/v1/elevation?…"
  pipeline/geocode.ts:5     "https://nominatim.openstreetmap.org/search"
```

Here's the actual Overpass constant, annotated — note there is **no IP, no port, no
resolver config**, just a name:

```
  pipeline/overpass.ts:4
  ┌──────────────────────────────────────────────────────────────┐
  │ const DEFAULT_ENDPOINT =                                      │
  │   "https://overpass-api.de/api/interpreter";                  │
  │    └─https─┘ └── hostname ──┘ └── path ──┘                    │
  │      │           │                                            │
  │      │           └─ the ONLY thing flattr controls about      │
  │      │              addressing — the name to resolve          │
  │      └─ scheme implies port 443; resolution + connect are     │
  │         the runtime's job, not flattr's                       │
  └──────────────────────────────────────────────────────────────┘
```

**The endpoint is injectable, but the host is not parameterized for failover.**
`fetchOverpass` takes `endpoint` as an argument (`overpass.ts:23`) — but that exists so
**tests** can point at a fake, not so flattr can fail over to a mirror Overpass server.
There are public Overpass mirrors (`overpass.kumi.systems`, `lz4.overpass-api.de`); flattr
uses exactly one and does **not** rotate to a backup on failure. That's a deliberate
simplicity tradeoff: when the one host is down, flattr's retry (`07`) just backs off
against the same dead address rather than resolving a different one.

**Resolution happens once per connection, invisibly, on every hop.** When
`useTileGraph.ts:186` calls `fetchOverpass(bbox)`, the runtime resolves `overpass-api.de`
before it can open a socket. flattr never sees this; it's pure latency that shows up
inside the `await`.

```
  Layers-and-hops — what fetch does with the name before flattr's code resumes

  ┌─ flattr ──────┐ "resolve overpass-api.de" ┌─ OS resolver ─┐
  │ await fetch() │ ─────────────────────────►│  cache / DNS   │
  │  (suspended)  │ ◄───────────────────────── │  → 1.2.3.4     │
  └───────────────┘   IP returned, THEN connect└────────────────┘
            │ resolution latency is hidden inside the await
            ▼ (only now does TCP/TLS begin — see 03, 04)
```

**No proxy, no edge, no CDN flattr owns.** A grep for proxy/agent/resolver config across
`pipeline/`, `mobile/src/`, `lib/` finds nothing. There is no edge layer between flattr
and the three origins — the requests go straight from device/Node to the public API hosts.
The only "edge" in the picture belongs to the API providers (Overpass and Nominatim sit
behind their own infrastructure), and flattr sees only the published hostname.

### Move 3 — the principle

Delegating DNS is the right call for an HTTP client — you don't reimplement the resolver.
But "delegated" is not "free": resolution is latency you can't profile from your own code,
and a single hardcoded host with no failover means a DNS or origin outage is
unrecoverable at flattr's layer. The principle: **know which parts of the path you've
delegated, because you can't add a timeout or a fallback to a layer you've handed away** —
which is exactly the gap `07` and `08` flag.

## Primary diagram

```
  flattr addressing — name flattr owns, address it doesn't

  ┌─ flattr (build + runtime) ────────────────────────────────┐
  │  hardcoded hostnames:                                      │
  │   overpass-api.de · api.open-meteo.com · nominatim.osm.org │
  └─────────────────────────────┬──────────────────────────────┘
                                │ fetch(name)
  ┌─ Runtime → OS resolver ─────▼──────────────────────────────┐
  │  resolve A/AAAA → IP   (TTL-cached, flattr-invisible)       │
  │  NO custom resolver · NO proxy · NO host failover           │
  └─────────────────────────────┬──────────────────────────────┘
                                │ IP
  ┌─ Public internet ───────────▼──────────────────────────────┐
  │  one origin per host, no flattr-owned edge/CDN              │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

DNS is the oldest piece of this stack and the one most invisible to application code. The
reason flattr can ignore it is that `fetch` (Node's undici, or React Native's networking
bridge) wraps the whole getaddrinfo → connect sequence. Where it *would* matter: if flattr
added a self-hosted tile/elevation service, you'd suddenly own a hostname, its DNS records,
and possibly a CDN in front — and DNS TTLs would become a deploy concern. For now, the
honest statement is **flattr exercises addressing only as a consumer of names it hardcodes.**
Read `03` next: once the name is an address, a TCP connection opens.

## Interview defense

**Q: How does flattr handle DNS?**
> It doesn't — and that's correct. It hardcodes three hostnames and lets the runtime/OS
> resolve them. No custom resolver, no DNS-over-HTTPS, no proxy. The cost is zero
> visibility into resolution latency and no host failover: one hardcoded Overpass host,
> no rotation to a mirror on outage.

```
  flattr: name ──► [OS resolver, delegated] ──► IP ──► connect
```
> Anchor: *flattr owns the name, the internet owns the address.*

**Q: What breaks if `overpass-api.de` goes down or its DNS fails?**
> flattr's retry/backoff (`overpass.ts:42`) keeps hitting the same dead host — backoff
> against a corpse. There's no failover because the `endpoint` parameter exists for test
> injection, not production failover. A second hardcoded mirror host would fix it.

```
  one host down → retry same host → still down → throw
  (no second address to try)
```
> Anchor: *single hardcoded origin = a DNS/host outage is unrecoverable at flattr's layer.*

## See also

- `01-network-map.md` — where each hostname sits on the map.
- `04-tls-and-trust-establishment.md` — what happens after the address resolves (TLS).
- `07-timeouts-retries-pooling-and-backpressure.md` — backoff against a single host.
- `study-security` — trusting a hostname you don't control.
