# Single-flight pump — concurrency=1 backpressure

> Industry name: **single-flight / bounded-concurrency queue with priority
> draining**. Type: Language-agnostic.

The tile loader could fire a dozen Overpass + elevation builds at once and get
the app rate-limited into uselessness. Instead it runs exactly one at a time,
corridor before viewport. This is the repo's backpressure layer.

## Zoom out — where this concept lives

The pump sits in the mobile data layer, between user gestures (pan, route) and
the free external APIs. It's the valve.

```
  Zoom out — the pump between gestures and the free APIs

  ┌─ UI (MapScreen.tsx) ──────────────────────────────────────┐
  │  pan → onRegionDidChange   ·   route → ensureBbox         │
  └──────────────┬───────────────────────┬─────────────────────┘
                 │ queueViewport          │ (corridor request)
  ┌─ Pump (useTileGraph.ts pump()) ─▼─────▼────────────────────┐
  │  ★ busyRef gate — ONE build at a time                     │ ← we are here
  │     corridor priority > viewport · drain next on finish   │
  └──────────────┬─────────────────────────────────────────────┘
                 │ one fetchOverpass + buildGraph
  ┌─ Provider (free APIs) ──▼─────────────────────────────────┐
  │  Overpass · Open-Meteo elevation (rate-limited)           │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this is a queue with depth-1 concurrency and a priority rule. You've
written the shape before without naming it — a `loading` flag that ignores a
second submit while the first request is in flight. Same idea, with two queues
(corridor, viewport) and a drain step so nothing's lost.

## Structure pass — the skeleton

**Axis traced: how many concurrent builds hit the API?** The answer flips at one
seam — the `busyRef` gate.

```
  One axis — "how many builds run at once?" — across the busyRef seam

  ┌─ gestures (unbounded) ────────────────────────────────────┐
  │  user can pan/route as fast as they want → N requests     │  → N (unbounded)
  └──────────────────────────┬─────────────────────────────────┘
              seam: busyRef.current gate (useTileGraph.ts:167)
  ┌─ pump() ────────────────▼─────────────────────────────────┐
  │  if busy: return (drop into pending slot, don't fire)      │  → 1 (bounded)
  └────────────────────────────────────────────────────────────┘
```

Above the gate, demand is unbounded (the user pans freely). Below it, exactly one
build runs. The pending refs (`pendingCorridorRef`, `pendingViewRef`) are
single-slot — a newer request overwrites an older pending one of the same kind, so
you don't queue stale work. That's the load-bearing design: **coalesce, don't
accumulate.**

## How it works

### Move 1 — the mental model

Think of the `loading` boolean you put on a submit button so a double-click
doesn't fire two POSTs. The pump is that, generalized: a `busyRef` flag, plus two
single-slot mailboxes (one for the high-priority corridor build, one for the
viewport build), plus a drain loop that picks the next mailbox when the current
build finishes.

```
  The pattern — one in flight, two single-slot mailboxes, drain on finish

   gestures ──▶ [ pendingCorridor ]  (priority)
            └─▶ [ pendingView     ]
                      │
              pump(): if busy → return
                      else take corridor-first, run ONE build
                      finally → pump() again  (drain next)
```

The part that breaks if you remove it: the `finally → pump()` re-call. Drop it and
the queue stalls — a request lands in a mailbox while a build is running, the build
finishes, and nothing ever picks the waiting request up. The drain is what keeps
depth-1 from becoming depth-stuck.

### Move 2 — the walkthrough

**The gate.** First line of `pump()` — if a build is running, bail. The request
that triggered this call already sat itself in a pending mailbox before calling
`pump()`, so nothing's lost:

```ts
// mobile/src/useTileGraph.ts:166-180 — the gate + priority pick
const pump = useCallback(() => {
  if (busyRef.current) return;              // ← depth-1 gate
  let kind: "corridor" | "view";
  let req: { bbox: Bbox; silent: boolean };
  if (pendingCorridorRef.current) {         // ← corridor wins
    kind = "corridor";
    req = pendingCorridorRef.current;
    pendingCorridorRef.current = null;
  } else if (pendingViewRef.current) {      // ← viewport second
    kind = "view";
    req = pendingViewRef.current;
    pendingViewRef.current = null;
  } else {
    return;                                 // ← nothing pending, idle
  }
```

Corridor-first is the priority rule, and it's a real one: a pending *route* must
not be starved by someone idly panning the map. The comment says it outright
(`useTileGraph.ts:164-165`).

**The single build + drain.** It flips `busyRef`, runs one `fetchOverpass` +
`buildGraph`, and in `finally` clears the flag and calls `pump()` again to drain
whatever arrived while it was busy:

```ts
// mobile/src/useTileGraph.ts:182-225 — run one, drain next
busyRef.current = true;
if (!silent) setLoadingStep("Fetching streets");
(async () => {
  try {
    const osm = await fetchOverpass(bbox);
    // ... buildGraph with cached + best-effort elevation ...
    const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, {...}, onPhase);
    // store region into corridorRef/viewRef + setState
  } catch {
    // Overpass failed — keep last region, a later pan retries
  } finally {
    busyRef.current = false;   // ← release the gate
    if (!silent) setLoadingStep(null);
    pump();                    // ← DRAIN: pick up anything that queued while busy
  }
})();
```

This is the layers-and-hops view of one drained build:

```
  Layers-and-hops — one pump cycle

  ┌─ Pump (JS) ──┐ hop1: fetchOverpass(bbox)   ┌─ Overpass API ─┐
  │ busyRef=true │ ──────────────────────────▶ │  OSM ways      │
  └──────┬───────┘ hop2: OSM ◀──────────────── └────────────────┘
         │ hop3: buildGraph → elev.sample(miss) ┌─ Open-Meteo ──┐
         │ ────────────────────────────────────▶│  elevation    │
         │ hop4: elevations ◀─────────────────── └────────────────┘
         │ hop5: setCorridor/setView (state)
         ▼ hop6: finally → busyRef=false → pump() drains next
```

**Coalescing.** Because each pending ref is a single slot, a fast pan that fires
`queueViewport` five times leaves only the *last* bbox in `pendingViewRef`
(`useTileGraph.ts:239`) — the four older ones are overwritten, never fetched.
Combined with the 600ms debounce upstream (`06-debounced-throttled-fetch.md`),
rapid panning produces at most one build per settle, not one per frame.

**Bounded self-heal.** When a build degrades to flat elevation (API throttled), it
re-queues itself with a cap — `MAX_RETRIES = 6` (`useTileGraph.ts:65,209-218`) — so
a sustained outage retries a bounded number of times and then stops, rather than
looping forever. That's backpressure against your *own* retry storm.

### Move 3 — the principle

Backpressure is about making demand meet capacity at a valve you control, not at
the API that rate-limits you. The pump puts the valve in your own process:
unbounded gestures above, depth-1 below, with priority and coalescing so the one
slot goes to the most important non-stale work. The shape — flag + single-slot
mailbox + drain-on-finish — is the minimal correct version. **Measurement gap:**
queue depth, wait time, and how often coalescing fires are all reasoned about in
comments, never counted. Adding a `pendingDroppedCount` would make the coalescing
win visible.

## Primary diagram

```
  Single-flight pump — full recap

  ┌─ UI gestures (unbounded) ─────────────────────────────────┐
  │  pan → debounce 600ms → queueViewport → pendingViewRef    │
  │  route → ensureBbox → pendingCorridorRef                  │
  └──────────────────────────┬─────────────────────────────────┘
                  pump(): busyRef gate (depth-1)
         ┌──────────────────┴──────────────────┐
         │ corridor pending? → run it (priority)│
         │ else view pending? → run it          │
         │ else → idle                          │
         └──────────────────┬──────────────────┘
              run ONE fetchOverpass + buildGraph
              degraded? → re-queue silent, capped MAX_RETRIES=6
                            │
                  finally: busyRef=false → pump() (drain)
```

## Elaborate

This is the "single-flight" pattern (Go's `singleflight`, SWR/React-Query's
dedup): collapse concurrent demand for the same resource into one in-flight
operation. flattr's twist is two priority classes and coalescing instead of
caching the promise. It pairs with the system-design boundary between build-time
(`pipeline/`, runs once, no concurrency concern) and run-time tile loading
(`mobile/`, where concurrency must be bounded) — see `study-system-design`. The
"why one at a time" reason is the free-tier API quota, which the
`05-elevation-dedup-and-cache.md` defenses then minimize further.

## Interview defense

**Q: Why concurrency=1 and not, say, 3 parallel builds for speed?**

The bottleneck isn't local CPU, it's the free Overpass/Open-Meteo quota — the
project context literally notes Open-Meteo 429s under heavy testing. Three
parallel builds would hit the rate limit three times faster and degrade *all* of
them to flat-fallback. Depth-1 trades latency-under-no-contention for not getting
throttled. With the persistent elevation cache absorbing revisits, the latency cost
is small in practice.

Anchor: *"the scarce resource is the API quota, so the valve is depth-1."*

**Q: What's the part that breaks if you remove it?**

The `finally → pump()` drain. Without it, a request that arrives mid-build sits in
its mailbox forever — the build finishes, releases `busyRef`, and nothing re-checks
the mailboxes. The queue silently stalls. People remember the busy gate; the drain
is the part that makes depth-1 not become depth-stuck.

```
  busy gate alone:  request waits → build ends → ??? (stuck)
  + drain:          request waits → build ends → pump() picks it up ✓
```

Anchor: *"single-flight without a drain-on-finish is a deadlock with extra steps."*

## See also

- `06-debounced-throttled-fetch.md` — the debounce that feeds the pump.
- `05-elevation-dedup-and-cache.md` — what makes depth-1's latency cost small.
- `audit.md` lens 3 (throughput), lens 6 (backpressure).
- `study-system-design` — the build-time/run-time boundary this sits behind.
