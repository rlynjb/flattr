# Debounced controlled inputs — the AddressBar autocomplete

**Industry name(s):** controlled component + debounced async (typeahead/autocomplete). **Type:**
Industry-standard (the debounced-controlled-input pattern is universal; the rate-limit motivation is
project-specific).

## Zoom out, then zoom in

The AddressBar is the only text input surface in the app, and it does the classic typeahead dance: you
type, suggestions appear, you pick one. The non-obvious engineering is the *debounce* — every keystroke
*could* hit Nominatim, but Nominatim allows roughly one request per second, so a raw per-keystroke fetch
would get you rate-limited mid-word. The debounce is the throttle that makes a fully-controlled input safe
to wire to a rate-limited API.

```
  Zoom out — where the input + debounce sit

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  AddressBar (presentational, controlled by MapScreen)         │
  │     onChangeText → onFromChange/onToChange                     │
  │            │                                                   │
  │  MapScreen: setText (instant) + ★ scheduleSuggest (400ms) ★    │ ← here
  └────────────┬──────────────────────────────────────────────────┘
               │ debounced fetch
  ┌─ pipeline ▼───────────────────────────────────────────────────┐
  │  geocodeSuggest → Nominatim (bounded to local viewbox)        │
  └────────────────────────────────────────────────────────────────┘
```

The input itself is dead-simple React. The interesting part is the timer between the keystroke and the
network call.

## Structure pass

**Layers:** (1) `AddressBar` controlled `TextInput`, (2) `MapScreen` state + debounce scheduler,
(3) `geocodeSuggest` → Nominatim.

**Axis traced — "what's the rate of work at each layer?"**

```
  axis = "how often does work happen?"

  ┌─ TextInput ─────────────┐   per keystroke — value flows up
  │  onChangeText: instant   │   every character
  └───────────┬──────────────┘
              │ seam: setText (sync) vs scheduleSuggest (deferred)
  ┌─ scheduler ▼─────────────┐   per keystroke the timer RESETS;
  │  setTimeout 400ms, reset  │   fires once 400ms after last key
  └───────────┬──────────────┘
              │ seam: the fired callback
  ┌─ Nominatim ▼─────────────┐   ~once per typing pause — under
  │  one fetch per settle     │   the ~1 req/sec limit
  └───────────────────────────┘
```

**The seam is the split inside `onFromChange`** (`MapScreen.tsx:342-348`): the text update is *synchronous*
(the input must echo every keystroke instantly or it feels broken), but the *fetch* is debounced. Two
different rates from one event — that's the whole pattern.

## How it works

### Move 1 — the mental model

A controlled input is `value` + `onChange` — React owns the text, the DOM/native input just reflects it.
You've written this constantly. The debounce wraps the *side effect*, not the value: keep echoing
keystrokes instantly, but only *act* on them after the user pauses.

```
  controlled-input + debounced-effect shape

   keystroke ──► onChangeText ──┬──► setText (instant, UI echoes)
                                │
                                └──► scheduleSuggest (reset 400ms timer)
                                            │ fires only after a pause
                                            ▼
                                     fetch suggestions
```

The strategy: **decouple the display update (immediate) from the side effect (deferred).** Same event, two
cadences.

### Move 2 — the walkthrough

**The controlled input.** `AddressBar` is fully controlled — `value` and `onChangeText` come from props,
it owns no text state (`AddressBar.tsx:70-79`):

```tsx
<TextInput
  style={[styles.input, activeField === "from" && styles.inputActive]}  // active styling derived from prop
  value={fromText}                          // ← controlled: MapScreen owns the text
  onChangeText={onFromChange}               // ← every keystroke flows up
  onFocus={() => onFocusField("from")}      // tells MapScreen which field is active (for map-tap routing)
/>
```

This is the same store-raw-derive-everything-else idea as `02-coords-not-ids-endpoints.md`: the text is the
truth, `canRoute` is derived from it (`AddressBar.tsx:60`), the active-field border is derived from
`activeField` (`:71`). No duplicated state.

**The debounce scheduler.** In `MapScreen`, `scheduleSuggest` is the throttle (`MapScreen.tsx:73-89`):

```ts
const scheduleSuggest = useCallback((field: Field, text: string) => {
  if (suggestTimer.current) clearTimeout(suggestTimer.current);  // ← reset: cancel the prior pending fetch
  if (text.trim().length < 3) {                                  // ← floor: don't search on 1-2 chars
    setSuggestions([]); setSuggestField(null); return;
  }
  suggestTimer.current = setTimeout(async () => {
    try {
      const results = await geocodeSuggest(text, { viewbox: searchViewbox, bounded: true, limit: 5 });
      setSuggestions(results);
      setSuggestField(field);                                    // ← tag which field the results belong to
    } catch { /* ignore transient/rate-limit errors */ }
  }, 400);                                                       // ← 400ms quiet period
}, [searchViewbox]);
```

Three load-bearing pieces, named by what breaks without each:

- **The `clearTimeout` reset** — drop it and every keystroke schedules a *separate* fetch; you get a burst
  of N requests for an N-character word, instantly rate-limited. This is the part that makes it a debounce
  and not just a delay.
- **The 3-char floor** — drop it and "a" fires a search returning thousands of irrelevant hits.
- **The `bounded: true` viewbox** — restricts results to a ~30km box around the data area
  (`searchViewbox`, `:51-54`), so "starbucks" returns a *local* Starbucks, not one in another state the
  graph doesn't cover.

**The reset is the kernel.** Here's the trace that shows why:

```
  execution trace — debounce reset on "cap"

  t0    type "c" → clearTimeout(none) → setTimeout A (400ms)
  t120  type "a" → clearTimeout(A) ✗  → setTimeout B (400ms)   ← A never fired
  t250  type "p" → clearTimeout(B) ✗  → setTimeout C (400ms)   ← B never fired
  t650  (400ms after last key) → C fires → ONE fetch("cap")

  without the reset: A, B, C all fire → 3 fetches → throttled
```

**Result routing — which field owns the suggestions.** A single `suggestions` array is shared, tagged with
`suggestField` (`MapScreen.tsx:67-68`). The AddressBar shows the dropdown under From *only* if
`suggestField === "from"` (`AddressBar.tsx:84-86`), and under To only if `=== "to"` (`:103-105`). One state
slot, disambiguated by a tag — simpler than two parallel arrays.

```
  Layers-and-hops — keystroke to dropdown

  ┌─ AddressBar ──────────────────────────────────────────────────┐
  │  TextInput onChangeText ──hop 1: text──►                       │
  └───────────────────────────────────────┬──────────────────────┘
                                           ▼
  ┌─ MapScreen ───────────────────────────────────────────────────┐
  │  setFromText (instant echo) + scheduleSuggest                  │
  │     ──hop 2: debounced fetch──► geocodeSuggest                 │
  │     ◄─hop 3: results──── setSuggestions + setSuggestField      │
  └───────────────────────────────────────┬──────────────────────┘
                                           ▼ hop 4: props down
  ┌─ AddressBar ──────────────────────────────────────────────────┐
  │  suggestField==="from" → <Suggestions> under From             │
  └────────────────────────────────────────────────────────────────┘
```

**Picking a suggestion closes the loop.** `onSelectSuggestion` fills the field, sets the endpoint
coordinate (feeding `02`), clears suggestions, dismisses the keyboard, and eases the camera
(`MapScreen.tsx:253-263`). Note it sets `startPt`/`endPt` as *coordinates* — same source-of-truth rule as
everywhere else.

**One more debounce, same shape.** Map panning is debounced 600ms before a tile fetch
(`useTileGraph.ts:254-255`, → `03-single-flight-tile-pump.md`). flattr uses debounce as its *only* throttle
across both the geocode and tile APIs — there's no token bucket anywhere; the reset-timer is the rate
control.

### Move 3 — the principle

When an input drives a rate-limited or expensive side effect, split the event into two cadences: update the
display synchronously (the UI must never lag the keystroke), and debounce the side effect (act only after
the user settles). The reset-on-each-event is the load-bearing part — without it you have a delay, not a
debounce, and a delay still fires once per keystroke.

## Primary diagram

```
  Debounced controlled input — full picture

  ┌─ AddressBar (controlled, presentational) ─────────────────────┐
  │  <TextInput value={fromText} onChangeText={onFromChange}>     │
  │  canRoute = derived(fromText, toText, busy)                   │
  │  dropdown shown iff suggestField === this field               │
  └────────────────────────┬──────────────────────────────────────┘
                           │ onFromChange(text)
  ┌─ MapScreen ────────────▼──────────────────────────────────────┐
  │  setFromText(text)            ← instant (UI echo)             │
  │  scheduleSuggest("from",text) ← debounced:                    │
  │     clearTimeout(prev) → if len<3 clear → setTimeout(400ms)   │
  │        └► geocodeSuggest(text, {viewbox, bounded})            │
  │             → setSuggestions + setSuggestField                 │
  └────────────────────────┬──────────────────────────────────────┘
                           │ Nominatim (~1 req/sec) — debounce keeps us under
                           ▼
                   onSelectSuggestion → setStartPt/setEndPt (coords) [02]
```

## Elaborate

Debounced typeahead is one of the oldest frontend patterns — the canonical reason `lodash.debounce` exists.
The modern React idiom folds it into the effect that consumes the value (or, in libraries, `useDeferredValue`
for the *render* side and a debounced fetch for the *network* side). flattr hand-rolls it with a ref-held
`setTimeout`, which is correct and minimal for one input. The `bounded` viewbox is the part most typeaheads
skip and shouldn't: scoping results to where your data actually lives is both a relevance and a
correctness win (no routing to a place you have no graph for).

If this grew to multiple inputs you'd extract a `useDebouncedCallback` hook; for one field the inline timer
is fine. React 19's `useDeferredValue` could handle the *suggestion-list render* lag but not the network
throttle — those are different problems (render priority vs request rate). Read next:
`02-coords-not-ids-endpoints.md` (where a picked suggestion lands), `03-single-flight-tile-pump.md` (the
parallel pan debounce).

## Interview defense

**Q: How do you keep a typeahead from hammering a rate-limited geocoder?**

Debounce the fetch, not the display. Every keystroke updates the controlled input's value synchronously so
the field never lags, but the network call goes through a `setTimeout` that I `clearTimeout` and reschedule
on each keystroke — so it fires once, ~400ms after the user stops typing. I also floor it at 3 characters
and bound results to a local viewbox so a one-letter query doesn't fire and "starbucks" returns a nearby
one. The reset is the load-bearing part: without `clearTimeout`, you'd schedule one fetch per character and
still get throttled.

```
  the part people forget: clearTimeout makes it a debounce

  no reset:  N keystrokes → N fetches (just delayed)  ✗
  reset:     N keystrokes → 1 fetch after the pause    ✓
```

**Q: One suggestions array, two fields — how do you know which dropdown to show?**

I tag the results with `suggestField` when they come back, and each field renders its dropdown only if the
tag matches. One state slot disambiguated by a field tag, rather than two parallel arrays that could drift
out of sync.

**Anchor:** "Controlled input echoes instantly; the geocode fetch is debounced with a reset-on-keystroke
timer, floored at 3 chars and bounded to a local viewbox — the `clearTimeout` reset is what makes it a
debounce instead of N delayed fetches."

## See also

- `02-coords-not-ids-endpoints.md` — where a picked suggestion's coordinate lands
- `03-single-flight-tile-pump.md` — the parallel 600ms pan debounce
- `study-networking` — Nominatim rate limits and the `bounded` query semantics
