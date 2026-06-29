# 04 — TLS and Trust Establishment

**Encryption in transit, certificates, termination** · *Industry standard*

## Zoom out, then zoom in

Every flattr URL is `https://`. That single character `s` is the whole TLS story: it tells `fetch` to do a TLS handshake before sending any HTTP, so the bytes are encrypted and the server's identity is verified against the OS trust store. flattr writes the `s` and trusts the platform for everything after it.

```
  Zoom out — where TLS sits in the request

  ┌─ App ──────────────────────────────────────────────┐
  │  fetch("https://...")   ← the "s" requests TLS      │ ← we are here
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ TCP (from 03) ────────▼───────────────────────────┐
  │  socket open on port 443                            │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ ★ TLS (OS / platform) ★ ──────────────────────────┐
  │  handshake · cert verify vs OS trust store · cipher │
  └────────────────────────┬───────────────────────────┘
                           │ encrypted channel
  ┌─ HTTP ─────────────────▼───────────────────────────┐
  │  request/response, now confidential + authenticated │
  └────────────────────────────────────────────────────┘
```

Zoom in: flattr's only TLS decision is *use HTTPS for all four hosts* — which it does, with zero exceptions. There is no certificate pinning, no custom CA, no `rejectUnauthorized: false`, no mutual TLS. The handshake, the cert chain validation, and the termination all happen below flattr's floor, in the platform.

## Structure pass

**Layers.** Scheme choice (flattr) → handshake + cert verify (platform) → trust store (OS). flattr lives only in the top layer.

**Axis = trust (who verifies the server is who it claims?).** The OS does, against its built-in CA store. flattr neither supplies a CA nor overrides verification. Trace the axis and it's flat across flattr's code — flattr makes *one* trust decision (HTTPS, so verify) and then trusts the platform to enforce it.

```
  axis traced: who verifies the server's certificate?

  ┌─ flattr ───────────────┐  seam  ┌─ OS / platform ───────────┐
  │ decides: use HTTPS      │ ══╪══► │ verifies cert vs CA store │
  │ (implies verification)  │ flips  │ rejects bad/expired certs │
  └────────────────────────┘        └───────────────────────────┘
```

**Seam.** The `https://` scheme in the URL is the trust seam. Above it, flattr's decision to encrypt-and-verify. Below it, the platform's enforcement. flattr cannot weaken or strengthen what's below — there's no pinning code and no verification bypass, which is the correct default.

## How it works

### Move 1 — the mental model

You've seen the lock icon in a browser. That lock is a completed TLS handshake: the client and server agreed on a cipher, and the client verified the server's certificate chains up to a CA it trusts. flattr gets the same lock on every API call for free, because `https://` plus a platform `fetch` runs that handshake automatically. flattr's job is just to never *opt out* of it — and it never does.

```
  Pattern — the TLS handshake, run by the platform per host

  flattr: fetch("https://api.open-meteo.com/...")
                │
                ▼  (platform, once per fresh connection)
   ClientHello ──────────────────────────────► server
   server cert + ServerHello ◄────────────────
   verify cert vs OS CA store ──┐
        │ valid                  │ invalid → fetch REJECTS (throws)
        ▼                        ▼
   key exchange ──► encrypted    flattr's catch{} handles it
   HTTP now flows confidentially
```

The handshake happens once per fresh TCP connection and is amortized across reused connections (the keep-alive from `03`). flattr never triggers it explicitly — it's a side effect of the first `fetch` to each host.

### Move 2 — walk the trust facts

**Fact 1 — all four hosts are HTTPS, no exceptions.** Every endpoint constant uses `https://`:

```
  https://overpass-api.de/api/interpreter        overpass.ts:4
  https://api.open-meteo.com/v1/elevation         elevation.ts:106
  https://maps.googleapis.com/maps/api/elevation  elevation.ts:72
  https://nominatim.openstreetmap.org/search      geocode.ts:5
```

No `http://` anywhere in the network code (confirmed by grep). So every byte — including the user's typed address going to Nominatim and the Google API key going to Google — travels encrypted.

**Fact 2 — cert verification is the platform default, untouched.** There is no TLS configuration in the repo: no `rejectUnauthorized`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no custom `https.Agent` with a CA bundle, no `ca:` option, no pinning library. This means the platform's *default* verification is in force — the OS trust store validates each server's cert chain, and a bad/expired/mismatched cert makes `fetch` throw, which flattr's `try/catch` handles as a normal failure.

```
  Layers-and-hops — where a cert failure surfaces in flattr

  ┌─ OS TLS ────────────┐ hop: bad cert → reject
  │ verify fails        │ ─────────────────────────┐
  └─────────────────────┘                          ▼
  ┌─ platform fetch ────┐                  throws / rejects Promise
  │ Promise rejects     │ ─────────────────────────┐
  └─────────────────────┘                          ▼
  ┌─ flattr ────────────┐          catch {} → build degrades / route errors
  │ overpass.ts:46 throw │          (same path as any network failure)
  │ useTileGraph:219 catch                          
  └──────────────────────┘
```

A TLS failure isn't special-cased — it lands in the same `catch` as a 500 or a dropped connection. At build time it propagates and fails the build (`run-build.ts:54`); at runtime it degrades the region (`useTileGraph.ts:219`).

**Fact 3 — termination is at the provider, flattr terminates nothing.** flattr has no server, so there's no TLS termination point flattr owns — no nginx, no load balancer offloading TLS, no cert flattr presents. Each connection terminates at the provider's own edge (Overpass's server, Open-Meteo's CDN, Nominatim's infra). flattr is purely a TLS *client*, never a server. *(Inference about provider-side edge architecture; flattr-side fact is certain — no server exists.)*

**Fact 4 — the User-Agent identity is sent inside the encrypted channel.** Each request includes a `User-Agent` header identifying flattr (`overpass.ts:38`, `geocode.ts:22`, etc.). Because the channel is TLS, that identity — and on the Google path, the API key in the query string (`elevation.ts:72`) — is confidential in transit. That's the one place TLS does real work for flattr's security posture: the Google key never travels in cleartext. *(Security depth on the key lives in `.aipe/study-security/`; here the point is only that TLS protects it on the wire.)*

### Move 2.5 — current vs future

**Now:** TLS as a pure client, platform-verified, no pinning. **If flattr added cert pinning:** it would harden the provider calls against a compromised CA, at the cost of breakage when a provider rotates certs — high-maintenance for free public APIs that rotate on their own schedule. Not worth it here. **If flattr grew a backend:** flattr would become a TLS *server* too, and termination (where TLS ends — at a load balancer or the app) would become a real architecture decision. Neither is exercised today.

### Move 3 — the principle

For a client-only app hitting public APIs, "use `https://` and don't override verification" is the complete and correct TLS posture. Pinning and custom CAs are hardening you add only when you control both ends or face a specific threat model. Adding them speculatively trades a real maintenance cost for a benefit you can't yet use. flattr's restraint here is the right call.

## Primary diagram

The full TLS picture — flattr's one decision, the platform's enforcement, where failures land.

```
  flattr TLS — one decision, delegated enforcement

  ┌─ flattr decides ────────────────────────────────────────┐
  │  https:// on all 4 hosts  ·  no verification override     │
  │  no pinning · no custom CA · no mutual TLS                │
  └────────────────────────┬─────────────────────────────────┘
                           │ the "s" requests TLS
  ┌─ platform enforces (OS trust store) ────────────────────┐
  │  handshake → cert chain verify → cipher → encrypted HTTP │
  │  bad cert → Promise rejects                              │
  └────────────────────────┬─────────────────────────────────┘
                           │ rejection
  ┌─ flattr handles ────────▼────────────────────────────────┐
  │  build time: throws, build fails (run-build.ts:54)       │
  │  runtime: catch → degrade region (useTileGraph.ts:219)   │
  └──────────────────────────────────────────────────────────┘
     not exercised: pinning · custom CA · mTLS · TLS termination
                    (flattr owns no server)
```

## Elaborate

The interesting thing about TLS in a no-backend app is how *little* there is to do and how easy it is to do wrong anyway — the classic mistake is `rejectUnauthorized: false` to "make the cert error go away" during development, which silently disables the entire point of TLS. flattr has none of that, which is worth noting precisely because it's the common foot-gun. When the AI-engineering pivot adds an LLM provider, the same rule holds: HTTPS, platform verification, and the provider key protected by the channel — never a verification bypass to unblock a demo.

## Interview defense

**Q: How does flattr verify it's actually talking to Open-Meteo and not a man in the middle?**
The `https://` scheme triggers a TLS handshake where the platform verifies Open-Meteo's certificate against the OS trust store; flattr overrides nothing, so a forged or mismatched cert makes `fetch` reject and lands in the normal `catch`. flattr writes the `s` and trusts the platform for the rest. Anchor: *one decision — HTTPS, no override.*

**Q: Where does flattr terminate TLS?**
Nowhere — flattr owns no server and is a TLS client only. Each connection terminates at the provider's own edge. The User-Agent identity and (on the Google path) the API key ride inside the encrypted channel, so they're confidential in transit. Anchor: *client-only; termination is the provider's, not flattr's.*

## See also

- `03-tcp-udp-connections-and-sockets.md` — the TCP connection TLS rides on
- `02-dns-routing-and-addressing.md` — resolving the name before the handshake
- `.aipe/study-security/` — the Google API key handling and trust-boundary depth
