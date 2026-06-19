# Controlled Search with Debounced Autocomplete
### industry names: controlled inputs + debounced typeahead / autocomplete — Industry standard (React form + search pattern)

---

## Zoom out, then zoom in

The From/To address bar is the user's way into a route. It's three things at
once: **controlled text inputs**, a **debounced autocomplete** that hits a
rate-limited geocoder as you type, and a **tap-to-set** mode where touching the
map fills the focused field. All of it is driven from `MapScreen`'s state, with
a dumb `AddressBar` rendering it.

```
  Zoom out — where the search seam lives

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  <AddressBar> (presentational)                                 │
  │     value=fromText onChangeText=onFromChange ...               │
  │        ▲ controlled               │ callback up                 │
  │  ┌─────┴───────────────────────────▼─────────────────────────┐ │
  │  │ MapScreen state: fromText/toText, suggestions, activeField│ │ ★ here
  │  │ scheduleSuggest (debounce) · handleMapPress (tap-to-set)  │ │
  │  └─────────────────────────────────┬─────────────────────────┘ │
  └────────────────────────────────────┼─────────────────────────────┘
                                       │ geocodeSuggest / reverseGeocode
  ┌─ Network ──────────────────────────▼─────────────────────────────┐
  │  Nominatim (bounded to a ~30km box; ~1 req/sec)                  │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: it's the **controlled-input + debounced-typeahead** pattern you've
built many times — `value`/`onChange` make React the source of truth for the
text, a timer collapses keystrokes into one query, and the results render as a
suggestion list. The twist here: there are *two* ways to set the same field
(type, or tap the map), and the geocoder is rate-limited so the debounce isn't
optional. The question: *how do I let the user name a place by typing OR
tapping, without firing a geocode on every keystroke?*

---

## Structure pass

**Layers** — three altitudes of "the field's value":

```
  outer:  the <TextInput>        (what's on screen — controlled by props)
  middle: MapScreen state         (fromText/toText — the source of truth)
  inner:  the resolved place      (a {lat,lng} endpoint — the real target)
```

**Axis traced — "what is the source of truth for this field, right now?"**
(a control/ownership axis):

```
  axis = "who owns the field's current value?"  — trace downward

  ┌──────────────────────────────────────────────┐
  │ outer: TextInput                               │ → NOTHING (it's controlled)
  │   shows props.value; emits onChangeText        │   pure reflection of state
  └───────────────────┬────────────────────────────┘
      ┌───────────────▼────────────────────────────┐
      │ middle: MapScreen useState                   │ → REACT owns the text
      │   fromText/toText set by typing OR tap OR    │   single source of truth
      │   suggestion pick                            │
      └───────────────┬────────────────────────────┘
          ┌───────────▼────────────────────────────┐
          │ inner: startPt/endPt                     │ → COORDINATE owns intent
          │   the geocoded {lat,lng} that routes      │   (text is just a label)
          └──────────────────────────────────────────┘
```

The truth flips: the input owns *nothing* (controlled), React state owns the
*text*, but the *coordinate* is the real intent — the text is just a label for
it. That's why a tap can set the endpoint *before* the text resolves ("Locating…"
then the address).

**Seams:**

- **AddressBar ↔ MapScreen seam** (props/callbacks): `AddressBar` is fully
  controlled — it owns no search state. Control of *what the field says* lives
  in `MapScreen`. This is the container/presentational boundary.
- **keystroke ↔ network seam** (the debounce + the bounded geocoder): the axis
  "how often does a network call fire?" flips here — every keystroke on one
  side, at most one settled query on the other.

---

## How it works

### Move 1 — the mental model

You know controlled inputs: `value={x}` + `onChange={e => setX(e.value)}` makes
React the single source of truth — the input can't hold a value React doesn't
know about. And you know debounced search: don't query on every keystroke, wait
until typing pauses. Compose them and you get a typeahead.

```
  Debounced typeahead — the kernel shape

  keystroke ─► setText(t)            ── controlled: state owns the text
            └► clearTimeout(prev)    ── reset the debounce
               setTimeout(400ms): if len≥3 → geocodeSuggest(t) → setSuggestions
                                              │
  suggestion list renders ◄───────────────────┘
  pick one ─► setText(label) + setEndpoint({lat,lng}) + clear suggestions
```

One sentence: **the input is controlled by state; a per-field timer collapses
keystrokes into one bounded geocode; picking a result sets both the label and
the coordinate.**

### Move 2 — the step-by-step walkthrough

#### Controlled inputs make state the only source of truth

`AddressBar`'s `TextInput`s take `value={fromText}` and
`onChangeText={onFromChange}` — they hold no internal text. Every character
round-trips through `MapScreen` state. That's why the field can be set from
three different places (typing, a map tap writing "Locating…", a suggestion
pick) and they never conflict: they all just call the same setter.

```
  controlled input — state is the only truth

  type "c" ─► onChangeText("c") ─► setFromText("c") ─► re-render value="c"
  map tap  ─────────────────────► setFromText("Locating…") ─► re-render
  pick sug ─────────────────────► setFromText(label) ─► re-render
        │ all three write the same state; no internal input value to drift
```

Boundary condition: make the input *uncontrolled* (drop `value`) and the
tap-to-set "Locating…" text would never appear — the input would keep whatever
the user last typed. Controlled is what lets the map tap *write into* the field.

#### The debounce lives in a ref, keyed per field

`scheduleSuggest(field, text)` clears the prior timer (held in
`suggestTimer.current` — a ref, because the timer handle isn't render state)
and sets a new 400 ms one. Under 3 chars it bails and clears suggestions —
geocoding a 1-2 char query is noise. The ref is the right tool: you need to
read and clear the *latest* handle synchronously across renders, and changing
it must not trigger a re-render.

```
  debounce in a ref (scheduleSuggest)

  onFromChange(t) ─► setFromText(t) ; scheduleSuggest("from", t)
                                        │
        clearTimeout(suggestTimer.current)   ← cancel the pending query
        if t.trim().length < 3: clear suggestions ; return   ← too short
        suggestTimer.current = setTimeout(400ms, async () => {
            results = await geocodeSuggest(t, {bounded box, limit 5})
            setSuggestions(results) ; setSuggestField(field)
        })
```

Boundary condition: drop the `clearTimeout` and every keystroke schedules a
query that all fire 400 ms later — you've debounced nothing, just delayed the
flood. The cancel-then-reschedule *is* the debounce.

#### The query is bounded to a local box so results are routable

`geocodeSuggest` is called with `{viewbox: searchViewbox, bounded: true}` — a
~30 km box around the bundled area (`MapScreen.tsx:47-50`). This isn't cosmetic:
the app only has graph coverage near the base area, so a "Starbucks" hit in
another state would geocode fine but produce "No route." Bounding the search to
where you *can* route keeps suggestions honest.

```
  bounded geocode — only suggest what you can route to

  "starbucks" ─► geocodeSuggest(viewbox=~30km box, bounded=true)
                       │
                       └─► only local hits returned → every suggestion is routable
```

#### Two setters, but the suggestion list tracks one field at a time

There's one `suggestions` array and a `suggestField` marking which input it
belongs to (`"from"`/`"to"`/`null`). `AddressBar` renders the list under the
matching input only (`suggestField === "from" && ...`). So focusing From shows
From's suggestions; the same state serves both inputs without two arrays.

```
  one suggestions array, tagged by field

  suggestField="from" ─► list renders under the From input
  suggestField="to"   ─► list renders under the To input
  suggestField=null   ─► no list
```

#### Tap-to-set: the map is a second input device for the field

When a field is focused (`activeField` set), tapping the map calls
`handleMapPress`: it reads the tapped `lngLat`, sets the corresponding endpoint
*immediately*, writes "Locating…" into the field, dismisses the keyboard, then
reverse-geocodes the point and replaces the text with the resolved address
(falling back to raw coords on failure). The endpoint is set before the label
resolves — because the coordinate is the real intent, the text is decoration.

```
  tap-to-set lifecycle (handleMapPress)

  tap map (field focused) ─► setEndpoint({lat,lng})   ← intent set NOW
                          ─► setText("Locating…")      ← optimistic label
                          ─► reverseGeocode(lat,lng)
                                │ resolves           │ fails
                                ▼                     ▼
                          setText(address)      setText("47.61, -122.32")
```

Boundary condition: if you set the text first and the endpoint only after
reverse-geocode resolved, a slow/failed geocode would leave the map tapped but
no route possible. Setting the endpoint first means the route can compute while
the label is still "Locating…".

#### Picking a suggestion is the clean path: label + coordinate together

`onSelectSuggestion` does it all in one shot — fill the text with the label, set
the endpoint to the result's `{lat,lng}`, clear suggestions, blur, dismiss
keyboard, and ease the camera there. No reverse-geocode needed; the suggestion
already carries the coordinate.

### Move 3 — the principle

**A controlled input makes React the single owner of a value so multiple input
methods can write to it without conflict — and a debounce is the rate-limiter
between human typing speed and a network's tolerance.** The deeper move here:
the field's *text* and the field's *coordinate* are two different things, and
the coordinate is the one that matters. Treating text as a label for an
underlying intent is what lets "type," "tap," and "pick" all be equal ways to
express the same endpoint. The general lesson: separate the *display value*
from the *resolved intent*, and let any input method set both.

---

## Primary diagram

The full search/selection flow — three input methods, one debounce, one
suggestion list, the resolved endpoint.

```
  Controlled search — full flow (MapScreen owns all state)

  ┌─ AddressBar (presentational, controlled) ─────────────────────┐
  │  TextInput value=fromText onChangeText ──┐ onFocus=activeField │
  │  Suggestions list (when suggestField matches) ──pick──┐        │
  └──────────────────────┬───────────────────────────────┼────────┘
                         │ type                           │ pick
                         ▼                                ▼
  ┌─ MapScreen state + handlers ──────────────────────────────────┐
  │ scheduleSuggest(field,t):                                      │
  │   clearTimeout ; if t<3 clear ; setTimeout 400ms ─► geocodeSuggest
  │                                          (bounded ~30km box)   │
  │   ◄── results ─► setSuggestions ; setSuggestField              │
  │                                                                │
  │ onSelectSuggestion: setText(label) + setEndpoint({lat,lng})    │
  │ handleMapPress (map tap, field focused):                       │
  │   setEndpoint(now) ; setText("Locating…") ─► reverseGeocode ──►│
  │ handleRoute (Route btn): geocode(from) ; geocode(to) sequential│
  └──────────────────────┬─────────────────────────────────────────┘
                         ▼
              startPt / endPt set ─► (route derives — see 02)
                         │
            ═══ network: Nominatim (~1 req/sec, bounded) ═══
```

---

## Implementation in codebase

**Use cases in this repo:**

1. **Type an address** → debounced suggestions → pick one → endpoint set.
2. **Tap the map** with a field focused → endpoint set immediately, label
   reverse-geocoded.
3. **"Use current location"** → GPS point set as From, text "Current location"
   (a non-geocodable sentinel handled specially at route time).
4. **Route button** → geocode both fields sequentially (Nominatim's ~1 req/sec).

**Code, line by line.**

The debounced scheduler — `mobile/src/MapScreen.tsx:70-86`:

```
  scheduleSuggest — MapScreen.tsx:70-86

  const scheduleSuggest = useCallback((field, text) => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);  ← cancel pending (the debounce)
    if (text.trim().length < 3) {                                  ← too short to be useful
      setSuggestions([]); setSuggestField(null); return;
    }
    suggestTimer.current = setTimeout(async () => {                ← ref holds the latest handle
      try {
        const results = await geocodeSuggest(text,
          { viewbox: searchViewbox, bounded: true, limit: 5 });    ← bounded to ~30km, max 5
        setSuggestions(results); setSuggestField(field);           ← tag which field they belong to
      } catch { /* ignore transient/rate-limit errors */ }         ← swallow 429s
    }, 400);
  }, [searchViewbox]);
       │
       └─ clearTimeout + reschedule IS the debounce; the <3 guard and bounded box
          keep junk queries off the rate-limited geocoder.
```

The controlled inputs wired up — `mobile/src/MapScreen.tsx:315-335` (calling
into `AddressBar`):

```
  AddressBar wiring — MapScreen.tsx:315-335

  <AddressBar
    fromText={fromText} toText={toText}            ← controlled values (state owns them)
    onFromChange={(t) => { setFromText(t); scheduleSuggest("from", t); }}  ← set + debounce
    onToChange={(t) => { setToText(t); scheduleSuggest("to", t); }}
    onFocusField={setActiveField}                  ← which field tap-to-set targets
    suggestions={suggestions} suggestField={suggestField}
    onSelectSuggestion={onSelectSuggestion}
    onRoute={handleRoute} busy={routeBusy} error={routeError}/>
```

The controlled input itself — `mobile/src/AddressBar.tsx:68-77`:

```
  the From TextInput — AddressBar.tsx:68-77

  <TextInput
    style={[styles.input, activeField === "from" && styles.inputActive]}  ← focus highlight from prop
    value={fromText}                               ← controlled: shows exactly what state holds
    onChangeText={onFromChange}                    ← every keystroke → up to MapScreen
    onFocus={() => onFocusField("from")}/>         ← arm tap-to-set for this field
```

Tap-to-set — `mobile/src/MapScreen.tsx:218-232`:

```
  handleMapPress — MapScreen.tsx:218-232

  if (!activeField) return;                          ← only when a field is focused
  const [lng, lat] = event.nativeEvent.lngLat;       ← tapped coordinate (native event)
  if (field === "from") setStartPt({ lat, lng });    ← ENDPOINT set first (the real intent)
  else setEndPt({ lat, lng });
  setText("Locating…");                              ← optimistic label
  setActiveField(null); Keyboard.dismiss();
  reverseGeocode(lat, lng)
    .then((label) => setText(label ?? `${lat...}, ${lng...}`))  ← resolve label, fallback to coords
    .catch(() => setText(`${lat...}, ${lng...}`));
       │
       └─ endpoint set BEFORE the label resolves → route can compute while text says "Locating…".
```

Suggestion pick — `mobile/src/MapScreen.tsx:235-245`:

```
  onSelectSuggestion — MapScreen.tsx:235-245

  (field === "from" ? setFromText : setToText)(r.label);  ← label + …
  if (field === "from") setStartPt({ lat: r.lat, lng: r.lng });  ← …coordinate, together
  else setEndPt({ lat: r.lat, lng: r.lng });
  setSuggestions([]); setSuggestField(null); setActiveField(null); Keyboard.dismiss();
  cameraRef.current?.easeTo({ center: [r.lng, r.lat], zoom: 15, duration: 500 });  ← move map there
       │
       └─ suggestion already carries {lat,lng}, so no reverse-geocode needed (clean path).
```

`keyboardShouldPersistTaps="handled"` on the suggestion `ScrollView`
(`AddressBar.tsx:17`) is the small load-bearing detail that lets a tap on a
suggestion register *before* the keyboard-dismiss blur eats it.

---

## Elaborate

Controlled inputs and debounced search are the two oldest patterns in frontend
forms — controlled because React's whole model is "UI is a function of state,"
debounce because human typing (5-10 keystrokes/sec) vastly outpaces what any
search backend wants to serve. The combination is the canonical typeahead.

The repo-specific wrinkle is the *bounded* geocoder and the *coordinate-as-
intent* split. Nominatim (the geocoder behind `pipeline/geocode`) is free and
rate-limited (~1 req/sec), so the debounce isn't a nicety — it's a hard
requirement, the same rate-limit pressure that shaped the tile-graph hook
(`01-on-demand-tile-graph.md`). And bounding results to the routable area is a
correctness move: an unroutable suggestion is worse than no suggestion.

Where it connects: the *wire* behavior of Nominatim (the ~1 req/sec limit, how
429s surface) is `.aipe/study-networking/`. The endpoint coordinates this
produces feed straight into the derived route (`02-derived-render-time-astar.md`).
The map tap that sets a field comes through the native MapLibre `onPress`
(`03-native-maplibre-declarative-layers.md`).

What to read next: React's "You Might Not Need an Effect" on derived state and
event handlers, then any production typeahead's handling of *out-of-order
responses* (a slower earlier query resolving after a faster later one) — a race
this code sidesteps because the debounce cancels the prior timer, but worth
knowing as the next hardening step if requests overlapped.

---

## Interview defense

**Q: Why are these inputs controlled, given controlled inputs cost a re-render
per keystroke?**

Because three different things write to the same field — typing, a map tap, and
a suggestion pick — and controlled inputs make React the single owner so they
can't conflict. The tap-to-set writing "Locating…" into the field literally
can't work with an uncontrolled input; the field would keep the user's last
typed text. The per-keystroke re-render is cheap here (a small bar); the
conflict-free single source of truth is worth it.

```
  controlled = one owner, many writers

  type / tap / pick ─► same setState ─► one truth ─► no drift
```

Anchor: *controlled inputs let the map tap write into the field — that's why
they're controlled.*

**Q: Where's the actual debounce, and what's the one line that makes it work?**

`scheduleSuggest` (`MapScreen.tsx:70-86`). The load-bearing line is
`clearTimeout(suggestTimer.current)` before scheduling the new timer. Without
the cancel, every keystroke just *delays* a query by 400 ms instead of
*replacing* the pending one — you'd flood the geocoder 400 ms later. Cancel-
then-reschedule is the debounce; the timer alone isn't.

```
  debounce = cancel + reschedule

  keystroke ─► clearTimeout(prev) ─► setTimeout(new)   only the LAST survives
```

Anchor: *the `clearTimeout` is the debounce; the `setTimeout` alone is just a
delay.*

**Q: Why set the endpoint before the reverse-geocode resolves on a map tap?**

Because the coordinate is the real intent; the text is just a label. Setting
the endpoint first lets the route start computing immediately while the label
shows "Locating…" — and if the reverse-geocode fails, I fall back to raw coords
but the route still works. Waiting for the label would gate routing on a
network call that might never resolve.

Anchor: *coordinate is intent, text is label — set the intent first.*

---

## Validate

**Reconstruct.** From memory, write `scheduleSuggest`: clear prior timer, bail
under 3 chars, schedule a 400 ms bounded `geocodeSuggest`, tag the field. Name
the lines: `MapScreen.tsx:70-86`.

**Explain.** Why is the geocode bounded to `searchViewbox` (`:47-50`,`:79`)
with `bounded: true`? (Only the local area has graph coverage; an out-of-area
hit geocodes fine but yields "No route" — bounding keeps suggestions routable.)

**Apply to a scenario.** The user types "pike", taps a suggestion, then taps
the map elsewhere with the To field focused. Trace the state writes:
`setFromText`+`setStartPt` (pick), then `setEndPt`+`setToText("Locating…")`+
`reverseGeocode` (tap). What sets the route in motion, and when? (Both
endpoints now set → the effect at `:131-140` loads the corridor → `routed`
derives.)

**Defend the decision.** A reviewer wants to move `fromText`/`toText` into
`AddressBar` as local state "to avoid re-rendering MapScreen on every
keystroke." Argue against it: tap-to-set and suggestion-pick both need to
*write* the field from outside the bar, so the text must live in the shared
parent — local input state would break those two paths.

---

## See also

- `02-derived-render-time-astar.md` — the endpoints this produces drive the
  derived route.
- `01-on-demand-tile-graph.md` — the *other* debounced, rate-limit-aware
  network seam (tile loading); same Nominatim/Overpass rate-limit pressure.
- `03-native-maplibre-declarative-layers.md` — the map `onPress` behind
  tap-to-set.
- `audit.md` lens 2 (state-architecture), lens 3 (component-architecture, the
  controlled `AddressBar`), lens 4 (data-fetching), lens 8 red flag #3 (13-prop
  interface).
- `.aipe/study-networking/` — Nominatim ~1 req/sec, 429 handling, out-of-order
  response races.
