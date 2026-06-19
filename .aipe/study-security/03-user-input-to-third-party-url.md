# User input to third-party URL

**Industry name:** safe URL construction / output encoding for the URL sink,
plus third-party data disclosure (Industry standard). The defensive primitive
is `URLSearchParams`/`encodeURIComponent` as the encoding boundary.
Project-specific instance: address-search text and GPS coordinate flowing to
Nominatim.

---

## Zoom out, then zoom in

Here's the whole thing. The user types an address or taps the map; flattr
turns that into a coordinate by asking OpenStreetMap's Nominatim service.
Every character the user types, and every coordinate they tap, becomes part
of an HTTPS request to a host you don't operate. Two security questions stack
here: is the user's input safely *encoded* into the URL (so it can't break
the request), and where does that input *go* (so what does it disclose)?

```
  Zoom out — where user input crosses out

  ┌─ UI layer (phone) ───────────────────────────────────────────────┐
  │  AddressBar TextInput  ·  map tap  ·  expo-location GPS           │
  └──────────────────────────────┬────────────────────────────────────┘
            search text / lat,lng │
  ┌─ Pipeline layer (geocode.ts, runs on device) ──▼──────────────────┐
  │  geocode / geocodeSuggest / reverseGeocode                        │
  │     ★ URLSearchParams encodes input  ← we are here                │
  └──────────────────────────────┬────────────────────────────────────┘
            HTTPS request          │   ═══ device boundary: data leaves ═══
  ┌─ Provider (NOT yours) ────────▼────────────────────────────────────┐
  │  nominatim.openstreetmap.org  — sees the query AND the coordinate │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the encoding question has a clean answer — `URLSearchParams` is the
gate, and it's used correctly, so there's no URL/query injection. The
disclosure question is the real (modest) finding: the user's location and
search intent leave the device to a third party, governed by their policy,
with no in-app notice naming it. This file walks both.

---

## Structure pass — the trust axis across the geocode call

Trace one question: **who can see or tamper with the input at each layer?**
The answer flips at the device boundary — that flip is the finding.

```
  One question: "who can see / tamper with the input here?"

  ┌──────────────────────────────────────────────┐
  │ TextInput / GPS         only the user          │  → USER controls it
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ URLSearchParams         encodes it safely  │  → ENCODING gate (no inject)
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐  ═══ device boundary ═══
          │ Nominatim host          sees it all    │  → THIRD PARTY sees it
          └──────────────────────────────────────┘

  control flips from user → third-party at the device boundary
```

- **Layers:** UI input → encoding → HTTPS → provider.
- **Axis:** trust ("who can see or tamper with the input?").
- **Seam:** the device boundary, crossed inside `geocode.ts`. Two things flip
  there at once. Tamper-ability: before encoding the user controls the string;
  the `URLSearchParams` gate ensures they control only the *value*, not the
  request structure (no injection). Visibility: once the request leaves, a
  third party you don't control sees the coordinate and the query (disclosure).
  The encoding gate is solid; the disclosure is unmitigated.

---

## How it works

### Move 1 — the mental model

You know this from building any search box that hits an API:
`fetch(`/search?q=${input}`)` is the *wrong* way (a `q` of `a&admin=1`
injects a param), and `new URLSearchParams({ q: input })` is the *right* way
(it percent-encodes the `&` into the `q` value). That's the entire encoding
story — the question is just "did they use the gate."

```
  The pattern — encode at the sink boundary

   user text "a&b=c"  ──► URLSearchParams({ q: "a&b=c" })
                              │
                              └─ emits  q=a%26b%3Dc
                                 the & and = are now DATA, not structure.
                                 the request shape is fixed by code, not input.
```

The skeleton has two concerns that travel together but are *different*:
**encoding** (does input stay inside its slot in the URL?) and **disclosure**
(once sent, who sees it?). Encoding defends the *request*; nothing defends the
*disclosure* except not sending the data at all.

### Move 2 — the walkthrough

**Part 1 — the input sources.** Three ways user input becomes a geocode call.
Bridge from a controlled `<input onChange>`: the From/To fields are controlled
TextInputs (`AddressBar.tsx:68`), and as the user types, `scheduleSuggest`
debounces 400 ms then calls `geocodeSuggest`. A map tap
(`MapScreen.tsx:218-232`) produces a `lat,lng` and calls `reverseGeocode`. The
locate button reads GPS via `expo-location` and that coordinate also reaches
`reverseGeocode`. All three converge on `geocode.ts`.

```
  Part 1 — three sources, one destination

  TextInput keystroke ─debounce─► geocodeSuggest(text) ─┐
  map tap (lat,lng)   ──────────► reverseGeocode(lat,lng)├─► nominatim.org
  GPS fix (lat,lng)   ──────────► reverseGeocode(lat,lng)┘
```

**Part 2 — the encoding gate.** Inside `geocode`, the user string goes into
`new URLSearchParams({ q: query, format: "jsonv2", limit: "1" })`. What
concretely happens: `URLSearchParams.toString()` percent-encodes every value,
so a query of `Pike St & 5th #2` becomes `q=Pike+St+%26+5th+%232`. The `&`
can't start a new param; the `#` can't start a fragment. Where it would break
if someone skipped this: string-concatenating `?q=${query}` would let
`&limit=9999` or `&viewbox=...` ride in as real params — a query-injection
into the Nominatim request. They didn't skip it; the gate is correct at every
call site.

```
  Part 2 — the gate holds (layers-and-hops)

  ┌─ device ─────────────┐  hop: HTTPS GET                ┌─ Nominatim ──┐
  │ URLSearchParams      │  ?q=Pike+St+%26+5th  ────────► │ parses q as  │
  │ { q: userText }      │  (& is encoded, not a param)   │ ONE value    │
  └──────────────────────┘                                └──────────────┘
        the request shape is fixed by code; input fills only the q slot
```

**Part 3 — the disclosure (the actual finding).** Here's the part that
matters even though the encoding is clean: the request *itself* carries the
user's data to a host flattr doesn't operate. `reverseGeocode(lat, lng)` puts
the exact tapped/GPS coordinate into the URL and sends it to
`nominatim.openstreetmap.org`. TLS encrypts it in transit — so a network
eavesdropper can't read it — but the *endpoint* sees it in the clear, because
TLS protects the pipe, not the recipient. Concrete consequence: OSM's
operators (and their logs, and their policy) receive the precise location of
every map tap and every typed search. Bridge from any third-party analytics
call: the data is out of your jurisdiction the moment it lands.

```
  Part 3 — TLS protects the pipe, not the recipient

  user coordinate
       │  reverseGeocode(lat,lng)
       ▼
  ┌─ device ──┐  ══ TLS (encrypts transit) ══►  ┌─ Nominatim host ──────┐
  │ exact GPS │   eavesdropper sees nothing      │ sees the EXACT coord  │
  └───────────┘                                  │ under OSM's policy    │
                                                 └───────────────────────┘
       the disclosure is to the endpoint, which TLS does not hide
```

**Part 4 — what's done right around the disclosure.** Two mitigations exist,
neither closing the disclosure but both worth naming. The autocomplete only
fires at ≥ 3 chars (`MapScreen.tsx:72`), so single keystrokes aren't all
shipped. And the `User-Agent` header identifies the app honestly
(`geocode.ts:22`), per Nominatim's usage policy — that's politeness/compliance,
not a security control. What's *missing*: no in-app disclosure tells the user
their searches and location go to OpenStreetMap. The OS location prompt
(`app.json:29`) says location is used "to center the map" — true, but it
doesn't mention the reverse-geocode round-trip.

### Move 3 — the principle

Encoding and disclosure are two separate gates on the same boundary, and
fixing one does nothing for the other. `URLSearchParams` perfectly defends
the *request structure* — input stays in its slot, no injection. It does
*nothing* for *who receives the data*. The general rule: **safe URL
construction prevents injection; it never prevents disclosure.** If the
privacy concern is "a third party sees the user's location," the only fixes
are not sending it, or sending it to a host *you* control under *your* policy
— which is an architecture change, not an encoding change.

---

## Primary diagram

The full frame: input encoded safely (gate holds), then crossing the device
boundary to a third party who sees it (disclosure, unmitigated).

```
  User input to third-party URL — full frame

  ┌─ UI (phone) ──────────────────────────────────────────────────────┐
  │  TextInput (search)   map tap (lat,lng)   GPS (expo-location)      │
  └───────────────┬───────────────┬───────────────┬───────────────────┘
       text       │     lat,lng    │    lat,lng    │
  ┌─ geocode.ts ──▼───────────────▼───────────────▼───────────────────┐
  │  geocodeSuggest        reverseGeocode        reverseGeocode        │
  │  URLSearchParams({ q })  URLSearchParams({ lat, lon })            │
  │     ✓ ENCODING GATE: input stays in its slot — no injection       │
  └───────────────────────────────┬───────────────────────────────────┘
        HTTPS GET (TLS)            │   ═══ DEVICE BOUNDARY: data leaves ═══
  ┌─ nominatim.openstreetmap.org (NOT yours) ──▼──────────────────────┐
  │  sees the exact query AND coordinate, under OSM's privacy policy  │
  │     ✗ DISCLOSURE: unmitigated; TLS hides it from the wire, not    │
  │       from the endpoint; no in-app notice names this              │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Three real flows: typing in From/To fires debounced
autocomplete (`MapScreen.tsx:70-86` → `geocodeSuggest`); pressing Route
geocodes both endpoints (`MapScreen.tsx:166-199` → `geocode` twice,
sequentially because Nominatim allows ~1 req/sec); tapping the map or hitting
the locate button reverse-geocodes a coordinate to a label
(`MapScreen.tsx:229`, `:202` → `reverseGeocode`). Every one of these crosses
the device boundary to Nominatim.

```
  pipeline/geocode.ts  (lines 9–27) — the encoding gate, done right

  const params = new URLSearchParams({                ← THE GATE
    q: query, format: "jsonv2", limit: "1" });        ←   user query → q value
  if (opts.viewbox) {
    params.set("viewbox", `${minLng},${maxLat},...`); ←   numeric, not user text
    params.set("bounded", "0");
  }
  const res = await fetchImpl(
    `${ENDPOINT}?${params.toString()}`,               ← .toString() percent-encodes
    { headers: { "User-Agent": "flattr/0.1 ..." } }); ← Nominatim policy compliance
       │
       └─ Because `query` is a VALUE in URLSearchParams, "a&limit=99" is
          encoded into q=a%26limit%3D99 — it cannot inject a second param.
          Concatenating `?q=${query}` instead WOULD allow injection. The
          gate is correct; this is the safe pattern, used at every call site.
```

```
  pipeline/geocode.ts  (lines 58–70) — the disclosure, unmitigated

  export async function reverseGeocode(lat, lng, fetchImpl = fetch) {
    const params = new URLSearchParams({
      lat: String(lat), lon: String(lng), format: "jsonv2" });  ← exact coord
    const res = await fetchImpl(
      `${REVERSE_ENDPOINT}?${params.toString()}`, ...);          ← leaves device
    ...
  }
       │
       └─ The coordinate is safely ENCODED (no injection) but fully DISCLOSED
          to nominatim.openstreetmap.org. Encoding ≠ privacy. TLS encrypts
          the request to the host; the host still receives the precise
          location. There is no in-app notice that searches/location are
          sent to OSM — only the OS prompt (app.json:29), which describes
          "centering the map," not the geocode round-trip.
```

```
  mobile/src/MapScreen.tsx  (lines 90–102) — the GPS source

  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return null;             ← honors OS permission
  const pos = await Location.getCurrentPositionAsync(
    { accuracy: Location.Accuracy.Balanced });        ← reads precise coords
  const c = [pos.coords.longitude, pos.coords.latitude];
       │
       └─ Balanced accuracy is a sensible privacy default (not the highest
          precision). But once this coordinate reaches reverseGeocode it
          leaves the device. The permission gate controls READING location;
          it does not control SENDING it to a third party.
```

**The fix, named:** keep the encoding exactly as is (it's correct). For the
disclosure: add a one-time in-app notice that searches and location are sent
to OpenStreetMap; or route geocoding through a backend you operate, so the
coordinate is disclosed to *you* under *your* policy rather than directly to
OSM. The second is a deliberate tradeoff — it creates a server boundary
(today `not yet exercised`) and its own auth question, in exchange for owning
the data-handling policy.

---

## Elaborate

The encoding half of this is the URL-context member of the output-encoding
family (alongside HTML-encoding for XSS, SQL-parameterization for injection):
the principle is always "structure comes from code, data fills the slots,
never let data become structure." flattr gets this right with the platform
primitive (`URLSearchParams`), which is exactly the move you'd make in a Vue
or React search box — `new URL` + `searchParams` rather than template-string
concatenation.

The disclosure half is a privacy-engineering concern, not a vulnerability,
and it's the *honest* shape of this app's exposure: a free OSM-backed app that
sends queries to OSM is behaving as designed; the gap is consent transparency,
not a leak. Connect to `.aipe/study-networking/` for the TLS/transport details
(why "encrypted in transit" doesn't mean "private from the endpoint") and to
file 01 for the *inbound* side of the same provider boundary — data coming
back from OSM that the pipeline trusts.

---

## Interview defense

**Q: User search text goes into a Nominatim URL. Injection risk?** No — every
call uses `URLSearchParams`, so user input is a percent-encoded value, not
URL structure. `a&limit=99` becomes `q=a%26limit%3D99`; it can't inject a
second param. The encoding gate is correct at every call site in `geocode.ts`.
The real concern on this boundary isn't injection — it's disclosure.

```
  user text ─► URLSearchParams({ q }) ─► q=a%26limit%3D99 ─► one value, safe
                     ▲
              structure fixed by code; input fills only the slot
```

*Anchor:* "URLSearchParams makes input a value, not structure."

**Q: So what *is* the concern?** The user's exact GPS coordinate and search
text leave the device to a host I don't operate (`reverseGeocode` →
nominatim.org). TLS protects it on the wire but not from the endpoint — OSM
sees it under their policy, and there's no in-app notice naming that. It's a
privacy disclosure, not a breach. The thing people conflate: encoding defends
the request structure; it does nothing for who receives the data.

```
  device ── TLS ──► Nominatim
                      └─ sees the coordinate; TLS doesn't hide it from here
```

*Anchor:* "TLS protects the pipe, not the recipient."

---

## Validate

**Reconstruct.** Draw the two separate gates on this boundary (encoding vs
disclosure) and state which one `geocode.ts:14` implements and which one is
missing.

**Explain.** Why does `new URLSearchParams({ q: userText })`
(`geocode.ts:14`) prevent a query like `a&limit=999` from injecting a second
param, but template-string `?q=${userText}` would not?

**Apply to a scenario.** A user taps a map location and `reverseGeocode`
(`geocode.ts:58`) fires. Trace what `nominatim.openstreetmap.org` receives.
Does TLS prevent OSM from seeing the coordinate? Does the OS location prompt
(`app.json:29`) disclose this round-trip?

**Defend the decision.** Argue for adding a backend geocode proxy vs leaving
direct-to-Nominatim. What does the proxy buy (data under your policy), what
does it cost (a new server boundary + auth, today `not yet exercised`), and is
it worth it for a free OSM-backed app?

---

## See also

- `01-external-data-trust-boundary.md` — the inbound side of this same
  provider boundary (data OSM returns, which the pipeline trusts).
- `audit.md` lens 3 (input-validation/injection) and lens 5 (data-exposure).
- `.aipe/study-networking/` — TLS, the ~1 req/sec Nominatim policy, the
  debounce, and why encrypted transit ≠ private endpoint.
