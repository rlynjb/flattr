# 04 — TLS and trust establishment
### encryption in transit, certificates, trust establishment, and termination points
**Industry name:** TLS / transport security — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

Every `https://` URL in flattr means a TLS handshake happened before any HTTP byte moved — certificate exchange, key agreement, an encrypted channel. flattr does none of this explicitly; it writes `https://` and the platform does the rest. The lesson is short and sharp: flattr terminates no TLS, pins no certificates, and trusts whatever the OS trust store trusts.

```
  Zoom out — where TLS sits

  ┌─ App / Build layer ──────────────────────────────┐
  │  fetch("https://...")   ← the `s` is the whole    │
  │                            decision flattr makes   │
  └─────────────────────────┬─────────────────────────┘
  ┌─ ★ TLS layer (platform: handshake + verify) ★ ───┐
  │  cert chain check vs OS trust store · key exchange│ ← we are here
  │  · encrypt/decrypt the byte stream                │
  └─────────────────────────┬─────────────────────────┘
  ┌─ Transport (TCP) ────────▼────────────────────────┐
  │  the connection TLS rides on                      │
  └────────────────────────────────────────────────────┘
```

Zoom in: TLS is "is this channel encrypted and am I talking to who I think I'm talking to?" In flattr the answer is "yes, because every URL is `https://`, and trust is delegated to the platform's trust store." flattr verifies nothing itself.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** URL scheme (`https://`, flattr's only TLS decision) → TLS session (platform: handshake, cert verification, encryption) → TCP (the connection underneath).

**Axis — trust (who do you trust, and who can tamper?).**

```
  Axis "who establishes trust?" — across the TLS boundary

  ┌─ flattr ───────────┐  TLS handshake  ┌─ provider ───────────┐
  │ writes "https://"  │ ════╪══════════►│ presents a cert chain│
  │ verifies NOTHING   │  (trust est.)   │ signed by a CA       │
  └────────────────────┘                 └──────────────────────┘
            │                                      │
            └─ the OS trust store decides if that ─┘
               cert chain is valid. flattr inherits that decision.

  trust is ESTABLISHED at the handshake, DELEGATED to the platform
```

**Seams.** The seam is the `https://` scheme string. On flattr's side, the only TLS-relevant act is choosing `https` over `http`. Everything past that — which CAs are trusted, whether the cert is expired, whether the hostname matches — flips to the platform trust store. flattr never sees the certificate, never pins it, never overrides verification.

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how a browser shows a padlock and you never think about *why* you trust the site? It's because the cert chains up to a CA the browser already trusts. flattr is the non-browser version: the platform (Node at build, the device at runtime) carries a trust store of CAs, and the TLS handshake either chains to one of them or fails the connection. flattr's whole TLS posture is "use `https`, trust the store."

```
  Pattern — TLS handshake, then encrypted HTTP

   fetch("https://overpass-api.de/...")
        │
        │  TCP connect (port 443)
        │  ── ClientHello ──►
        │  ◄── ServerHello + CERT CHAIN ──
        │  verify chain vs OS trust store   ← platform does this
        │  ── key exchange ──►
        │  ═══ encrypted channel up ═══
        │  send the HTTP request (now encrypted)
        ▼
   Response (decrypted by the platform, handed to flattr as plaintext)
```

#### Move 2 — walking the trust establishment

**Every endpoint is HTTPS.** Check the scheme on all five: `https://overpass-api.de` (`pipeline/overpass.ts:4`), `https://api.open-meteo.com` (`pipeline/elevation.ts:106`), `https://maps.googleapis.com` (`pipeline/elevation.ts:72`), `https://nominatim.openstreetmap.org` (`pipeline/geocode.ts:5`), `https://tiles.openfreemap.org` (`mobile/src/MapScreen.tsx:21`). There is no `http://` anywhere in the network code. So encryption-in-transit is universal — nothing flattr sends crosses the wire in cleartext.

```
  Trust inventory — all HTTPS, all platform-verified

  overpass-api.de            https ✓   verify: OS store
  api.open-meteo.com         https ✓   verify: OS store
  maps.googleapis.com        https ✓   verify: OS store
  nominatim.openstreetmap.org https ✓  verify: OS store
  tiles.openfreemap.org      https ✓   verify: OS store (MapLibre)
  ── no http:// · no cert pinning · no custom CA ──
```

**Trust is fully delegated — no pinning, no custom CA.** flattr does not pin any certificate, does not ship a custom CA bundle, does not set `rejectUnauthorized` or any TLS option. It relies entirely on the platform's default trust chain validation. Inferred consequence: if a provider rotates to a cert signed by a CA the device trusts, flattr keeps working with zero changes — and if a man-in-the-middle presented a cert *not* chaining to a trusted CA, the platform would reject the connection and `fetch` would throw, before flattr sees any data. That's the right default for a client app; pinning would add brittleness (broken on every cert rotation) for marginal benefit against a threat model flattr doesn't face.

**Termination: flattr terminates nothing.** TLS terminates at the *provider's* edge (or their CDN). flattr is purely a TLS *client* on every connection — it never presents a server certificate because it never acts as a server. There's no inbound TLS to terminate because nothing connects to flattr. This is the mirror image of a system where you'd run your own server and manage cert renewal; flattr has zero certificate operational burden.

```
  Layers-and-hops — flattr is always the TLS client

  ┌─ flattr (TLS CLIENT) ─┐  encrypted   ┌─ provider edge (TLS server) ─┐
  │ presents no cert      │ ═══════════► │ presents cert, TERMINATES TLS │
  │ verifies server cert  │ ◄═══════════ │ (their CDN/origin)            │
  └───────────────────────┘              └───────────────────────────────┘
       flattr never terminates TLS · never holds a server cert
```

**The one credential on the wire rides inside TLS.** The Google Elevation API key (`pipeline/elevation.ts:72`) is the only secret flattr ever transmits. It goes as a `&key=` query parameter — which means TLS is doing real work here: the key is encrypted in transit by the HTTPS channel, so it's not visible to a network observer. (It *would* land in provider-side server logs and any proxy that terminates TLS, which is a `05`/secrets concern, not a transit concern — in transit, TLS protects it.) Three of the four default providers send no credential at all.

#### Move 3 — the principle

For a pure client app, TLS is a scheme decision and a trust-store dependency, nothing more. You get encryption and server-identity verification for free by writing `https://` and trusting the platform. The operational cost of TLS — cert issuance, renewal, rotation, pinning maintenance — only appears when you run a *server*, and flattr runs none. The discipline is just: never write `http://`, and let the platform verify.

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The full TLS picture — flattr's one decision, the platform's verification, the provider's termination.

```
  flattr TLS — one decision, fully delegated trust

  ┌─ flattr (decides: https) ──────────────────────────────────┐
  │  every URL is "https://"  ·  the API key rides inside TLS  │
  └────────────────────────────┬───────────────────────────────┘
            https scheme seam   │
  ┌─ Platform (establishes trust) ▼────────────────────────────┐
  │  ClientHello → recv cert chain → verify vs OS trust store  │
  │  → key exchange → encrypted channel.  No pinning, no custom CA│
  └────────────────────────────┬───────────────────────────────┘
            encrypted TCP       │
  ┌─ Provider edge (TERMINATES TLS) ▼──────────────────────────┐
  │  presents cert, decrypts, serves.  flattr never terminates.│
  └─────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** TLS is "reached for" implicitly on every call via the `https://` scheme. The only TLS-adjacent *decision* visible in code is the API key transmission — the one secret that depends on TLS to stay confidential in transit.

**The only credential on the wire** — `pipeline/elevation.ts` (lines 65-75):

```
  pipeline/elevation.ts  (lines 65-75)

  export function googleProvider(apiKey: string, ...) {
    ...
    const url = `https://maps.googleapis.com/maps/api/elevation/json
                  ?locations=...&key=${apiKey}`;   ← key in query string
    const res = await fetchImpl(url);              ← sent over HTTPS
        │
        └─ the `https` means the full URL — INCLUDING ?key= — is encrypted
           on the wire. A network sniffer sees only the encrypted bytes.
           (It IS visible in provider logs; that's a secrets-handling issue,
           covered in 05, not a transit issue. In transit, TLS protects it.)
  }
```

The key as a query param is fine *for transit* precisely because TLS encrypts the whole request line. The thing to flag isn't the wire — it's that query-string secrets tend to leak into logs and `Referer` headers; on the wire itself, it's protected.

**The absence of TLS config — the finding.** A search for `rejectUnauthorized`, `ca:`, `pfx`, `cert`, `pinning`, or any `https.Agent` TLS option across the repo finds nothing. flattr sets no TLS options anywhere. This is correct and `not yet exercised` simultaneously: correct because the platform defaults are what you want for a client, `not yet exercised` because flattr has never had a reason to override them.

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

Certificate pinning — hardcoding which cert/CA a host is allowed to present — is the one TLS hardening that mobile apps sometimes add, to defend against a compromised CA or a corporate MITM proxy. flattr doesn't pin, and it shouldn't: pinning these public OSM endpoints would mean re-shipping the app every time a provider rotates certs, trading real availability for defense against a threat (CA compromise targeting a free elevation API) nobody is mounting. The right posture for a client talking to public infrastructure is exactly what flattr does — `https://` plus platform trust. Where pinning earns its place is high-value targets (banking, your own auth backend), and flattr has neither. The general trust-boundary analysis (is each boundary *safe*?) belongs to `.aipe/study-security/`; this guide only establishes that the channel is encrypted and platform-verified.

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "How does your app handle TLS and certificate verification?"**

Answer: "Every endpoint is `https://`, so everything's encrypted in transit — there's no `http://` in the code. I delegate trust entirely to the platform store: no cert pinning, no custom CA, no TLS options set. flattr is always the TLS client and terminates nothing, because it runs no server. The only secret on the wire is the optional Google Elevation key, and it rides inside the HTTPS channel as a query param, so it's encrypted in transit."

```
  https everywhere → encrypted, no cleartext
  trust: OS store, no pinning (correct for public APIs)
  flattr = TLS client only, terminates nothing
```

Anchor: *for a pure client, TLS is one scheme decision plus a trust-store dependency — no cert ops.*

**Q: "Why don't you pin certificates?"**

Answer: "Pinning would break the app on every provider cert rotation, and the threat it defends against — a compromised CA targeting a free, keyless elevation API — isn't flattr's threat model. The cost (brittleness, re-shipping on rotation) outweighs the benefit. Pinning earns its place against high-value targets like an auth backend; flattr talks to public OSM infrastructure."

Anchor: *pinning trades availability for protection against a threat flattr doesn't face.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** What's the *only* TLS decision flattr makes per request, and where does trust verification actually happen?
2. **Explain:** Why does flattr terminate no TLS? (Hint: what role does flattr play on every connection?)
3. **Apply:** A new provider only offers `http://`. What breaks, and what's the minimum you'd require before integrating it?
4. **Defend:** Argue for and against pinning `overpass-api.de`'s certificate, then commit to flattr's actual choice and justify it.

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `03-tcp-udp-connections-and-sockets.md` — the TCP connection TLS rides on.
- `05-http-semantics-caching-and-cors.md` — the API key as a query param and where it can leak off the wire.
- `.aipe/study-security/` — whether each trust boundary is actually safe.
