# Backpressure, bounded work, and cancellation

*Bounded concurrency, queues, overload, cancellation, deadlines, shutdown.*
**Type:** Industry standard (single-flight + debounce; cancellation absent).

## Zoom out, then zoom in

This is where the runtime story has the most tension. flattr has a real
backpressure mechanism (the `pump()` single-flight gate from `04-`), real
bounded work (debounce, batch sizes, span caps), and **no cancellation at
all**. Those three together define how the app behaves under overload:
it sheds load by collapsing bursts and refusing too-big requests, but it
never *stops* work it's already started — a superseded build runs to
completion, wasted, before the next one begins.

```
  Zoom out — load control on the runtime map

  ┌─ RUN process ────────────────────────────────────────────┐
  │  ★ debounce (collapse bursts) ★                           │ ← bounded
  │  ★ pump() single-flight (one build at a time) ★           │ ← backpressure
  │  ★ span caps (refuse too-wide routes/views) ★             │ ← admission control
  │  ✗ NO AbortController / no cancellation ✗                 │ ← the gap
  └──────────────────────────────────────────────────────────┘

  ┌─ BUILD process ──────────────────────────────────────────┐
  │  batch sizes (100/256) + inter-batch sleep                │ ← bounded I/O
  │  ✗ no SIGTERM handler / no graceful drain ✗               │ ← `not yet exercised`
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the question is *what happens when more work arrives than flattr
can do, and can it stop work it no longer needs?* The answer: it caps and
collapses the incoming work well, and it cannot cancel in-flight work at
all.

## Structure pass

**Layers.** Load control nests from "don't accept it" to "don't finish it":

```
  Layered decomposition — "how is excess work handled?" at each layer

  ┌───────────────────────────────────────────────┐
  │ outer: admission (span caps)                   │ → REJECT (return false/skip)
  └───────────────────────────────────────────────┘
      ┌─────────────────────────────────────────┐
      │ middle: debounce (collapse a burst)       │ → COALESCE (one timer)
      └─────────────────────────────────────────┘
          ┌─────────────────────────────────────┐
          │ inner: single-flight (one at a time)  │ → SERIALIZE (busyRef)
          └─────────────────────────────────────┘
              ┌─────────────────────────────────┐
              │ innermost: in-flight work        │ → CANNOT STOP (no cancel) ✗
              └─────────────────────────────────┘

  excess handled differently per layer — until the innermost, where
  the answer is "it runs to completion no matter what" (the gap)
```

**Axis — failure/overload containment.** Trace "where does excess work get
absorbed?" At admission, a too-wide request is rejected outright
(`ensureBbox` returns `false`). At debounce, a burst of pans becomes one
fetch. At single-flight, concurrent builds become sequential. But once a
build *starts*, there's no layer that contains it — it consumes its full
network + CPU cost even if the user already moved on.

**Seam.** The load-bearing boundary is **queued ↔ in-flight**. Everything
*before* a build starts is controllable (reject, coalesce, stash). Once it
crosses into "running," it's uninterruptible. That seam is exactly where
cancellation would live, and it's empty.

## How it works

### Move 1 — the mental model

You know backpressure from a saturated queue: when the consumer can't keep
up, you stop accepting (drop), slow the producer (throttle), or buffer
(queue) — but you never let unbounded work pile up. flattr does all three
of the "before it runs" moves and skips the "stop it running" move
(cancellation) entirely.

```
  Pattern — the four load-control moves, three present + one absent

   incoming work
        │
        ▼
   [ admission ]  too big? ──► REJECT          ✓ span caps
        │ ok
        ▼
   [ debounce ]   burst? ────► COALESCE to one  ✓ setTimeout
        │ one
        ▼
   [ single-flight ] busy? ──► STASH (1 slot)   ✓ busyRef
        │ free
        ▼
   [ run build ]  ──► (started) ──► CANNOT CANCEL  ✗ no AbortController
        │
        ▼  result or wasted work
```

### Move 2 — walk the mechanisms

**Admission control: span caps reject too-big work before it starts.**
`ensureBbox` returns `false` if the route's bounding box is wider than
~13 km — too far to route, refuse it. `onRegionDidChange` skips entirely
if the viewport is zoomed out past ~a few km. These are the cheapest
possible load shedding: the work never enters the system.

```
  Execution trace — admission decisions

  request                          span check          outcome
  ───────────────────────────────  ──────────────────  ──────────────
  route across 5 km                 < 0.12° → ok         build corridor
  route across 20 km                > 0.12° → REJECT     return false (no route)
  pan at city zoom (0.1° span)      > 0.06° → REJECT     skip, no fetch
  pan at street zoom (0.01° span)   < 0.06° → ok         schedule build
```

**Bounded work: debounce caps the *rate* of build attempts.** A pan fires
dozens of `onRegionDidChange` events; the 600ms debounce ensures only the
*last* one (after the user stops) actually schedules a build. The
autocomplete has the same 400ms cap. This bounds how often the gate is
even engaged. (Mechanism detail: `03-`.)

**Backpressure: single-flight serializes builds to one at a time.** This
is the `pump()` gate from `04-` — `busyRef` ensures one network build runs
at a time, and a request that arrives while busy is stashed in a one-deep,
last-write-wins slot. This is the core backpressure: no matter how fast
requests arrive, they're throttled down to a serial stream, and only the
latest of each kind survives.

```
  Pattern — single-flight as backpressure (one server, bounded queue)

   fast arrivals ──► [ busyRef: one in-flight ] ──► slow consumer (network)
                     [ pending: 1 slot, LWW   ]
                          │
                          └─ overflow policy: overwrite (keep latest),
                             NOT grow the queue → bounded by construction
```

**Bounded I/O: batch sizes and span caps bound the build's own size.**
Inside a build, elevation requests go out in batches of 100
(`OPEN_METEO_BATCH`), Google in 256, with an inter-batch sleep. The
segment-split granularity and bbox are capped so a single build's node
count stays phone-friendly. The work *per build* is bounded, not just the
*rate* of builds.

**The gap: nothing is cancellable.** Here's the missing layer. When a
build is in flight and the user pans away or picks a different route, that
build keeps running — full Overpass fetch, full elevation sampling, full
CPU — and only *then* does `pump()` drain the now-stale next request.
There's no `AbortController` threaded into `fetch`, no abort signal, no
"this build is obsolete, stop." The work isn't killed; its *result* is
just superseded when a newer request was queued behind it.

```
  Comparison — what flattr does vs cancellation

  flattr (no cancel):  build A starts ──── runs to completion ────► result A
                       (user moved on)     wasted network + CPU      (stale, but
                                                                      then pump
                                                                      drains B)

  with AbortController: build A starts ──X abort ──► fetch rejects ──► free thread
                        (user moved on)              immediately       for build B
```

**No graceful shutdown either.** The build process has no `SIGTERM`
handler and no drain — on error it sets `process.exitCode = 1` and lets
the loop empty (`run-build.ts:54-57`). There's no deadline on any fetch
(beyond Overpass's server-side `timeout:60`). These are `not yet
exercised` — fine for a manual CLI and a single-user app, relevant the
moment flattr runs unattended or serves concurrent users.

### Move 3 — the principle

Load control is a stack of cheaper-to-more-expensive moves: **reject
before you queue, coalesce before you run, serialize before you saturate —
and cancel what you no longer need.** flattr nails the first three and
skips the fourth. Skipping cancellation is acceptable when work is cheap
and short (today's tiny graph), and it becomes the dominant cost the moment
builds are slow and users change their minds mid-flight. The discipline
that transfers: every layer of admission/throttling you add only controls
work *before* it starts — controlling work *after* it starts is a separate
mechanism (cancellation), and you have to build it on purpose.

## Primary diagram

The full load-control stack — three present layers, one absent, the seam
between controllable and uninterruptible.

```
  flattr load control — the full stack, the gap marked

  INCOMING (pans, routes, keystrokes)
        │
  ┌─────▼──────────────────────────────────────────────┐
  │ ADMISSION   span caps: ensureBbox<0.12°, view<0.06° │ REJECT
  ├─────────────────────────────────────────────────────┤
  │ DEBOUNCE    600ms pan, 400ms suggest                │ COALESCE
  ├─────────────────────────────────────────────────────┤
  │ SINGLE-FLIGHT  busyRef + 1-deep LWW slots (corridor> │ SERIALIZE
  │                view priority)                         │
  ├═════════════════ SEAM: queued ↔ in-flight ═══════════┤
  │ IN-FLIGHT BUILD  Overpass + elevation + buildGraph    │ ✗ CANNOT
  │                  (full cost even if superseded)       │   CANCEL
  └───────────────────────────────────────────────────────┘
        │
        ▼  result (used, or stale-then-discarded)

  controllable above the seam; uninterruptible below it
```

## Implementation in codebase

**Use cases.** This stack runs on every interaction: panning (debounce →
single-flight), routing (admission → single-flight, corridor priority),
typing (debounce). The cancellation gap shows up whenever a user changes
their mind faster than a build completes.

Admission control — reject a too-wide route outright:

```
  mobile/src/useTileGraph.ts  (lines 156-166)

  const ensureBbox = useCallback((bbox: Bbox): boolean => {
    const [w, s, e, n] = bbox;
    if (e - w > MAX_CORRIDOR_SPAN_DEG || n - s > MAX_CORRIDOR_SPAN_DEG) return false;  ← REJECT
    if (covers(corridorRef.current, bbox)) return true;        ← already covered: no work
    pendingCorridorRef.current = bbox;                          ← else stash for the gate
    pump();
    return true;
  }, [pump]);
        │
        └─ MAX_CORRIDOR_SPAN_DEG (~13km) is admission control: a route too wide
           to serve is refused BEFORE any build — the cheapest load shed there is.
```

The debounce — collapse a burst of pan events into one scheduled build:

```
  mobile/src/useTileGraph.ts  (lines 138-148)

  if (timerRef.current) clearTimeout(timerRef.current);   ← cancel the prior timer
  timerRef.current = setTimeout(() => {
    if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;  ← skip: covered
    if (covers(viewRef.current, bounds)) return;                    ← skip: covered
    ...
    pendingViewRef.current = [...];                          ← stash latest viewport
    pump();
  }, DEBOUNCE_MS);
        │
        └─ clearing+resetting the timer per event is the coalesce: only the pan
           AFTER the user stops moving survives to schedule a build.
```

The in-flight build with the missing cancellation — note the `finally`
drains the *next* request only after the current one fully finishes:

```
  mobile/src/useTileGraph.ts  (lines 106-128, condensed)

  (async () => {
    try {
      const osm = await fetchOverpass(bbox);          ← NO abort signal passed
      const elev = bestEffortElevation(openMeteoProvider(...));
      const g = await buildGraph(kind, bbox, osm, elev, ...);  ← runs fully, always
      ... setView/setCorridor ...
    } catch { /* keep last region */ }
    finally {
      busyRef.current = false;
      pump();                                          ← only NOW drain the next
    }
  })();
        │
        └─ if the user panned away during `await fetchOverpass`, this build still
           runs to completion — full network + CPU — before pump() services the
           stale-superseding next request. An AbortController on fetchOverpass
           would let an obsolete build bail early. That's the gap. (audit 08-)
```

## Elaborate

The reject→coalesce→serialize→cancel ladder is the standard vocabulary of
overload handling — it's what a rate limiter, a debounced search box, a
`singleflight` cache, and an `AbortController`-wired fetch each contribute.
flattr's omission of the last rung is the most common one in real apps,
because cancellation is genuinely harder: you have to thread an abort
signal through every async boundary (`fetch`, the elevation loop, even a
chunked CPU search) and decide what partial state to discard. The
canonical fix is `AbortController` — create one per build, pass
`signal` into `fetchOverpass`/`fetchImpl`, abort it when a newer request
supersedes the current one, and check `signal.aborted` between elevation
batches. For the synchronous CPU search, "cancellation" means chunking the
loop (`02-`/`03-`) and checking an abort flag between chunks. Read `04-`
for the gate this builds on, and
[`.aipe/study-networking/`](../study-networking/) for where the abort
signal threads through the fetch layer.

## Interview defense

**Q: "How does the app handle a burst of pan events without hammering the
API?"**

Three layers. Admission: pans at too-far zoom are skipped
(`useTileGraph.ts:135`). Debounce: a 600ms timer collapses the burst to
one scheduled build (`:138-148`). Single-flight: `busyRef` serializes
builds to one at a time, with a one-deep last-write-wins slot so only the
latest viewport survives (`:90-104`). So N rapid pans become at most one
build.

```
  N pans ──► [reject far] ──► [debounce: 1] ──► [busyRef: serial] ──► 1 build
```

Anchor: *"Reject, coalesce, serialize — three rungs before any work
starts."*

**Q: "What happens to a build if the user changes their mind mid-flight?"**

It runs to completion anyway — that's the gap. There's no
`AbortController`; `fetchOverpass` and the elevation loop get no abort
signal (`useTileGraph.ts:108-112`). The stale build finishes, then
`pump()` drains the newer request. So obsolete work isn't cancelled, just
superseded — wasted network and CPU. The fix is an `AbortController` per
build, aborted when a newer request arrives.

```
  user moves on ──► build keeps running (full cost) ──► result discarded
                    (no abort) ──► THEN next build starts
```

Anchor: *"Everything above the queued↔in-flight seam is controllable;
below it there's no cancellation, so started work always finishes."*

## Validate

**Reconstruct.** Draw the four-rung load-control ladder (reject /
coalesce / serialize / cancel) and mark which three flattr has and which
it lacks, with the file:line for each present one.
(`useTileGraph.ts:159` reject, `:138` debounce, `:90` single-flight;
cancel absent.)

**Explain.** Why does panning around quickly never fire more than one
build at a time, even though each pan calls `pump()`? (Debounce collapses
the events to one, and `busyRef` rejects a second concurrent build —
`:138`, `:90`.)

**Apply.** Add cancellation to the viewport build. Name the API and the
exact call sites. (Create an `AbortController` in `pump()`; pass
`controller.signal` into `fetchOverpass`'s `fetchImpl` and the elevation
`fetchImpl`; store the controller in a ref; call `controller.abort()` at
the top of `pump()` when superseding an in-flight view build —
`useTileGraph.ts:104-112`.)

**Defend.** Argue that the missing cancellation is acceptable *today* and
name the trigger that flips it. (Builds over the tiny bbox are fast and
cheap, so a wasted one costs little; it flips the moment builds are slow —
big merged graph or slow network — and users change routes mid-build, at
which point wasted full-cost builds dominate latency. `config.ts:10`,
`useTileGraph.ts:106`.)

## See also

- `04-shared-state-races-and-synchronization.md` — the single-flight gate
- `03-event-loop-and-async-io.md` — debounce + backoff mechanics
- `02-processes-threads-and-tasks.md` — chunking the sync search to cancel it
- `08-runtime-systems-red-flags-audit.md` — the cancellation gap ranked
- [`.aipe/study-networking/`](../study-networking/) — threading abort through fetch
