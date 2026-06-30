# 05 — Debounce-as-throttle with degraded self-heal

**Industry names:** debounce; graceful degradation / fallback-and-retry; "best-
effort with self-heal." **Type:** Language-agnostic patterns, project-specific
composition.

## Zoom out, then zoom in

Two patterns you already use, composed: **debounce** (wait for the user to stop
moving before you act) and **graceful degradation** (when the API fails, don't
fail the screen — render *something* and retry quietly). flattr wires them around
the pump: pans are debounced before they queue, the elevation API failing falls
back to flat ground so streets still draw, and the flat regions silently retry
until real grades land.

```
  Zoom out — debounce + degrade around the pump

  ┌─ UI (MapScreen / Map) ────────────────────────────────────────┐
  │  pan → onRegionDidChange                                       │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ ★ debounce 600ms ★ (wait for pan to settle)
  ┌─ Hook (useTileGraph) ─────────▼───────────────────────────────┐
  │  queueViewport → pump → buildGraph                            │ ← we are here
  │       elevation API throttled? → flat 0m fallback (degraded)  │
  │       degraded region → ★ silent retry every 12s ★ → real     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the debounce is really being used as a *throttle valve* on an external
rate limit, and the degrade-then-retry is a self-healing loop that upgrades bogus
flat grades to real ones the moment the API recovers.

## Structure pass

**Layers:** (1) raw pan events → (2) debounce timer → (3) `queueViewport` →
(4) pump build → (5) degraded-fallback decision → (6) self-heal retry timer.

**Axis — failure (where does a throttled elevation API get contained?):**

```
  Axis: "where does an elevation-API failure get contained?"

  ┌─ pan stream ──────────────────┐  contained by DEBOUNCE:
  │  many events → one queued      │  most pans never even hit the API
  └───────────┬───────────────────┘
  ┌─ build ───▼───────────────────┐  contained by FALLBACK:
  │  elev throws → flat 0m, degraded│ build succeeds anyway, streets draw
  └───────────┬────────────────────┘
  ┌─ retry ───▼───────────────────┐  REPAIRED by self-heal:
  │  degraded → re-queue silently   │ flat grades upgrade to real
  └────────────────────────────────┘
```

**Seams (load-bearing):**
- the debounce timer (`:254–255`) — failure axis flips from "N requests" to "1."
- `bestEffortElevation` (`:20–31`) — flips from "build fails" to "build degrades."
- the degraded re-queue (`:209–218`) — flips from "permanently flat" to "self-heals."

## How it works

### Move 1 — the mental model

Debounce you know: reset a timer on every event, act only when it fires. The twist
here is *why* — not "the geocode is expensive" but "Overpass/Open-Meteo will 429
if I fetch per-pan-frame." And the degrade loop is a state machine: a region is
either `real` or `degraded`, and `degraded` is a transient state that retries
toward `real`.

```
  Pattern — debounce valve + degraded self-heal

  pans: │ │ │ │      (reset timer each)        ┌─ region states ─┐
        └────────┘ 600ms quiet → queue ONE     │ real            │◄─┐
                          │                      │ degraded ───────┼──┘ retry
                          ▼                      └─────────────────┘  every 12s
                  build → elev ok? → real         (capped at 6 tries)
                          elev throws → degraded (flat) → re-queue
```

The kernel — what breaks without each:
- **debounce** — remove it and every pan frame queues a build; the pump serializes
  them but you still issue a build per settle-point, hammering the API.
- **best-effort fallback** — remove it and one throttled elevation call fails the
  *whole* build; the streets vanish on a transient 429.
- **degraded flag + retry** — remove it and a region built during an outage stays
  flat-green forever; the user sees wrong grades with no recovery.
- **retry cap (`MAX_RETRIES = 6`)** — remove it and a sustained outage loops the
  retry forever, burning requests during the exact window the API is down.

### Move 2 — the walkthrough

**The debounce** — `useTileGraph.ts:245–256`:

```ts
const onRegionDidChange = useCallback((e) => {
  const { bounds } = e.nativeEvent;
  if (!bounds) return;
  if (bounds[2]-bounds[0] > MAX_LOAD_SPAN_DEG || ...) return;   // ① zoomed too far → skip
  lastBoundsRef.current = bounds;                                // ② remember for toggle-on
  if (!gradesOnRef.current) return;                             // ③ grades off → load nothing
  if (timerRef.current) clearTimeout(timerRef.current);         // ④ reset the timer (debounce)
  timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS); // ⑤ fire after 600ms quiet
}, [queueViewport]);
```

**①–③ Three early exits before the timer.** Zoomed out past `MAX_LOAD_SPAN_DEG`
(~a few km) → skip entirely (no point loading street grades at city scale). Grades
toggled off → load nothing, keep the map clean and make zero elevation requests.
`lastBoundsRef` is stashed so flipping grades *on* later loads exactly this view
(`:261–264`) without needing a fresh pan.

**④⑤ The debounce proper.** Every pan frame clears the previous timer and sets a
new one. Only 600 ms after the user stops does `queueViewport` run. The honest
naming: this is a debounce being used as a **throttle valve on a rate limit** — the
intent isn't UI smoothness, it's "don't fan out builds to a metered API." It pairs
with the pump (pattern `02`): debounce cuts the *number* of requests, the pump
serializes whatever survives.

**The best-effort fallback** — `:20–31` + `:189–197`:

```ts
function bestEffortElevation(p, onFallback) {
  return { async sample(points) {
    try { return await p.sample(points); }       // ① try the real elevation API
    catch { onFallback(); return points.map(() => 0); } // ② throttled → flat 0m, flag degraded
  }};
}
// in pump:
let degraded = false;
const elev = bestEffortElevation(cachedElevation(openMeteoProvider(...)), () => { degraded = true; });
const g = await buildGraph(kind, bbox, osm, elev, ...);
const region = { bbox, graph: prefixGraph(g, kind), degraded };  // ③ region carries its degraded flag
```

**①② Connectivity over fidelity.** A throttled elevation call returns flat (0 m)
elevation instead of throwing. The build *succeeds*: streets render, routing
connects (flat grades are fine for connectivity), and `degraded` is flagged so the
app knows the grades are bogus.

**③ The flag rides on the region.** `degraded: true` is part of the committed
`Region`. Downstream, the two graph memos read it differently — and *this* is the
clever bit:

```
  Layers-and-hops — one flag, two consumers

  ┌─ routing graph (:132) ────────────────────────────────────────┐
  │ INCLUDES degraded regions — flat grades are fine for connectivity│
  │ → "no route" stays distinct from "no flat route"               │
  └────────────────────────────────────────────────────────────────┘
  ┌─ display graph (:150) ─────────────────────────────────────────┐
  │ EXCLUDES degraded regions — so bogus all-green doesn't paint    │
  │ over the real grades underneath                                 │
  └────────────────────────────────────────────────────────────────┘
```

So a throttled region: you can still *route* through it, but the heatmap *won't
draw* it as fake-flat green. `corridorDegraded` (`:286`) surfaces this to the UI as
the "Grades approximate — elevation unavailable, retrying" note in
`RouteSummaryCard` (`MapScreen.tsx:376`).

**The self-heal retry** — `:209–218`:

```ts
if (degraded && retryCountRef.current < MAX_RETRIES) {       // ① cap the retries
  retryCountRef.current += 1;
  if (retryRef.current) clearTimeout(retryRef.current);
  retryRef.current = setTimeout(() => {
    if (viewRef.current?.degraded) pendingViewRef.current = { bbox: ..., silent: true }; // ② re-queue SILENT
    if (corridorRef.current?.degraded) pendingCorridorRef.current = { bbox: ..., silent: true };
    pump();                                                   // ③ run it through the same pump
  }, RETRY_MS);                                               // 12s later
}
```

**① Capped.** Six tries, then give up and keep the last (flat) data. Without the
cap, a sustained outage retries forever — burning requests while the API is down.

**② Silent re-queue.** The retry sets `silent: true`, so the loader overlay
*doesn't flash* while grades catch up in the background (the `silent` flag threads
through the whole pump — `:181–197` — suppressing `setLoadingStep`). User-driven
loads show the loader; self-heal retries don't.

**③ Same pump, same priority.** The retry doesn't have its own fetch path — it just
re-queues into the existing pending slots and calls `pump()`. A successful
(non-degraded) rebuild commits real grades and, because it's no longer degraded,
stops re-queueing. The loop self-terminates on success.

```
  State diagram — a region's degraded lifecycle

   [build] ──elev ok──► (real) ──────────────► done
      │
      └──elev throws──► (degraded, flat)
                            │ retry in 12s (silent), ≤6×
                            ▼
                     [rebuild] ──ok──► (real) ──► stops retrying
                            │
                            └──throws again──► (degraded) ──► retry (until cap)
```

### Move 3 — the principle

Debounce isn't only a UX smoother — against a metered upstream it's a demand
valve, and naming it that way tells you where to tune it (the rate limit, not the
frame rate). And graceful degradation is strongest when the fallback is *visibly
distinct* and *self-correcting*: flat ground that still lets you route, marked
"approximate," that quietly upgrades itself — rather than a hard failure or a
silent lie. The transferable move: make the degraded state a first-class flag on
the data, let each consumer decide whether to trust it, and give it a capped,
silent path back to healthy.

## Primary diagram

```
  Debounce + degrade self-heal — full picture (useTileGraph.ts)

  pan events ──► onRegionDidChange ──(clear+set timer)──► [debounce 600ms]
                   skip if: zoomed-out / grades-off              │
                                                                 ▼
                                              queueViewport ──► pump
                                                                 │
                                          ┌──────────────────────▼─────────────────┐
                                          │ fetchOverpass + buildGraph(elevation)   │
                                          │ elev throws → flat 0m, degraded=true    │
                                          └──────────────────────┬──────────────────┘
                                          commit Region{degraded} │
                          ┌──────────────────────────────────────┴───────────────┐
                          ▼                                                        ▼
            routing graph: INCLUDES degraded            display graph: EXCLUDES degraded
            (connectivity preserved)                    (no fake-green paint)
                          │
                          ▼  if degraded & tries<6
            retry in 12s (SILENT) → re-queue → pump → real grades → stop
```

## Elaborate

Debounce/throttle are the canonical rate-control primitives; the insight flattr
adds is using debounce specifically as upstream backpressure (the same role a
token bucket plays server-side). Graceful degradation traces back to progressive
enhancement and circuit-breaker thinking — fail soft, recover automatically. The
`degraded` flag traveling with the data and being interpreted differently by two
consumers (route vs display) is the sharp idea worth stealing: don't throw away
imperfect data, *label* it and let context decide. Read next:
`02-single-flight-pump.md` (the pump the retry re-queues into),
`06-persistent-write-behind-cache.md` (the cache that makes most retries
unnecessary), `study-networking` (the rate limits driving all of this).

## Interview defense

**Q: "Why debounce the map pans?"**
Not for UI smoothness — it's a throttle valve on a metered API. Each settled
viewport triggers an Overpass + Open-Meteo build, and those free tiers 429 under
load. Debouncing pans to one build per 600 ms of quiet (`:254`), then serializing
through the single-flight pump, keeps demand under the rate limit.

```
  many pans → [debounce 600ms] → one build → pump (serialized)
```
*Anchor: debounce here is backpressure on a rate limit, not a frame-rate fix.*

**Q: "What happens when the elevation API is throttled mid-build?"**
The build degrades instead of failing: `bestEffortElevation` catches the throw,
returns flat 0 m, and flags the region `degraded`. Streets still render and
routing still connects (flat grades are fine for connectivity), but the *display*
graph excludes degraded regions so bogus all-green doesn't paint over real grades.
The region then silently re-queues every 12 s, capped at 6 tries, upgrading to
real grades when the API recovers.

```
  elev throws → flat+degraded → route uses it / heatmap hides it → silent retry → real
```
*Anchor: the part people miss — the same flag is interpreted differently by the
routing graph (include) and the display graph (exclude).*

## See also

- `02-single-flight-pump.md` — the pump the debounce feeds and the retry re-queues.
- `06-persistent-write-behind-cache.md` — why revisited areas rarely need a retry.
- `audit.md` §4, §1.
