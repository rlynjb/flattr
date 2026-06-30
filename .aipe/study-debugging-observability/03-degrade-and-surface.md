# Degrade-and-surface at the network seam

**Industry names:** graceful degradation · fallback with provenance · honest
degradation · self-healing retry. **Type:** Industry standard (the pattern);
Project-specific (this instance).

## Zoom out, then zoom in

When an external dependency fails, you have two bad options and one good one:
crash (bad), silently fake the data (worse — it lies), or fall back to safe data
*and tell everyone it's fake* (good). flattr does the third. This is the repo's
one complete "a failure became visible end-to-end" chain.

```
  Zoom out — where degrade-and-surface lives

  ┌─ UI layer (mobile/src) ─────────────────────────────────────┐
  │  MapScreen → RouteSummaryCard                               │
  │   note: "Grades approximate — elevation unavailable"  ★     │ ← surfaced here
  └─────────────────────────────┬───────────────────────────────┘
                                │  corridorDegraded: boolean
  ┌─ Hook layer (useTileGraph) ─▼───────────────────────────────┐
  │  bestEffortElevation()  → degraded flag → self-heal retry  │ ← decided here
  └─────────────────────────────┬───────────────────────────────┘
                                │  fetch (throws on 429)
  ┌─ Network / Provider ────────▼───────────────────────────────┐
  │  Open-Meteo elevation API (free, 90m DEM) — 429 when over   │ ← failure born here
  │  quota                                                      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **degrade to safe data, mark the data as degraded, carry
the mark all the way to the user.** A throttled elevation API doesn't break the
map — the build substitutes flat (0 m) elevation so streets still render and
routing still connects — but the flat data is *labelled* `degraded`, and that
label travels up through the hook to a visible note. The label is the
observability; without it, flat fallback is a silent lie that paints every grade
green.

## Structure pass

**Layers.** Provider (Open-Meteo) → hook (`useTileGraph`) → UI (`MapScreen` /
`RouteSummaryCard`). Three.

**Axis — trace "what does this layer know about the failure?" downward then up:**

```
  One axis: failure-knowledge — across the seam

  provider   →  THROWS (status 429) — full failure detail, then lost
  hook       →  CATCHES → reduces to one bit: degraded=true
  UI         →  RECEIVES the bit → renders a human note

  failure detail collapses to a boolean at the catch, then
  re-expands into a sentence at the screen
```

**Seam.** The load-bearing boundary is `bestEffortElevation`
(`useTileGraph.ts:20-31`). The axis flips hard there: *below* it, a 429 is an
exception that would kill the build; *above* it, the build always succeeds and
the failure survives only as the `degraded` boolean. That seam is where "fail the
whole build" becomes "succeed with a flag" — the single most important
observability decision in the runtime, because everything downstream depends on
that one bit being set honestly.

## How it works

### Move 1 — the mental model

You know how a `fetch()` with `.catch()` lets you render a fallback UI instead of
crashing? Same shape — except the fallback here also stamps the data so the rest
of the app knows it's looking at a substitute, not the real thing.

```
  Pattern — degrade, mark, surface

   provider.sample()
        │
        ▼
   ┌─────────┐  ok      ┌──────────────────┐
   │  try    │ ───────► │ real grades      │ degraded = false
   └────┬────┘          └──────────────────┘
        │ throws (429)
        ▼
   ┌─────────┐          ┌──────────────────┐
   │ catch   │ ───────► │ flat (0m) grades │ degraded = TRUE ★
   └─────────┘          └────────┬─────────┘
                                 │ the mark rides upward
                                 ▼
        routing: USE it (flat is fine for connectivity)
        display: EXCLUDE it (don't paint bogus green)
        UI:      "Grades approximate — retrying"
```

The strategy in one sentence: **catch the failure, return safe data with a
provenance flag, and branch every downstream consumer on that flag.**

### Move 2 — the walkthrough

**The seam — catch and mark.** This is the kernel. Six lines.

```ts
// mobile/src/useTileGraph.ts:20-31
function bestEffortElevation(p: ElevationProvider, onFallback: () => void): ElevationProvider {
  return {
    async sample(points) {
      try {
        return await p.sample(points);     // real elevation
      } catch {
        onFallback();                      // ← FLIP the degraded flag
        return points.map(() => 0);        // ← safe substitute: flat
      }
    },
  };
}
```

The `catch` does two things and both matter. `onFallback()` flips a `degraded`
local in the calling `pump` (`:191-195`) — that's the mark. `points.map(() => 0)`
returns flat elevation so `buildGraph` finishes — that's the degradation. Note
what it does *not* do: it doesn't log the error, doesn't keep the status code.
The full failure detail collapses to one bit here. (That information loss is
exactly why the human discipline is "curl the API yourself" — see `05-`.)

**Why flat is the right fallback, not an error.** The comment at `:18-19` states
it: *"Connectivity/coverage over fidelity."* A wrong grade still leaves a
*connected* street you can route over; a missing region breaks routing entirely.
Flat (0 m) is the safe default because grade-0 edges are always traversable — it
degrades fidelity, never connectivity.

**The mark rides up into a Region.** The flag is stamped onto the built region:

```ts
// mobile/src/useTileGraph.ts:75, 198
type Region = { bbox: Bbox; graph: Graph; degraded: boolean };
// …inside pump():
const region: Region = { bbox, graph: prefixGraph(g, kind), degraded };
```

Now `degraded` is durable state on the region, not a transient. Two consumers
branch on it, in *opposite* directions — and that opposition is the whole "all
grades green" bug fix:

```ts
// mobile/src/useTileGraph.ts:132-162 (abridged)
// ROUTING graph — INCLUDES degraded regions (flat is fine for connectivity):
const graph = stitchGraph(mergeGraphs([baseGraph, corridor?.graph, view?.graph]));

// DISPLAY graph — EXCLUDES degraded regions (don't paint bogus green):
const displayGraph = stitchGraph(mergeGraphs([
  baseGraph,
  ...(corridor && !corridor.degraded ? [corridor.graph] : []),   // ← gate
  ...(view && !view.degraded ? [view.graph] : []),               // ← gate
]));
```

This is the diagnostic insight made structural. The "all green" incident was the
heatmap painting flat-fallback grades as uniformly green, masking the real terrain
underneath. The fix wasn't a UI tweak — it was splitting state into two graphs so
the *display* one can refuse degraded data while the *routing* one keeps it. The
`degraded` flag is what makes that split possible.

**Self-heal — re-queue degraded regions quietly.** Marking isn't enough; the app
also retries until the grades come back real.

```ts
// mobile/src/useTileGraph.ts:209-218 (abridged)
if (degraded && retryCountRef.current < MAX_RETRIES) {   // capped: 6 retries
  retryCountRef.current += 1;
  retryRef.current = setTimeout(() => {
    if (viewRef.current?.degraded) pendingViewRef.current = { bbox: …, silent: true };
    // …re-queue, silent: true → no loader flash…
    pump();
  }, RETRY_MS);                                          // every 12s
}
```

`MAX_RETRIES = 6` caps the loop so a sustained outage doesn't retry forever
(`:65`). `silent: true` means the background self-heal doesn't flash the loading
overlay (`:116` comment) — the degraded note stays up, grades catch up quietly,
and a real (non-degraded) build stops the retry by clearing the flag.

**Surface — the note reaches the screen.** The flag exits the hook as
`corridorDegraded` (`:285`) and `MapScreen` turns it into a sentence:

```tsx
// mobile/src/MapScreen.tsx:372-377 (the note prop)
note={
  loadingGrades ? "Calculating grades…"
  : corridorDegraded ? "Grades approximate — elevation unavailable, retrying"
  : null
}
```

```
  Layers-and-hops — one bit's journey to the screen

  ┌─ Provider ──┐ hop 1: 429    ┌─ bestEffortElevation ─┐
  │ Open-Meteo  │ ────────────► │  catch → onFallback() │
  └─────────────┘  (throws)     └──────────┬────────────┘
                                  hop 2 │ degraded=true on Region
                                        ▼
                              ┌─ useTileGraph ──────────┐
                              │ corridorDegraded boolean│
                              └──────────┬──────────────┘
                                  hop 3 │ prop
                                        ▼
                              ┌─ MapScreen → SummaryCard┐
                              │ "Grades approximate…"   │ ← user sees it
                              └─────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

The kernel: **catch the failure + return safe data + set a provenance flag +
branch consumers on the flag.** Four parts.

- Drop the **catch** and a 429 crashes the whole build — connectivity lost over a
  fidelity problem. The catch is what trades "fail" for "degrade."
- Drop the **safe substitute** (return nothing/throw differently) and there's no
  graph to render — defeats the point of catching.
- Drop the **provenance flag** and you get the original bug: flat data flows
  everywhere unmarked, the heatmap paints it green, and the lie is invisible.
  *This is the part people forget* — silent fallback is worse than a crash because
  it's wrong without telling you.
- Drop the **consumer branching** (one graph for everything) and you can't make
  routing tolerant while keeping display honest — the two needs conflict and the
  flag has nowhere to land.

Optional hardening: the capped self-heal retry (`:209-218`) and the `silent`
no-flash refinement (`:116, :183`). The skeleton would work without retries —
it'd just stay degraded until the user re-pans. Retry is polish on top of an
honest-degradation core.

### Move 2.5 — current state vs future state

The *surfacing* is shipped and honest. What's **`not yet exercised`** is
*persistence* of the failure.

```
  Phase A (now)                    Phase B (when shipped to real users)
  ───────────────                  ──────────────────────────────────
  429 → degraded boolean           429 → degraded boolean
  → in-band note on screen         → in-band note  AND
  → discarded after render         → counted: "degrade rate over 5 min"
  → error detail (status) lost     → logged: {bbox, status, retryCount}
  → curl-the-API to investigate    → alert when rate > threshold

  what DOESN'T change: the degrade-and-mark seam. The flag is already
  the right shape — Phase B just taps it instead of dropping it.
```

The takeaway: the hard part (deciding to degrade, marking provenance, surfacing
it) is done. Adding metrics/logging later is *tapping the existing flag*, not
re-architecting. That's why the audit calls metrics `not yet exercised` rather
than `missing` — the signal exists, it's just not persisted.

### Move 3 — the principle

**A fallback without provenance is a lie.** Degrading to safe data keeps the
system up; marking the data as degraded keeps the system *honest*. The single
most common failure of graceful degradation is forgetting the second half —
silently substituting fake data so the system *looks* healthy while serving
wrong answers. The discipline that generalizes: every fallback carries a flag
that says "this is a fallback," and every consumer decides for itself whether
fallback data is acceptable (routing: yes; display: no). The flag is the cheapest
observability you'll ever add and the one whose absence hurts most.

## Primary diagram

The full chain — failure born at the provider, degraded-and-marked at the seam,
branched two ways, retried, surfaced.

```
  Degrade-and-surface — end to end

  ┌─ Provider: Open-Meteo ─────────────────────────────────────┐
  │  sample(points) → 429 (quota exhausted)  → THROWS          │
  └────────────────────────────┬───────────────────────────────┘
                               │ caught at the seam
  ┌─ Seam: bestEffortElevation (useTileGraph.ts:20) ───────────┐
  │  catch → onFallback() [degraded=true] → return flat (0m)   │
  └────────────────────────────┬───────────────────────────────┘
                               │ Region { bbox, graph, degraded:true }
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
       routing graph     display graph      self-heal retry
       INCLUDES it       EXCLUDES it        re-queue silent,
       (connectivity)    (no bogus green)   capped 6×, every 12s
              │                                  │ real build clears flag
              ▼                                  ▼
  ┌─ UI: MapScreen / RouteSummaryCard ─────────────────────────┐
  │  note: "Grades approximate — elevation unavailable, retrying"│
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Graceful degradation is old (circuit breakers, fallback caches); the part flattr
gets right and most systems get wrong is *provenance*. The "all grades green"
incident is the textbook failure mode: a silent fallback that makes the system
*look* healthier than it is, hiding the real signal under uniform fake data. The
fix — split routing-state from display-state so each can set its own tolerance
for degraded data (`:132-162`) — is a clean separation-of-concerns move that only
became possible once the `degraded` flag existed to branch on.

Note the seam connects to two neighbor guides. The 429/backoff/retry transport
mechanics (the exponential backoff in `openMeteoProvider`, `elevation.ts:114-117`)
are `study-networking`'s lens. The fallback-as-architecture is `study-system-
design`'s. This guide owns only the *observability* slice: how the failure becomes
visible. The curl-first habit that compensates for the lost error detail is `05-`.

## Interview defense

**Q: Your elevation API gets rate-limited. How does the user find out the grades
they're seeing might be wrong?**

I degrade to flat elevation so the map still works, but I mark that region
`degraded` at the catch point (`useTileGraph.ts:20`). That flag rides up to a
visible note — "Grades approximate — elevation unavailable, retrying"
(`MapScreen.tsx:375`). Routing still uses the flat region because flat is fine for
connectivity; the heatmap *excludes* it so it doesn't paint bogus green over real
terrain.

```
  429 → catch → degraded=true ──┬──► routing: keep (connectivity)
                                └──► display: drop (honesty) + note
```

Anchor: *the fallback is safe; the flag is what makes it honest. Silent fallback
was the original "all grades green" bug — fake data with no provenance.*

**Q: What's the one part of this people forget?**

The provenance flag. Everyone remembers to catch and substitute — that keeps the
app up. The part that's forgotten is *marking* the substitute, so downstream knows
it's fake. Without the `degraded` boolean, flat grades flow into the heatmap
unlabelled and the system lies cheerfully. The flag is six characters of state
and it's the difference between graceful degradation and a silent corruption.

Anchor: *catch + substitute keeps you up; the flag keeps you honest — and the
flag is the part that gets dropped.*

## See also

- `05-curl-the-api-first.md` — the discipline that compensates for the error
  detail this seam discards.
- `04-finite-blocked-as-diagnostic.md` — the other "stay honest about failure
  state" mechanism (steep vs disconnected).
- `audit.md` lens 6 (state snapshots — the two-graph split) and lens 7 (the
  incident).
- Neighbor guides `study-networking` (429/backoff) and `study-system-design`
  (fallback architecture).
