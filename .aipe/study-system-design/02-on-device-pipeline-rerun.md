# On-Device Pipeline Re-Run

**Industry names:** incremental static regeneration (ISR) / on-demand
build / compute-at-the-edge. **Type:** Project-specific (a build pipeline
re-executed on a phone).

---

## Zoom out, then zoom in

The base artifact (`01-build-time-graph-artifact.md`) covers exactly one
bbox — a Capitol Hill slice (`pipeline/config.ts:10`). So what happens when the
user pans to Ballard, or routes across town? The naive answer is "ship a bigger
artifact" or "add a backend." flattr does neither: it **runs the same build
pipeline on the phone** for whatever area you need, right then.

```
  Zoom out — where the on-device re-run lives

  ┌─ RUNTIME (Expo RN, device) ──────────────────────────────────────────┐
  │  loadGraph() → baseGraph   (covers ONE bbox)                          │
  │       │                                                               │
  │       │  user pans / routes past the base                            │
  │       ▼                                                               │
  │  ★ useTileGraph.ts ★  ← THIS CONCEPT                                  │ ← here
  │   RE-RUNS fetchOverpass → openMeteoProvider → buildGraph on-device   │
  │       │                                                               │
  │       ▼                                                               │
  │  mergeGraphs(base, new region) → directedAstar → UI                  │
  └──────────────────────────────────────────────────────────────────── ┘
       (the SAME pipeline/ code that ran at build time, now on the phone)
```

Zoom in: the concept is **using one codebase as both an offline batch build and
an on-demand runtime build.** The question it answers: *how does a backend-less
app cover more than its prebuilt slice?* By treating the device as a build
machine when it has to.

## Structure pass

**Layers.** Three nested levels inside the runtime:
- outer: the *React component* (`MapScreen`) that owns intent (pan, route).
- middle: the *hook* (`useTileGraph`) that decides when to build and serializes
  builds.
- inner: the *pipeline* (`buildGraph`, `fetchOverpass`) — the exact build-time
  code.

**Axis — `lifecycle` again, but inverted.** In `01` the question was "when is
the graph computed" and the answer at runtime was "never." Here we trace the
*same* axis but for areas *past the base*, and the answer flips:

```
  "when is this area's graph computed?" — traced across coverage

  ┌──────────────────────────────────────┐
  │ inside base bbox (config.ts:10)       │  → BUILD TIME (prebuilt)
  └──────────────────────────────────────┘
        │  pan / route crosses the base boundary
        ▼
  ┌──────────────────────────────────────┐
  │ outside base bbox                     │  → RUNTIME, on-device
  └──────────────────────────────────────┘  (useTileGraph re-runs pipeline)

  the seam is the EDGE of the base coverage — cross it, and "when" flips
  from build-time to request-time
```

**Seam.** The base bbox boundary. `useTileGraph.ts:233`
(`bboxContains(baseGraph.bbox, bounds)`) is the literal check — if the base
covers the area, do nothing; if not, build it now. That boundary is where the
whole "ISR for a graph" behavior lives.

## How it works

### Move 1 — the mental model

You know Next.js ISR: pages are prebuilt, but a request for an un-built page
triggers a build *on demand*, caches the result, and serves it. flattr is ISR
for a street graph. The base artifact is the prebuilt set; a pan or route into
uncovered territory is a request for an "un-built page," and the device builds
it.

The strategy in one sentence: **prebuilt by default; build-on-demand at the
edges, using the same builder.**

```
  The pattern — on-demand build, serialized through one slot

   intent (pan/route past base)
        │
        ▼
   queue request ──► pump() ──► busy? ─yes─► wait (one build at a time)
        │              │          │no
        │              │          ▼
        │              │   fetchOverpass(bbox)      ┐
        │              │   openMeteoProvider(...)   │ the SAME pipeline
        │              │   buildGraph(...)          │ that ran at build time
        │              │   prefixGraph(...)         ┘
        │              ▼
        │        store region, setState → re-merge → re-route
        └──► pump() again (drain next request)
```

The kernel is a **single-slot serializer** (`pump`) wrapping the build pipeline.
One build at a time, corridor before viewport, drain on finish.

### Move 2 — the walkthrough

**Use case.** Two triggers reach this code: panning the map (viewport coverage)
and setting both route endpoints (corridor coverage). Both end in the same
`pump`.

**Step 1 — decide if a build is even needed.** Before building, check whether
the base or an existing region already covers the area. This is the seam check:

```ts
// mobile/src/useTileGraph.ts:231-240 (queueViewport)
if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return; // 233: base covers → skip
if (covers(viewRef.current, bounds)) return;                   // 234: region covers → skip
// ...pad by ~20% so small pans don't re-fetch...
pendingViewRef.current = { bbox: [...], silent: false };       // 239: enqueue
pump();                                                         // 240: kick the builder
```

`covers` (`useTileGraph.ts:81-86`) only counts a region as covering if it's
*not degraded* — a flat-fallback region will be rebuilt when the user revisits
it. That's how self-heal (`04-honest-fallback-routing.md`) hooks in here.

**Step 2 — the pump serializes builds.** Only one build runs at a time, and a
corridor build (the active route) beats a viewport build (the heatmap):

```ts
// mobile/src/useTileGraph.ts:166-181 (pump, opening)
if (busyRef.current) return;                          // 167: one build at a time
let kind, req;
if (pendingCorridorRef.current) {                     // 170: corridor wins
  kind = "corridor"; req = pendingCorridorRef.current;
  pendingCorridorRef.current = null;
} else if (pendingViewRef.current) {                  // 174: else viewport
  kind = "view"; req = pendingViewRef.current;
  pendingViewRef.current = null;
} else return;                                         // 179: nothing queued
const { bbox, silent } = req;
busyRef.current = true;                               // 182: claim the slot
```

`busyRef` is the entire concurrency control — a boolean lock. `pendingXRef` are
single-slot mailboxes, so a flurry of pans collapses to the *latest* requested
bbox.

**Step 3 — run the exact build pipeline, on the device.** This is the heart.
The same `fetchOverpass` and `buildGraph` from `pipeline/` execute here:

```ts
// mobile/src/useTileGraph.ts:186-197 (inside pump's async body)
const osm = await fetchOverpass(bbox);                          // 186: Overpass, LIVE
let degraded = false;
const elev = bestEffortElevation(                              // 190: never throw
  cachedElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 })),
  () => { degraded = true; }                                   // 195: flag on fallback
);
const g = await buildGraph(kind, bbox, osm, elev,             // 197: SAME builder
                           MAX_SEG_M, { dedupePrecision: DEDUPE }, onPhase);
```

Line 197 is the punchline: `buildGraph` is `pipeline/build-graph.ts:12-30` —
the identical function `run-build.ts:46` calls at build time. The device is now
a build machine. The elevation provider is wrapped twice — once with a cache
(`05-elevation-provider-fallback.md`), once with best-effort fallback.

```
  Layers-and-hops — the on-device build crossing to external services

  ┌─ Hook (RN) ──────────┐ hop1: fetchOverpass(bbox)  ┌─ Overpass API ──┐
  │ useTileGraph.pump()  │ ─────────────────────────► │ overpass-api.de │
  │                      │ ◄───────────────────────── └─────────────────┘
  │                      │   OSM ways
  │                      │ hop2: elev.sample(points)  ┌─ Open-Meteo ────┐
  │                      │ ─────────────────────────► │ (cache miss     │
  │                      │ ◄───────────────────────── │  only)          │
  │                      │   meters                   └─────────────────┘
  │  buildGraph(...)     │ hop3: (all local, no network)
  │  prefixGraph(...)    │
  └──────────┬───────────┘
             │ hop4: setState(region) → React re-render
             ▼
  ┌─ Component (RN) ─────┐
  │ MapScreen re-merges  │ → directedAstar over base+region
  └──────────────────────┘
```

**Step 4 — namespace the result and store it.** The new graph's node/edge ids
would collide with the base, so `prefixGraph` namespaces them, and the result is
stored and `setState`-d to trigger a re-merge:

```ts
// mobile/src/useTileGraph.ts:198-205
const region = { bbox, graph: prefixGraph(g, kind), degraded }; // 198: namespace ids
if (kind === "corridor") { corridorRef.current = region; setCorridor(region); } // 201
else { viewRef.current = region; setView(region); }
```

`prefixGraph` and the merge that follows are `03-tile-merge-stitch.md`.

**Step 5 — drain.** In `finally`, release the lock and call `pump()` again so a
request that arrived mid-build runs next:

```ts
// mobile/src/useTileGraph.ts:222-224 (finally)
busyRef.current = false;   // 222: release
if (!silent) setLoadingStep(null);
pump();                    // 224: drain the next pending request
```

#### Move 2.5 — current state vs future state

Right now the device builds on demand against live free APIs. The base artifact
is the only prebuilt coverage.

```
  Phase A (now)                    Phase B (coverage scale)
  ───────────────                  ──────────────────────────
  base bbox prebuilt               many bboxes prebuilt offline
  everything else: on-device       served as tiles from storage
  build vs live Overpass           device fetches prebuilt tiles
  (useTileGraph.ts:186)            (no live Overpass in hot path)
```

The migration is cheap *because the pattern already separates "build" from
"where it runs."* `buildGraph` doesn't care if it runs on a laptop writing JSON
or on a phone returning an object. To move to Phase B you point `pipeline/` at
many bboxes (it already takes a bbox, `run-build.ts:46`) and swap
`useTileGraph`'s `fetchOverpass+buildGraph` for a tile fetch. The router, cost
model, and merge logic don't change at all.

### Move 3 — the principle

The principle is **write the expensive transform once, run it in whichever
lifecycle stage the situation demands.** Most teams write a build script and a
*separate* runtime path, and the two drift. flattr writes one pipeline and runs
it in two places — laptop and phone — so there's exactly one definition of "what
a graph is." The single-slot pump is the other half: when an expensive operation
can be triggered by rapid UI events, serialize it behind one lock and collapse
duplicate requests to the latest.

## Primary diagram

```
  On-device pipeline re-run — the full picture

  ┌─ Component: MapScreen ───────────────────────────────────────────────┐
  │  pan → onRegionDidChange (debounce 600ms)   route → ensureBbox        │
  └───────────────┬──────────────────────────────────────┬───────────────┘
                  │ queueViewport                         │ (corridor)
                  ▼                                       ▼
  ┌─ Hook: useTileGraph ─────────────────────────────────────────────────┐
  │  seam check (base/region covers? → skip)   useTileGraph.ts:233-234    │
  │            │ not covered                                              │
  │            ▼                                                          │
  │  pending mailbox → pump()  [busyRef lock, corridor > viewport]        │
  │            │                                                          │
  │            ▼  THE SAME pipeline/ code, on-device                      │
  │  fetchOverpass → bestEffort(cached(openMeteo)) → buildGraph → prefix  │
  │            │                                                          │
  │            ▼  setState(region) → finally: release + pump() (drain)    │
  └───────────────┬──────────────────────────────────────────────────────┘
                  │ region committed
                  ▼
  ┌─ merge + route ──────────────────────────────────────────────────────┐
  │  mergeGraphs([base, corridor, view]) → stitch → directedAstar(userMax)│
  └────────────────────────────────────────────────────────────────────── ┘
```

## Elaborate

This is the same realization the web SSG world reached with ISR and edge
functions: pure build-time generation can't cover an unbounded space, so you
keep the prebuilt fast path and add an on-demand builder for the long tail. What
makes flattr's version unusually clean is that the on-demand builder *is* the
build-time builder — `buildGraph` is one function, imported by both
`run-build.ts` and `useTileGraph.ts`. There's no "runtime version of the
pipeline" to keep in sync.

The cost is honest and named in `audit.md` §8: the interactive path now has a
hard dependency on a free public OSM endpoint. The mitigations (debounce,
viewport padding, span caps, the busy lock) are all in `useTileGraph.ts`. The
real fix at scale is Phase B above — prebuild tiles — which the architecture is
already shaped for.

Read next: `03-tile-merge-stitch.md` (how the built region attaches to the
base) and `05-elevation-provider-fallback.md` (the cache + best-effort wrap
around the elevation call at line 190).

## Interview defense

**Q: How does a backend-less app cover area beyond what it ships?**
It re-runs its build pipeline on the device. `useTileGraph.pump`
(`useTileGraph.ts:186-197`) calls the same `fetchOverpass` + `buildGraph` that
the offline build uses, for the panned or routed bbox, then merges the result
into the base graph. The base bbox boundary (`useTileGraph.ts:233`) is the
trigger — inside it, prebuilt; outside it, build on demand.

```
  inside base bbox      →  use prebuilt artifact (free, instant)
  outside base bbox     →  fetchOverpass + buildGraph on-device (live)
       ▲ the boundary check at useTileGraph.ts:233 routes between the two
```
Anchor: *it's ISR for a street graph — same builder, two lifecycle stages.*

**Q: How do you keep rapid pans from spawning a build storm?**
A single-slot serializer. `busyRef` (`useTileGraph.ts:167,182`) allows one
build at a time; pending requests sit in single-slot mailboxes
(`pendingViewRef`/`pendingCorridorRef`) so a burst of pans collapses to the
latest bbox. Builds are also debounced 600ms (`useTileGraph.ts:255`) and the
viewport is padded ~20% (`useTileGraph.ts:236`) so small pans don't trigger
anything. Corridor builds preempt viewport builds (`useTileGraph.ts:170`).

**Q: The load-bearing part people forget?**
The drain call in `finally` (`useTileGraph.ts:224`). The busy lock is obvious;
the part people drop is re-invoking `pump()` after release so a request that
arrived *during* a build still runs. Without it the queue stalls whenever a
request races a build.

## See also

- `01-build-time-graph-artifact.md` — the base case this extends
- `03-tile-merge-stitch.md` — how the built region attaches
- `04-honest-fallback-routing.md` — the degraded-region self-heal that feeds `covers`
- `05-elevation-provider-fallback.md` — the elevation wrap at line 190
- `audit.md` §2 (data flow), §7 (scale bottlenecks)
