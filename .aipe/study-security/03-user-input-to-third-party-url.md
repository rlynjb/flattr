# 03 — User input to third-party URL

**Industry name(s):** *outbound data flow to an external service* (location
privacy) + *attacker-influenced text re-entering the trust zone* (the
injection/XSS/prompt-injection seam).
**Type label:** Industry standard.

> Two findings share this boundary because they're the two directions of one
> arrow. **Outbound:** exact GPS + typed text leave the device for Nominatim
> (privacy). **Inbound:** `display_name` strings come back attacker-influenced
> and render in the UI (inert today; the LLM seam to watch).

---

## Zoom out, then zoom in

Pull up the geocode round-trip. Every time the user types an address or taps the
map, flattr asks Nominatim (OSM's hosted geocoder) to turn that into
coordinates — and to turn a tapped coordinate back into a label. Here's the
two-way crossing:

```
  Zoom out — the geocode round-trip across the network boundary

  ┌─ UI (device, your trust zone) ──────────────────────────────┐
  │  TextInput "123 Pine St"   ┐                                 │
  │  map tap → exact GPS       ├─► leaves device                 │
  │  <Text>{r.label}</Text>  ◄─┘   renders 3rd-party text        │ ← here
  │  (AddressBar.tsx:23, MapScreen.tsx:97/247)                   │
  └──────────────┬──────────────────────────▲────────────────────┘
     OUTBOUND     │ coords + query           │ display_name
     (privacy)    ▼                          │ (attacker-influenced)
  ┌─ Network boundary ─────────────────────────────────────────┐
  │  Nominatim https://nominatim.openstreetmap.org (geocode.ts) │
  │  third party · keyless · sees coords + IP                   │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. The concept is two trust questions on one wire. Outbound: *who sees
where the user is and where they're going?* Inbound: *what re-enters the app
from a source the user doesn't control, and where does it land?* In flattr the
outbound answer is "a third party, with the device IP, on every query" — a real
but unavoidable-by-design privacy cost. The inbound answer is "a place label
that anyone can edit in OSM, rendered through React's auto-escaping" — inert as
HTML today, **live the moment it touches an LLM, a WebView, or a string-built
URL.**

---

## The structure pass

**Layers:** UI input → geocode module (`pipeline/geocode.ts`) → network →
Nominatim → response → UI render.

**Two axes, because this is the boundary where they diverge: trust *and* data
sensitivity.**

```
  Trust + sensitivity traced across the geocode wire

                          OUTBOUND ►                INBOUND ◄
  ┌─ UI ─────────────┐  trusted source            untrusted source
  │ typed text, GPS  │  HIGH sensitivity (coords)  display_name = editable
  └──────────────────┘  → leaves the device         by anyone on OSM
  ┌─ geocode.ts ─────┐  URLSearchParams encodes    parseFloat(lat/lon) — OK
  │ build URL / parse│  the query (geocode.ts:14)  label passed through RAW
  └──────────────────┘                              (geocode.ts:27)
  ┌─ render ─────────┐  n/a                         <Text>{label}</Text>
  │ AddressBar.tsx:23│                              React escapes → inert HTML
  └──────────────────┘                              BUT raw if → LLM/WebView
```

**The load-bearing seam:** the network boundary itself, traced *both ways*.
Outbound, trust is fine (it's the user's own input) but *sensitivity* is high —
exact coordinates. Inbound, sensitivity is low but *trust* flips to untrusted —
the label is third-party, editable text. A single boundary where one axis
matters going out and the *other* axis matters coming back. That's why it earns
its own file: most boundaries you reason about one-directionally; this one you
can't.

---

## How it works

### Move 1 — the mental model

You've shipped this exact pattern: a search box that hits a third-party autocomplete
API and renders the suggestions. Two reflexes you already have apply directly —
(1) *don't send more than the API needs* (the privacy reflex), and (2) *don't
trust what it sends back* (the render reflex). flattr does (2) correctly via
React; (1) is inherent-cost, narrowed but not eliminated.

```
  The pattern: a bidirectional trust boundary on one wire

   user input ──[encode]──► 3rd party     ◄── sensitivity matters going OUT
                                │
   UI render ◄──[escape]──── response      ◄── trust matters coming IN

   one wire, two different "is this safe?" questions
```

The kernel: **an outbound boundary leaks; an inbound boundary injects.** You
need a control on each direction, and they're different controls (minimize vs
sanitize).

### Move 2 — the walkthrough

**Step 1 — outbound: exact coordinates leave the device.** The location read is
deliberately precise. `MapScreen.tsx:97` calls
`Location.getCurrentPositionAsync({ accuracy: Balanced })`, and on routing the
coords (or typed address) go to Nominatim:

```
  Outbound flow — what Nominatim sees

  ┌─ device ─────────┐  GET /search?q=<typed text>   ┌─ Nominatim ──┐
  │ GPS 47.61823,    │ ─────────────────────────────►│ sees: query   │
  │     -122.32510   │  GET /reverse?lat=..&lon=..    │   + lat/lon    │
  │ + device IP      │ ─────────────────────────────►│   + your IP    │
  └──────────────────┘  (geocode.ts:21,47,64)        └────────────────┘
```

The reverse-geocode path (`MapScreen.tsx:247` → `reverseGeocode(lat, lng)`,
`geocode.ts:58-64`) sends the *exact* tapped coordinate. So OSM's servers can
build, per device IP, a trail of where-you-are and where-you're-going.

**What flattr does right here:** it *narrows* the outbound exposure two ways.
`searchViewbox` (`MapScreen.tsx:51`) biases/bounds autocomplete to a ~30km box
so a search like "starbucks" returns local hits — which also means less probing
of far-away places. And the whole stack is **keyless** — Nominatim can't tie
queries to a flattr account because there isn't one. The residual leak is the
coordinate precision + IP, which is *inherent* to using any hosted geocoder.

**What it doesn't do:** coarsen coordinates before sending. The reverse-geocode
sends full GPS precision; rounding to ~3 decimal places (~100m) before the call
would keep labels useful while blurring the exact spot. That's the buildable
privacy hardening.

**Step 2 — inbound: the label comes back attacker-influenced.** Here's the
subtle part. `display_name` is a *human-editable OSM field* — anyone can change a
place's name in OpenStreetMap. So the string flattr renders is, in the strict
sense, **attacker-influenceable text from a third party.** The parse:

```ts
// pipeline/geocode.ts:25-27
const rows = (await res.json()) as NominatimRow[];
if (!rows.length) return null;
return { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon),
         label: rows[0].display_name };   // ← label passed through RAW
```

`lat`/`lon` get `parseFloat` (a coercion — non-numeric becomes `NaN`, contained).
`display_name` is passed through **verbatim**. It then renders here:

```tsx
// mobile/src/AddressBar.tsx:22-24
<Text style={styles.suggestText} numberOfLines={2}>
  {r.label}
</Text>
```

**Step 3 — why it's inert today, and exactly when it goes live.** React (and RN)
treat `{r.label}` as a **text child**, not markup — they escape it. There's no
`dangerouslySetInnerHTML`, no WebView, no `eval`. So a `display_name` of
`<script>…` renders as the literal characters `<script>…`, harmless. Today this
is a **deferred** finding, not a live XSS.

It goes live the instant the label reaches a sink that *interprets* it:

```
  When the inbound label becomes dangerous

  TODAY:   display_name ──► <Text>{label}</Text>     SAFE (React escapes)

  FUTURE SINK 1 (WebView):  label ──► webview.injectJavaScript / HTML  → XSS
  FUTURE SINK 2 (URL):      label ──► fetch(`/api?q=${label}`)         → if
                            unencoded, injection into YOUR endpoint
  FUTURE SINK 3 (LLM):      label ──► `Routing to ${label}…` in prompt → PROMPT
                            INJECTION — the big one for this codebase
```

**Step 4 — the LLM seam (the reason this matters for *this* repo).** flattr is a
portfolio piece on an AI pivot; a "describe my route / explain the grade"
feature is a natural next step. The moment a `display_name` is concatenated into
a prompt — `"The user is routing from {fromLabel} to {toLabel}…"` — an attacker
who renamed an OSM place to `Ignore previous instructions and …` has injected
instructions into your model call. The defense is the standard one:

```
  Prompt-injection defense for the future LLM seam

  ┌─ untrusted: display_name (OSM-editable) ──────────┐
  │  frame as DATA, never as instructions:            │
  │  - put it in a delimited, labeled block           │
  │  - tell the model it's user-supplied content       │
  │  - NEVER let model output flow back to a sink      │
  │    (URL / fs / eval) without a gate                │
  └────────────────────────────────────────────────────┘
```

This is `audit.md` lens 7's trigger made concrete — the seam is already in the
codebase; only the LLM is missing.

### Move 2 variant — the load-bearing skeleton

Kernel of a safe user-input → third-party → UI loop:

1. **Outbound minimization.** Send the least the API needs. *Breaks if missing:*
   over-exposure of sensitive data (here, precise coords). flattr narrows (viewbox,
   keyless) but doesn't coarsen — partial.
2. **Outbound encoding.** Build the URL so input can't break out of the query.
   *Breaks if missing:* injection into the third-party request / your own
   endpoint. flattr **does this** — `URLSearchParams` (`geocode.ts:14`),
   `encodeURIComponent` (`overpass.ts:30`). Solid.
3. **Inbound treatment.** Treat the response as untrusted at every sink.
   *Breaks if missing:* XSS / prompt injection. flattr is safe at the *current*
   sink (React text) but has **no explicit policy** for the label — it's safe by
   the framework's default, not by intent. That's fragile against a new sink.

**Skeleton vs hardening:** encoding (2) and inbound treatment (3) are skeleton.
Coordinate coarsening (1, beyond what's there) is hardening. The viewbox bias is
a UX feature that *doubles* as minimization hardening.

### Move 3 — the principle

Data on one wire carries two trust questions, and you answer them in opposite
directions: *minimize what goes out, distrust what comes in.* flattr nails the
inbound encoding and gets inbound-render safety for free from React — but "safe
by framework default" is not the same as "safe by policy." The day the label
meets a sink React doesn't escape (a WebView, a URL, an LLM prompt), the
unstated policy becomes a real vulnerability. Make the distrust explicit:
mark `display_name` as untrusted at the type level and gate every new sink.

---

## Primary diagram

The full bidirectional boundary, both findings, in one frame.

```
  User input ↔ third-party URL — full recap

  ┌─ UI (device · trust zone) ──────────────────────────────────┐
  │  TextInput / map tap                  <Text>{label}</Text>   │
  │  + exact GPS (MapScreen.tsx:97)       (AddressBar.tsx:23)    │
  └────────┬────────────────────────────────────▲───────────────┘
  OUTBOUND │ q=<text>, lat/lon, device IP        │ display_name
  (PRIVACY:│ → minimized by viewbox (51),        │ (OSM-EDITABLE,
   coords  │   keyless; NOT coarsened)           │  attacker-influenced)
   leave)  │ → encoded: URLSearchParams (14),    │ → React escapes = inert
           │   encodeURIComponent (overpass:30)  │   HTML TODAY
           ▼                                     │ → RAW if it ever hits:
  ┌─ Network boundary ──────────────────────────┴──────────────┐
  │  Nominatim (geocode.ts) — third party, keyless              │
  │  INBOUND DANGER SINKS (future): WebView · URL · ★ LLM PROMPT★│
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Two well-trodden ideas meet on this wire. The outbound half is the *data
minimization* principle (GDPR Art. 5(1)(c), but it long predates the law as
plain hygiene): collect and transmit only what the function needs. A geocoder
needs *roughly* where you are; it doesn't need 5-decimal precision, and the gap
between "roughly" and "exactly" is the leak. The inbound half is *taint
tracking*: data from an untrusted source carries a "taint" until a sanitizer
that matches the *sink* removes it. The classic failure is sanitizing for the
wrong sink — HTML-escaping a value that then goes into a SQL query, or (the
modern version) escaping for HTML a value that then goes into an LLM prompt,
where escaping means nothing and *framing* is the only defense.

flattr's case is the cleanest possible illustration of why "it's safe" is an
incomplete sentence: the label is safe *for the React-text sink*. Safety is a
property of the (data, sink) pair, never of the data alone. That's why `02`'s
"this is secure" is banned in the audit voice and "if X flows to sink Y, then Z"
is required.

The prompt-injection angle ties directly to the AI-engineering siblings: when
the LLM feature lands, `display_name` is the first untrusted string that'll
reach a prompt, and it'll reach it *invisibly* (nobody thinks of an autocomplete
label as user input). Pre-flagging it now is the whole value of this file.

Read next: `01` (the same providers, the data-correctness direction), and the
`study-ai-engineering` / `study-prompt-engineering` / `study-agent-architecture`
siblings for the prompt-injection defense in depth.

---

## Interview defense

**Q: The app sends exact GPS to a third-party geocoder. Privacy problem?** It's
a real but *inherent* privacy cost of using any hosted geocoder — Nominatim sees
the coordinate and the device IP on every query (`geocode.ts`). flattr mitigates
it sensibly: the search viewbox (`MapScreen.tsx:51`) narrows what's probed, and
the keyless setup means OSM can't tie queries to an account. The residual gap is
that reverse-geocode sends full GPS precision; coarsening to ~100m before the
call is the cheap hardening that keeps labels useful.

```
  the sketch

  device(exact GPS + IP) ──► Nominatim   ← inherent leak; minimize it
                              fix: round coords to ~3dp before sending
```

**Q: Nominatim labels are attacker-editable. Is that an XSS?** Not today —
that's the precise answer. `display_name` is OSM-editable, so it's
attacker-influenced text, and it renders at `AddressBar.tsx:23`. But it renders
as a React `<Text>` child, which auto-escapes, so it's inert HTML. It becomes
live the instant that string hits a sink that interprets it: a WebView, an
unencoded URL, or — the one that matters for this repo — an **LLM prompt**.
Safety here is a property of the sink, not the string.

```
  display_name ──► <Text>  SAFE (escaped)
              └──► LLM prompt  PROMPT INJECTION  ← the seam to watch
```

**Anchor:** *"The label is safe for the React-text sink, not safe in general.
The day it reaches an LLM prompt, an OSM rename becomes prompt injection — frame
it as data, never instructions."*

**Q: Load-bearing part people forget?** That *encoding* and *escaping* are
sink-specific and not interchangeable. flattr correctly `URLSearchParams`-encodes
the outbound query *and* gets HTML-escaping free on the inbound render — two
*different* controls for two *different* sinks. Naming that you'd need a *third*
control (prompt framing) for the LLM sink, because neither of the first two
applies, is the signal you understand taint-by-sink.

---

## See also

- `01-external-data-trust-boundary.md` — the same three providers, viewed as the
  *correctness* of data coming in (vs the *trust/privacy* of this wire).
- `audit.md` lens 3, 5, 7 — injection analysis, the GPS-privacy finding, and the
  LLM/prompt-injection trigger this file pre-loads.
- Siblings: `study-ai-engineering`, `study-prompt-engineering`,
  `study-agent-architecture` (the prompt-injection defense for the future LLM
  seam), `study-networking` (the geocode fetch posture),
  `study-frontend-engineering` (React's auto-escaping that makes the inbound
  render inert today).
