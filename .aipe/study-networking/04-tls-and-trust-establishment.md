# TLS and trust establishment

**Industry name(s):** TLS / HTTPS / certificate trust. **Type:** Industry standard.

## Zoom out, then zoom in

Every flattr endpoint is `https://`. That single letter `s` means a TLS handshake runs on
top of the TCP connection from `03` before any request bytes flow — certificate exchange,
validation against the OS trust store, key agreement. flattr writes **zero** TLS code. It
gets encryption-in-transit and server-identity verification by typing `https`.

```
  Zoom out — TLS sits between TCP and HTTP, owned by the runtime

  ┌─ flattr code ───────────────────────────────────────────┐
  │  "https://overpass-api.de/…"   ← the 's' is the whole    │
  │  await fetch(url)                 TLS opt-in flattr makes │
  └───────────────────────────────┬──────────────────────────┘
  ┌─ Runtime + OS TLS library ────▼──────────────────────────┐
  │  ★ ClientHello · cert chain · validate vs trust store ★  │ ← THIS CONCEPT
  │  ★ key exchange · encrypted channel ★                    │
  └───────────────────────────────┬──────────────────────────┘
  ┌─ TCP (from 03) ───────────────▼──────────────────────────┐
  │  the reliable byte stream TLS encrypts                    │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **trust establishment**: proving the server on the other end of
`overpass-api.de` really is Overpass, and encrypting everything after. In flattr it is
**fully delegated to the OS/runtime trust store** — no pinning, no custom CA, no cert
code. The lesson is *what that delegation buys and what it leaves open.*

## The structure pass

**Layers.** flattr (a URL scheme) → runtime TLS library → OS trust store.

**Axis traced: trust — who decides the server is who it claims to be?**

```
  Axis: "who validates the server's identity?"

  ┌─ flattr ──────────────┐  decides only to USE https
  │  scheme = "https"      │  (and supplies a User-Agent string)
  └──────────┬─────────────┘
  ┌─ runtime ▼─────────────┐  runs the handshake, checks the cert
  │  TLS library            │  chain, hostname, expiry
  └──────────┬─────────────┘
  ┌─ OS ─────▼─────────────┐  owns the root CA trust store the
  │  trust store (root CAs) │  cert chains up to
  └────────────────────────┘
  flattr trusts whoever the OS trusts — no narrowing, no pinning
```

**Seam.** The seam is `https://` → runtime TLS. The trust axis flips hard: above it
flattr asserts nothing about identity; below it the runtime validates the full chain
against the OS roots. flattr places **total** trust in the OS root store and does not
narrow it — no certificate pinning anywhere in the repo.

## How it works

### Move 1 — the mental model

You know the browser padlock — green means "this is really the site, and the channel is
encrypted." flattr gets the exact same padlock, programmatically, by using `https`. The
pattern is **identity-then-encryption**: prove who you're talking to *first* (cert
validation), then encrypt everything (key exchange). flattr opts into both with one
character and validates none of it itself.

```
  The pattern — TLS handshake, all run by the runtime

  flattr: fetch("https://…")
        │  ClientHello ───────────────────────►
        │  ◄─────────── ServerHello + certificate chain
        │  validate chain vs OS trust store  (runtime, not flattr)
        │  validate hostname + expiry        (runtime, not flattr)
        │  key exchange ─────────────────────►
        │  ◄═══════ encrypted application data ═══════►
        │  request bytes now flow, encrypted
  flattr: await resolves
```

### Move 2 — the step-by-step walkthrough

**flattr's entire TLS surface is three `https` schemes.** That's the opt-in. There is no
TLS config object, no `rejectUnauthorized`, no CA bundle, no pinned fingerprint anywhere.

```
  flattr's complete TLS surface — three scheme prefixes

  pipeline/overpass.ts:4     https://overpass-api.de/…
  pipeline/elevation.ts:106  https://api.open-meteo.com/…
  pipeline/geocode.ts:5      https://nominatim.openstreetmap.org/…
                             ▲
                             every endpoint is https — never http
```

**The User-Agent header is identity flattr asserts about *itself* — not TLS.** Don't
confuse the two. flattr sends a `User-Agent` on every call (`overpass.ts:37`,
`geocode.ts:22`). That's flattr telling the server who *it* is (a courtesy the OSM
policies require). TLS is the server proving who *it* is to flattr. Opposite directions:

```
  Two identity directions — don't conflate them

  ┌─ flattr ─┐  User-Agent: "flattr/0.1…"  ──►  ┌─ server ─┐
  │          │  (app identity, plaintext header) │          │
  │          │  ◄── TLS certificate ──────────── │          │
  └──────────┘  (server identity, validated)     └──────────┘
     flattr asserts its name; the server PROVES its name
```

The `User-Agent` is *unverified* — anyone can send `flattr/0.1`. The cert is *verified* —
the runtime checks it chains to a trusted root. Only one of these is trust establishment;
the other is just politeness (`05`). `study-security` owns whether the User-Agent matters.

**Trust termination is at the API providers' own edge — flattr can't see past it.** When
the TLS handshake with `overpass-api.de` succeeds, the encrypted channel terminates at
*Overpass's* server (or its load balancer/CDN). What Overpass does behind that —
re-encrypt to a backend, talk plaintext internally — flattr neither knows nor controls.
flattr's trust ends at the published hostname's cert.

```
  Layers-and-hops — where TLS terminates (flattr's visibility ends)

  ┌─ flattr ─┐ encrypted TLS ┌─ Overpass edge ─┐  ??? ┌─ Overpass ─┐
  │ device/  │ ═════════════►│  cert flattr     │ ────►│  backend   │
  │ Node     │ ◄═════════════│  validated here  │ ◄─── │            │
  └──────────┘               └──────────────────┘      └────────────┘
       flattr's trust boundary ENDS at the edge cert ▲
       anything past it is invisible and uncontrolled
```

**No pinning means flattr trusts the whole OS root store — broad, and a known tradeoff.**
Because flattr pins nothing, any cert chaining to any root the OS trusts is accepted for
these hosts. That's the normal posture for a client calling public APIs (you *can't* pin
a public API you don't operate without breaking on their cert rotation). The cost: if a CA
in the OS store is compromised or a device has a corporate MITM root installed, flattr's
traffic is interceptable and flattr would never notice. **Certificate pinning is not yet
exercised** — and for these three public APIs, that's the right call, not a bug. It would
only become wrong if flattr called a *first-party* backend, where pinning is feasible.

### Move 3 — the principle

Using `https` buys two things in one character: a verified server identity and an
encrypted channel — both run by the runtime against the OS trust store. The discipline is
knowing where your trust *terminates*: at the published hostname's edge cert, not at the
provider's backend. The principle: **TLS proves you're talking to the name you typed, not
that the thing behind the name is trustworthy** — which is exactly why `study-security`
treats the third-party JSON these channels carry as untrusted input, even over a perfect
TLS connection.

## Primary diagram

```
  flattr TLS — one-character opt-in, fully delegated validation

  ┌─ flattr ──────────────────────────────────────────────────┐
  │  scheme = "https"  (the entire TLS decision)               │
  │  User-Agent header = flattr's OWN identity (unverified)    │
  └──────────────────────────────┬─────────────────────────────┘
                                 │ seam: https → runtime TLS
  ┌─ Runtime + OS trust store ───▼─────────────────────────────┐
  │  handshake · cert-chain validation · hostname · expiry     │
  │  trusts ALL OS root CAs · NO pinning · NO custom CA         │
  └──────────────────────────────┬─────────────────────────────┘
  ┌─ Provider edge ──────────────▼─────────────────────────────┐
  │  TLS terminates here — flattr's visibility ends at the cert │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

TLS is the layer that made the public web safe to transact on; for an API client it's
nearly free to use and nearly impossible to get *more* secure than the OS trust store
without pinning (which public APIs make impractical). flattr's posture — `https`
everywhere, no pinning — is the correct default for a consumer of public third-party APIs.
The interesting frontier is the one flattr doesn't have: a first-party backend, where
you'd own both ends of the TLS connection and pinning becomes a real option. Read `05`
next: now that the channel is encrypted and the server identified, the actual HTTP request
— methods, headers, status codes — flows across it.

## Interview defense

**Q: How does flattr secure its API calls in transit?**
> Every endpoint is `https`, so the runtime runs a full TLS handshake and validates the
> cert chain against the OS trust store — flattr writes no TLS code. Encryption and server
> identity come from one character in the URL. No pinning, no custom CA.

```
  https ⇒ runtime validates cert vs OS roots ⇒ encrypted channel
```
> Anchor: *the 's' in https is flattr's entire TLS implementation.*

**Q: Why no certificate pinning — isn't that less secure?**
> For *these* APIs it's the right call. You can't pin a public API you don't operate
> without breaking on their cert rotation. Pinning only becomes feasible — and worth it —
> if flattr added a first-party backend it controls. Until then, trusting the OS store is
> standard, with the known cost that a compromised/MITM root is undetectable.

```
  public 3rd-party API ⇒ pin impractical ⇒ trust OS store (deliberate)
  first-party backend   ⇒ pin feasible    ⇒ would revisit
```
> Anchor: *pinning fits backends you own, not public APIs you call.*

## See also

- `03-tcp-udp-connections-and-sockets.md` — the TCP connection TLS encrypts.
- `05-http-semantics-caching-and-cors.md` — the request that flows once TLS is up; the User-Agent header.
- `study-security` — whether the trust boundaries are actually safe; treating TLS'd JSON as untrusted.
