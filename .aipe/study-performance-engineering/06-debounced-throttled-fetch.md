# Debounced + throttled fetch — the input-rate valve

> Industry name: **debounce (trailing) + inter-request throttle**. Type:
> Industry standard.

Typing in a search box, panning a map, and dragging a slider all produce events
faster than you can usefully act on them. flattr puts a debounce on each so the
expensive work fires once per settle, not once per keystroke — and a throttle
between API batches so it stays under rate limits.

## Zoom out — where this concept lives

The debounces sit at the UI edge, in front of every expensive downstream action:
geocode lookup, grade-tile build, elevation batch. They're the first valve.

```
  Zoom out — debounce/throttle at the UI edge

  ┌─ UI events (high rate) ───────────────────────────────────┐
  │  keystrokes · map pans · slider drags                     │
  └──────────────┬──────────────┬──────────────┬───────────────┘
       400ms     ▼      600ms    ▼     (none)   ▼
  ┌─ Debounce valves ───────────────────────────────────────────┐
  │  scheduleSuggest (MapScreen) · viewport (useTileGraph)      │ ← we are here
  └──────────────┬──────────────┬───────────────────────────────┘
                 │ once per settle
  ┌─ Downstream (expensive) ─▼───────────────────────────────────┐
  │  geocodeSuggest · fetchOverpass + buildGraph + elevation    │
  │  + inter-batch throttle 300-400ms (elevation.ts)            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: debounce is the "wait until they stop typing" timer you've written for a
search-as-you-type box. flattr has three of them at different delays, each tuned to
how expensive the thing it guards is.

## Structure pass — the skeleton

**Axis traced: how often does the expensive action fire per burst of input?**
Without the valve, once per event. With it, once per settle.

```
  One axis — "actions per input burst" — across the debounce seam

  ┌─ raw events ──────────────────────────────────────────────┐
  │  type "starbucks" = 9 keystrokes                          │  → 9 events
  └──────────────────────────┬─────────────────────────────────┘
        seam: clearTimeout + setTimeout (trailing debounce)
  ┌─ debounced action ───────▼────────────────────────────────┐
  │  fires 400ms after the LAST keystroke                     │  → 1 geocode call
  └────────────────────────────────────────────────────────────┘
```

The seam is the `clearTimeout`-then-`setTimeout` pair: each new event cancels the
pending timer and starts a fresh one, so the action only fires when events stop for
the delay window. Remove the `clearTimeout` and it becomes "fire 400ms after *every*
keystroke" — no coalescing, just a delay. The cancel is the load-bearing line.

## How it works

### Move 1 — the mental model

Trailing debounce: every event resets a countdown; the action runs only when the
countdown reaches zero uninterrupted. You've built this for autocomplete.

```
  The pattern — trailing debounce coalesces a burst to one trailing call

  keystrokes:  s  t  a  r  b  u  c  k  s            (gap > 400ms)
  timer:       ╳──╳──╳──╳──╳──╳──╳──╳──┐────────────▶ fires once
               each keystroke clears + restarts the timer
```

The three flattr debounces differ only in delay, tuned to cost:

```
  action            delay    why that number
  geocode suggest   400ms    a network call per settle; typing is fast
  viewport grades   600ms    fetchOverpass + buildGraph + elevation — expensive
  cache persist    4000ms    disk write; no rush, batch many puts into one
```

### Move 2 — the walkthrough

**Autocomplete debounce — 400ms.** Each keystroke clears the pending timer and
schedules a fresh one; only a 400ms gap lets the geocode fire:

```ts
// mobile/src/MapScreen.tsx:73-89 — trailing debounce on suggest
const scheduleSuggest = useCallback((field, text) => {
  if (suggestTimer.current) clearTimeout(suggestTimer.current);   // ← cancel pending
  if (text.trim().length < 3) { setSuggestions([]); return; }     // ← floor: don't search <3 chars
  suggestTimer.current = setTimeout(async () => {
    const results = await geocodeSuggest(text, { viewbox: searchViewbox, bounded: true, limit: 5 });
    setSuggestions(results);
  }, 400);                                                        // ← fire 400ms after last keystroke
}, [searchViewbox]);
```

Two valves in one: the `clearTimeout`/`setTimeout` debounce *and* a `< 3` character
floor that suppresses searches too short to be useful. Both cut request count.

**Viewport debounce — 600ms.** Panning fires `onRegionDidChange` continuously;
the build is gated behind a 600ms settle:

```ts
// mobile/src/useTileGraph.ts:245-256 — debounce the viewport build
const onRegionDidChange = useCallback((e) => {
  const { bounds } = e.nativeEvent;
  if (bounds[2]-bounds[0] > MAX_LOAD_SPAN_DEG || ...) return;  // zoomed out → skip
  lastBoundsRef.current = bounds;
  if (!gradesOnRef.current) return;                            // grades off → no load
  if (timerRef.current) clearTimeout(timerRef.current);        // ← cancel pending
  timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS);  // 600ms
}, [queueViewport]);
```

Longer delay (600 vs 400) because the guarded work is far heavier — a full
Overpass fetch plus graph build plus elevation, versus one geocode call. The
debounce feeds the single-flight pump (`02-single-flight-pump.md`), so the two
compose: debounce cuts how often a build is *requested*, the pump caps how many run
*at once*. Note the corridor path (`ensureBbox`, route requests) has **no** debounce
— a route is an explicit user action, not a continuous gesture, so it fires
immediately (`useTileGraph.ts:269-280`).

**Inter-batch throttle — 300-400ms.** Inside the elevation provider, a sleep
between batches keeps it under the free-tier rate even within one build:

```ts
// pipeline/elevation.ts:97,121 — throttle between batches
const delayMs = opts.delayMs ?? 300;
// ... after each batch ...
if (delayMs && i + OPEN_METEO_BATCH < points.length) await sleep(delayMs);
```

Mobile passes `delayMs: 400` (`useTileGraph.ts:191`). This is throttle, not
debounce — a *minimum spacing* between calls, not a wait-for-quiet.

```
  debounce vs throttle — different valves

  debounce:  ▮▮▮▮▮▮ (burst) ──wait quiet──▶ ▮ (one trailing)
  throttle:  ▮──gap──▮──gap──▮──gap──▮  (enforced min spacing)
```

### Move 3 — the principle

Match the valve to the input shape and the cost of the action. Debounce when input
comes in bursts and only the final value matters (search text, pan target).
Throttle when you must cap a sustained rate (API batches). flattr tunes the delay to
the cost of what's guarded — 400ms for a geocode, 600ms for a graph build, 4000ms
for a disk write — which is the judgment call that makes debouncing more than a
reflex. **Measurement gap:** none of the delays were tuned against measured input
distributions or downstream timings; they're sensible defaults, not data-derived.
Logging "events coalesced per settle" would tell you whether 600ms is right or
leaving latency on the table.

## Primary diagram

```
  Debounce + throttle — full recap

  ┌─ UI events ───────────────────────────────────────────────┐
  │  keystroke ──▶ scheduleSuggest: clear+set 400ms ──▶ geocode│
  │  pan ────────▶ onRegionDidChange: clear+set 600ms ─▶ pump  │
  │  route ──────▶ ensureBbox: NO debounce (explicit) ─▶ pump  │
  │  slider ─────▶ setUserMax (re-route, no fetch)            │
  └──────────────────────────┬─────────────────────────────────┘
                             │ inside each build:
  ┌─ elevation provider ─────▼────────────────────────────────┐
  │  batch 100 → sleep 300-400ms between batches (throttle)    │
  │  cache persist: debounced 4000ms (elevCache.ts)           │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Debounce and throttle are the two classic rate-limiting valves from UI engineering
(both in lodash, both reinvented constantly). The distinction people blur: debounce
collapses a burst to one trailing (or leading) call; throttle enforces a steady max
rate. flattr uses both, correctly distinguished — debounce on bursty UI input,
throttle on the sustained API batch loop. The choice of *trailing* debounce (fire
after quiet) over *leading* (fire immediately then suppress) matters for search:
you want the final query, not the first keystroke. This is the input-side complement
to the single-flight pump's output-side backpressure (`02-single-flight-pump.md`).

## Interview defense

**Q: You debounce autocomplete at 400ms but viewport at 600ms. Why different?**

The delay matches the cost of what fires. Autocomplete triggers one geocode network
call — cheap, and users type fast, so 400ms keeps it responsive. The viewport
debounce guards a full Overpass fetch + graph build + elevation sampling — far
heavier, and panning produces way more events than typing, so 600ms is worth the
extra wait to avoid kicking off a doomed build mid-pan.

Anchor: *"tune the debounce delay to the cost of the guarded action, not a global
default."*

**Q: What's the line that makes it a debounce and not just a delayed call?**

The `clearTimeout` before the `setTimeout`. Every event cancels the pending timer
and starts a new one, so the action fires only after input stops for the window.
Drop the `clearTimeout` and you get "run 400ms after *every* keystroke" — same
events, just shifted later, no coalescing. The cancel is what collapses the burst.

```
  with clear:    s t a r b → (quiet) → 1 call
  without clear: s t a r b → 5 calls, each 400ms late
```

Anchor: *"debounce is clear-then-set; without the clear it's just latency."*

## See also

- `02-single-flight-pump.md` — the output-side valve this feeds.
- `05-elevation-dedup-and-cache.md` — what the throttled batches fetch.
- `audit.md` lens 6 (debouncing/throttling).
- `study-frontend-engineering` — the RN event sources (`onRegionDidChange`, text input).
