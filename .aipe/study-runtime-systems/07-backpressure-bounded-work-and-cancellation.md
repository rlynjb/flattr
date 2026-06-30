# Backpressure, Bounded Work, and Cancellation — overload and the missing stop button

**Industry name:** backpressure / bounded concurrency / cancellation / deadlines — *Industry standard*.

## Zoom out, then zoom in

flattr's UI can produce work faster than its rate-limited network can consume it — pan
fires dozens of events a second, the free Overpass/Open-Meteo APIs allow roughly one build
at a time. Something has to absorb that mismatch. Here's where the throttling lives.

```
  Zoom out — where work is bounded before it hits the network

  ┌─ UI (fast producer) ─────────────────────────────────────────┐
  │  pan events · slider drags · keystrokes → bursty, high-rate   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ throttled by ↓
  ┌─ Bounding layer (useTileGraph) ──────────────────────────────┐
  │  ★ debounce 600/400ms · single-flight pump · coalesce slots ★ │ ← we are here
  │  ✗ NO cancellation of in-flight work                         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ slow, rate-limited
  ┌─ Network (slow consumer) ────▼───────────────────────────────┐
  │  Overpass · Open-Meteo (~1 build at a time, backoff on 429)  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: two questions. First, **"how is fast UI work bounded down to slow network work?"**
— flattr answers with three stacked mechanisms (debounce → single-flight → coalesce).
Second, **"can in-flight work be cancelled when it's superseded?"** — flattr's answer is
*no*, and that gap is the most important `not yet exercised` in the whole guide.

## Structure pass — layers, one axis, the seams

**The layers:** producer (UI) → bounding layer → consumer (network). **The axis: "what
happens to excess work — is it dropped, queued, or cancelled?"**

```
  Axis: "fate of excess work?"  — traced across the bounding mechanisms

  ┌─ debounce ──────────────────────────────────┐
  │  burst of pans                               │  → DROPPED (only the last survives)
  └────────────────────────────────────────────────┘
      ┌─ single-flight pump ────────────────────┐
      │  call while busy                         │  → DROPPED at the guard
      └────────────────────────────────────────────┘
          ┌─ coalesce slot ─────────────────────┐
          │  multiple pending requests           │  → OVERWRITTEN (latest wins)
          └────────────────────────────────────────┘
              ┌─ in-flight build (superseded) ──┐
              │  user moved on mid-build         │  → RUNS TO COMPLETION ✗
              └────────────────────────────────────┘    never cancelled
```

The answer is "dropped/coalesced" at every layer *before* work starts — and "runs to
completion" once it has. **The seam is the moment a build commits**: before it, excess is
shed cheaply; after it, there's no stop button. That asymmetry is the lesson. Hand off to
How it works.

## How it works

### Move 1 — the mental model

You know backpressure from a search box: type fast, and you debounce so you fire one request
at the end, not one per keystroke. flattr stacks three of these throttles, then has a gap:
once a request is *in flight*, there's no way to abort it if it's no longer wanted. The
strategy: **shed excess work cheaply before it starts (debounce + single-flight + coalesce),
and let the rate-limited network be its own backpressure — but accept that stale in-flight
work finishes uselessly because nothing cancels it.**

```
  Bounded-work kernel — three throttles, then a one-way door

   producer fast ──► [debounce] ──► [single-flight] ──► [coalesce] ──► consumer slow
                      drop burst      drop if busy        latest wins
                                                              │
                                                       build commits
                                                              ▼
                                                   ✗ NO CANCEL: runs to end
```

### Move 2 — the parts, one at a time

**Part 1 — debounce: bound the *rate* of new work.** The first throttle. A pan burst becomes
one queued build after 600ms of stillness; typing becomes one geocode after 400ms (`03`
walks the timers). What breaks without it: every pan event starts the pipeline below. The
debounce caps *how often* work enters the system.

**Part 2 — single-flight: bound the *concurrency* to one.** The pump's `busyRef` guard (`04`
walks it in full) ensures one build at a time. This is the load-bearing backpressure: the
free APIs can't take concurrent builds, so the guard enforces serialization.

```
  Single-flight as backpressure — concurrency capped at 1

  requests: ││││││  ──► [busyRef gate] ──► ─build─ ─build─ ─build─
            6 arrive        1 passes          (strictly sequential)
```

**Part 3 — coalesce: bound the *queue depth* to one-per-kind.** Pending requests overwrite a
single slot rather than queueing (`04`, Part 2). This caps backlog at one view + one
corridor — you never accumulate a drainable queue of stale viewports. What breaks without
it: an unbounded queue that takes minutes to drain after a fast pan. The single slot is a
queue of depth 1, which *is* the bound.

**Part 4 — the network as its own backpressure (backoff).** Below the app, the rate-limited
APIs push back via 429s, and flattr respects that with exponential/linear backoff (`03`,
Part 3). This is backpressure flowing *upward* from the consumer: a throttled API slows the
build, which holds `busyRef`, which keeps the next pending request waiting. The whole stack
self-paces to the slowest resource.

```
  Backpressure flows upward from the slow consumer

  Open-Meteo 429 ──► backoff sleep ──► build slower ──► busyRef held longer
       ──► pending requests wait ──► UI naturally paces itself to the API
```

**Part 5 — bounded *scope*: refuse work that's too big.** Beyond rate, flattr bounds the
*size* of work. Three hard caps refuse oversized requests outright:

```ts
// mobile/src/useTileGraph.ts:269-272 — refuse a corridor wider than ~13km (too far to route)
const ensureBbox = useCallback((bbox: Bbox): boolean => {
  const [w, s, e, n] = bbox;
  if (e - w > MAX_CORRIDOR_SPAN_DEG || n - s > MAX_CORRIDOR_SPAN_DEG) return false;  // ← reject
  // ...
```

```ts
// mobile/src/useTileGraph.ts:249-251 — don't load when zoomed out past ~a few km
if (bounds[2] - bounds[0] > MAX_LOAD_SPAN_DEG || bounds[3] - bounds[1] > MAX_LOAD_SPAN_DEG) {
  return;  // ← zoomed out too far: load nothing
}
```

And the self-heal retry is capped at `MAX_RETRIES = 6` so a sustained outage doesn't loop
forever (`useTileGraph.ts:209`). What breaks without these caps? A route across the country
would try to fetch and build a continent of graph; a world-view pan would fetch everything.
The size caps are admission control — reject work that can't succeed before doing any of it.

**Part 6 — the gap: NO cancellation.** Here's the finding. Once a build starts, nothing
stops it. There's no `AbortController`, no `AbortSignal`, no cancellation token anywhere in
the repo (verified: grep returns zero hits). Concretely:

```
  The cancellation gap — superseded work runs to completion

  user pans to area A ──► build A starts (busyRef held)
  user pans to area B ──► request B overwrites the pending slot
       │
  build A is STALE (user is looking at B) but...
       └─ build A runs to completion: full Overpass fetch + elevation + buildGraph
          → only THEN does pump() drain B
       → A's result is even written to viewRef/setView (useTileGraph.ts:200-205)
         before B starts
```

The consequences are concrete: (1) **wasted network** — a stale build still makes its full
Overpass + Open-Meteo round trips against rate-limited free APIs; (2) **latency** — B can't
start until A finishes, so the area you're *actually* looking at waits behind the area you
left; (3) **visual flicker** — A's result is committed to state (`setView(region)`) before B
runs, so you may briefly see the stale graph paint in. The coalesce slot bounds the *queue*
but can't cancel the *in-flight* item — that's the one-way door.

```
  Move 2.5 — current vs future: cancellation

  ┌─ NOW (no cancel) ───────────────┐   ┌─ WITH AbortController (not yet) ───┐
  │ build A runs fully even when     │   │ pump() holds an AbortController     │
  │ superseded by B                  │   │ new request → controller.abort()    │
  │                                  │   │ → fetch() rejects → build A bails   │
  │ wasted fetch + latency + flicker │   │ → B starts immediately              │
  └──────────────────────────────────┘   └─────────────────────────────────────┘
   Migration cost: thread an AbortSignal through fetchOverpass
   (overpass.ts:33) and openMeteoProvider (elevation.ts:109) — both already
   take an injectable fetch, so the signal slots into the existing fetch call.
   The build-graph CPU work between awaits would still need a checked flag.
```

*Trigger:* a measured stale-flicker bug, or wanting the area you're looking at to load
without waiting behind one you left. Until then, the debounce (600ms) makes superseded
builds rare — you usually stop panning before a build commits — which is *why* the gap has
been tolerable, not invisible.

**Graceful shutdown — not yet exercised.** The pipeline process just exits
(`run-build.ts:54-57`); the app has no unmount teardown of in-flight builds or pending
timers. *Trigger:* a long-lived server process, or a component-unmount path that must cancel
timers (the `setTimeout`s in `useTileGraph`/`elevCache` are never cleared on unmount —
*inference from the absence of a cleanup return in the effects*).

### Move 3 — the principle

Backpressure is about matching a fast producer to a slow consumer, and there are exactly two
levers: **slow the producer or shed its excess.** flattr sheds — debounce drops bursts,
single-flight drops concurrent calls, coalesce drops all-but-latest — and lets the
rate-limited consumer pace the whole stack from below. That covers everything *before* work
starts. The missing lever is cancellation: the ability to *un-start* work that's no longer
wanted. flattr has none, and the cost is bounded only because the debounce makes superseded
work rare. The general lesson: shedding excess at admission is cheap and flattr does it well;
cancelling committed work is harder and is the natural next investment once stale in-flight
work becomes a measured problem.

## Primary diagram

The full bounded-work picture — three throttles, the size caps, the cancellation gap.

```
  flattr bounded work — shed before start, no cancel after

  ┌─ UI (fast producer) ─────────────────────────────────────────┐
  │  pan / drag / type                                            │
  └───────────────────────────────┬──────────────────────────────┘
        ┌──── ADMISSION CONTROL (bound before any work) ──────────┐
        │  debounce 600/400ms        → drop burst                 │
        │  size caps (span limits)   → reject too-big             │
        │  single-flight (busyRef)   → drop if busy               │
        │  coalesce slot             → keep latest only           │
        └───────────────────────────┬─────────────────────────────┘
                                    ▼  build COMMITS (one-way door)
        ┌──── IN-FLIGHT (no cancel) ─────────────────────────────┐
        │  fetchOverpass → buildGraph → write result ✗ runs even  │
        │  when superseded → wasted fetch + latency + flicker     │
        └───────────────────────────┬─────────────────────────────┘
                                    ▼ backpressure flows UP
        ┌──── Network (slow consumer) ───────────────────────────┐
        │  Overpass / Open-Meteo: 429 → backoff → paces the stack │
        └─────────────────────────────────────────────────────────┘
```

## Elaborate

flattr's admission-control stack is the standard **load-shedding** toolkit: debounce (drop
high-frequency events), a concurrency limiter of 1 (single-flight), and a depth-1 coalescing
queue (the "latest wins" / `switchMap` shape). Backpressure-from-below via 429 + backoff is
the same mechanism TCP uses (a slow receiver's window stalls the sender) and that reactive
streams formalize (the consumer signals demand). The conspicuous gap — cancellation — is
exactly what `AbortController` was added to the platform to solve, and what RxJS gets free
via unsubscribe and `switchMap` (which *does* cancel the superseded inner observable). That
flattr coalesces but doesn't cancel is the precise difference between a depth-1 queue and a
true `switchMap`: both keep only the latest *request*, but `switchMap` also tears down the
latest *in-flight call*. Closing that gap is a contained change because flattr's I/O already
takes an injectable `fetch` (`overpass.ts:23`, `elevation.ts:93`) — the signal threads
straight in. For the single-flight mechanics, see `04`; for the timers, see `03`; for the
network-protocol view of the 429/backoff, see `study-networking`.

## Interview defense

**Q: "Panning fires events constantly but the APIs are rate-limited. How does the app not
melt the network?"**

Three stacked throttles before any request goes out: a 600ms debounce collapses a pan burst
to one build; a single-flight `busyRef` caps concurrency at one; and pending requests
overwrite a single slot so backlog never exceeds one-per-kind. Below that, 429 + backoff
lets the slow API pace the whole stack from below.

```
  burst → debounce(1) → single-flight(1) → coalesce(latest) → backoff-paced network
```

*Anchor:* "Shed excess at admission — debounce, limit-to-one, keep-latest — and let the
rate-limited API be its own backpressure."

**Q: "What's the biggest runtime gap here?"**

No cancellation. Once a build commits, nothing aborts it — there's no `AbortController` in
the repo. Pan past the area mid-build and the stale build still does its full Overpass +
elevation fetch, blocks the area you actually want, and even paints in before the new one
runs. The debounce makes it rare, not impossible. The fix is threading an `AbortSignal`
through the already-injectable `fetch`.

```
  pan A → build A commits → pan B → A runs to completion anyway → THEN B  (✗ no abort)
```

*Anchor:* "It coalesces the queue but can't cancel the in-flight call — that's the
difference between a depth-1 queue and a real `switchMap`, and it's the next thing I'd add."

## See also

- `04-shared-state-races-and-synchronization.md` — the single-flight pump in full.
- `03-event-loop-and-async-io.md` — the debounce timers and backoff loops.
- `08-runtime-systems-red-flags-audit.md` — the cancellation gap ranked against other risks.
- `study-networking` (sibling) — the 429/backoff as protocol-level behavior.
