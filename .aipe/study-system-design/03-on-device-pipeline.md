# 03 — On-Device Pipeline (the seam that leaks)

*Industry names: client-side ETL · on-device data assembly · "build at the
edge." Type: Project-specific (a deliberate inversion of the build/runtime
split).*

---

## Zoom out, then zoom in

The clean story in `01-build-time-runtime-split.md` is "build offline, read
on-device." This file is about the part where that story isn't true. When you
pan the map past the bundled bbox, or ask for a route whose endpoints fall
outside it, the phone reaches back up across the seam and **runs the same build
pipeline locally** — Overpass fetch, elevation sampling, grade computation, the
whole DAG — for the area it needs.

Here's where that happens. Watch the arrow that points *up*, from runtime back
into the build layer:

```
  Zoom out — the runtime crossing back into build territory

  ┌─ BUILD-TIME MODULES (pipeline/*) ──────────────────────────────┐
  │  fetchOverpass · buildGraph · openMeteoProvider                 │
  └───────────────▲──────────────────────────────┬─────────────────┘
                  │  ✗ imported AND CALLED         │  designed call
                  │     at runtime                  │  (offline)
  ┌─ RUN TIME ────┴─────────────────┐   ┌─ BUILD TIME ▼────────────┐
  │ ★ useTileGraph.ts ★             │   │ run-build.ts (offline CLI)│ ← we are here
  │   on pan / on route, runs the   │   └───────────────────────────┘
  │   pipeline on the phone         │
  └─────────────────────────────────┘
```

Zoom in: the pattern is **on-device ETL** — extract (Overpass), transform
(split/grade), load (merge into the live graph), all on the phone, on demand.
The question it answers is *"how do you cover more than the bundled bbox without
a server?"* The answer flattr chose: don't add a server — move the build to the
client. The verdict up front: it's a clever expedient that *collapses the clean
boundary the whole system is organized around*, and it puts free-tier API calls
on the phone's critical path. Worth understanding precisely, because it's the
finding a reviewer will probe hardest.

---

## Structure pass

**Layers.** The runtime coverage layer has three nested levels:

```
  outer:  merged graph (useMemo)     — stitch(merge[base, corridor?, view?])
  middle: the pump (one build queue) — serialize on-device builds, prioritize
  inner:  one build run              — fetchOverpass → buildGraph → elevation
```

**Axis — control (who decides the next move?).** Hold it across the levels:

| Level | Who decides what happens next? |
|---|---|
| Merged graph | React — recomputes whenever base/corridor/view change |
| The pump | the **code** — a fixed policy: corridor before view, one at a time |
| One build run | the pipeline DAG — fixed stage order (same as offline) |

The flip that matters: at the outer level control is *reactive* (React drives
recomputation from state); at the pump level it's *imperative policy* (the code
enforces an order and a concurrency limit); at the inner level it's the *same
deterministic DAG* that runs offline. Three different control regimes stacked.

**Seams.** The load-bearing seam is the import line itself —
`useTileGraph.ts:11-13` importing from `pipeline/*`. That single import is where
the runtime/build boundary *fails to hold*: the trust axis (build is trusted,
offline, patient) flips to (runtime, on a phone, on the user's network) without
the data ever leaving the device for a server. That's the seam this whole file
studies.

---

## How it works

### Move 1 — the mental model

You know how a virtualized list fetches more rows as you scroll near the
bottom — it doesn't load everything up front, it materializes data just-in-time
for what's coming into view? This is that, but the "fetch more rows" is "build
more graph," and building means running the actual ETL pipeline, not hitting a
ready-made API.

```
  Pattern — just-in-time coverage by re-running the build

   pan / route request
        │
        ▼
   does current coverage contain the needed bbox?
        │ yes ─────────────────────────► skip (cache hit)
        │ no
        ▼
   run the pipeline on-device for that bbox  (Overpass → split → elev → grade)
        │
        ▼
   merge the new region into the live graph  (prefix → merge → stitch)
```

The thing that makes it a *leak* rather than a feature: the "run the pipeline"
box is the exact same code path that runs offline at build time. There's no
separate lightweight runtime fetcher — the runtime reuses the heavy build DAG.

### Move 2 — the load-bearing skeleton

This concept has a kernel: **the pump**. Isolate it — a single-flight builder
with a priority queue of pending bboxes.

#### Kernel part 1 — the single-flight guard (`busyRef`)

```
  pump():
    if busy: return            ← only ONE build runs at a time
    ...
    busy = true
    (async) { ...build...; busy = false; pump() }   ← drain next when done
```

What breaks if removed: drop the guard and a fast pan fires a dozen concurrent
Overpass + Open-Meteo builds. On free-tier APIs that's instant 429s across the
board, and on the phone it's a dozen graph builds competing for the JS thread.
The guard is what keeps the system under the rate limit. **Load-bearing.**

#### Kernel part 2 — the priority drain (corridor before view)

```
  pump():
    if busy: return
    if pending_corridor: pick corridor          ← route coverage wins
    else if pending_view: pick view             ← panning is lower priority
    else: return
    ...
    finally: pump()                              ← recurse to drain the next
```

```
  Pattern — the priority pump

  pending: [ corridor? ][ view? ]
                │ pump picks corridor first
                ▼
            ┌────────────┐  build runs   ┌──────────┐
            │ one build  │ ────────────► │ region    │ → setState
            └─────┬──────┘               └──────────┘
                  │ finally: pump() again
                  ▼
            drain the next pending (corridor still wins)
```

What breaks if removed: without the corridor-first rule, a user who sets a route
and then pans would have their route's coverage build starved behind viewport
builds — the route would hang waiting for pans to finish. Priority is what keeps
a pending route from being starved by scrolling. **Load-bearing.**

#### Kernel part 3 — the coverage check (the cache)

```
  before queuing a build:
    if base_graph contains bbox: skip       ← already bundled
    if current_view covers bbox: skip       ← already fetched
```

What breaks if removed: every tiny pan re-fetches and re-builds an area you
already have, hammering APIs and the JS thread for no new data. The
`covers`/`bboxContains` check is the cache-hit test. **Load-bearing.**

#### The one build run (the inner level)

When the pump fires, the inner work is the offline DAG verbatim, with two
runtime-specific knobs:

```
  one build:
    osm  = fetchOverpass(bbox)
    elev = bestEffortElevation( openMeteo(retries=1, delay=400) )   ← fail-fast + degrade
    g    = buildGraph(kind, bbox, osm, elev, maxSeg=90, dedupe)     ← SAME DAG as offline
    region = { bbox, graph: prefixGraph(g, kind) }                  ← namespace ids
    setState(region)
```

The two knobs are the only differences from the offline build: **fail-fast
retries** (1, not 3) so a throttled build degrades quickly instead of stalling
the screen, and **`bestEffortElevation`** which returns 0 m on failure rather
than aborting (see `06-elevation-provider-fallback.md`).

#### Optional hardening (not the kernel)

The debounce (600 ms) on pan, the span guards (`MAX_LOAD_SPAN_DEG`,
`MAX_CORRIDOR_SPAN_DEG`) that refuse builds when zoomed too far out or routing
too far, and the viewport padding (`VIEW_PAD`) that absorbs small pans — these
are hardening. Strip them and the system still works (and still re-runs the
pipeline), just with more wasted builds. They're tuning, not the skeleton.

### Move 2.5 — current state vs future state

This is the leak made explicit, against what the spec wanted.

**Phase A — as designed (spec §5, §11 D/E).** Beyond the bundled bbox, the
client *fetches* prebuilt tiles from Netlify Blobs (or routes server-side). The
phone never builds anything; the pipeline stays offline.

**Phase B — as built.** Beyond the bundled bbox, the client *builds* tiles
itself by running the pipeline on-device. The pipeline is no longer offline-only.

```
  Comparison — designed coverage vs built coverage

  AS DESIGNED                          AS BUILT (the leak)
  ───────────                          ───────────────────
  pan past bbox                        pan past bbox
      │                                    │
      ▼                                    ▼
  fetch prebuilt tile from Blobs       fetchOverpass + buildGraph ON PHONE
      │                                    │  (the whole ETL DAG)
      ▼                                    ▼
  merge tile into graph                merge built region into graph
      │                                    │
  pipeline stays OFFLINE               pipeline runs at RUNTIME
  phone does light reads               phone does heavy ETL on user's network
```

The honest read: Phase B ships *without a server*, which is why it exists — it's
the cheapest way to get pan-to-extend coverage for a solo project. The cost is
real: the clean build/runtime separation is gone, free-tier APIs are on the
phone's hot path, and the heaviest code now runs on the weakest device. The
migration back to Phase A is the same migration as the artifact one
(`01` Move 2.5) — replace the build call in the pump with a fetch call. The
pump, the priority logic, the merge/stitch all survive.

### Move 3 — the principle

When you don't have infrastructure, you can sometimes move the work to the
client instead of building a server — but be honest that you've inverted your
architecture's central boundary, not eliminated it. On-device ETL trades server
cost for client cost, network-once for network-per-pan, and a clean seam for a
leaky one. It's a legitimate solo-dev move; name it as a deliberate, reversible
tradeoff, not as the design.

---

## Primary diagram

The full on-device coverage machine, with the leak marked.

```
  On-device pipeline — full recap

  ┌─ MapScreen ─────────────────────────────────────────────────────────┐
  │  onRegionDidChange (pan)        ensureBbox (route corridor)          │
  └────────────┬───────────────────────────────┬───────────────────────┘
               │ debounce 600ms · cover-check    │ span-check · cover-check
               ▼                                  ▼
        pendingViewRef                     pendingCorridorRef
               └──────────────┬───────────────────┘
                              ▼
                    ┌─── pump() ────────────────────────────┐
                    │ if busy: return                        │
                    │ pick corridor first, else view         │  ← single-flight
                    │ busy = true                            │     + priority
                    └───────────────┬────────────────────────┘
                                    ▼
        ✗ LEAK: build-time pipeline, run on the phone
        fetchOverpass(bbox) ─► buildGraph(...) ─► bestEffortElevation
                                    │
                                    ▼
                    region = prefixGraph(g, kind) ─► setState
                                    │ finally: pump() (drain next)
                                    ▼
  ┌─ merged graph (useMemo) ─────────────────────────────────────────────┐
  │  stitchGraph( mergeGraphs([ base, corridor?, view? ]) )  → routable   │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** This fires whenever the user leaves the bundled Capitol Hill
bbox: panning the map to a neighboring block (viewport build), or routing
between two addresses that span beyond the bundle (corridor build). Both are
common — the bundled bbox is ~0.7 km square, so any real route exits it fast.

**The leak — the imports — `mobile/src/useTileGraph.ts` (lines 11-13).**

```
  import { fetchOverpass } from "pipeline/overpass";
  import { buildGraph } from "pipeline/build-graph";
  import { openMeteoProvider, type ElevationProvider } from "pipeline/elevation";
       │
       └─ THREE build-time modules imported into a runtime hook. This single
          import block is the boundary that the build/runtime split (file 01)
          says shouldn't be crossed — and is.
```

**The pump — single-flight + priority — `useTileGraph.ts` (lines 89-129).**

```
  const pump = useCallback(() => {
    if (busyRef.current) return;                      ← single-flight guard (kernel 1)
    let kind, bbox;
    if (pendingCorridorRef.current) { kind="corridor"; bbox=...; }  ← priority (kernel 2)
    else if (pendingViewRef.current) { kind="view"; bbox=...; }
    else return;
    busyRef.current = true;
    (async () => {
      try {
        const osm = await fetchOverpass(bbox);                       ← E: extract
        const elev = bestEffortElevation(openMeteoProvider(fetch,    ← fail-fast
                       { delayMs: 400, retries: 1 }));
        const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, ← T: transform (the DAG)
                       { dedupePrecision: DEDUPE }, setLoadingStep);
        const region = { bbox, graph: prefixGraph(g, kind) };        ← namespace ids
        if (kind === "corridor") { corridorRef.current = region; setCorridor(region); }
        else { viewRef.current = region; setView(region); }          ← L: load (into state)
      } catch {
        // keep last region; a later pan retries                     ← degrade, not fail
      } finally {
        busyRef.current = false;
        pump();                                                      ← drain next (kernel 2)
      }
    })();
  }, []);
```

**The cover-check cache — `useTileGraph.ts` (lines 45-53, 141-142, 160).**

```
  function covers(r, bbox): boolean {                 ← cache-hit test (kernel 3)
    const [w,s,e,n] = bbox;
    return r.bbox[0]<=w && r.bbox[1]<=s && r.bbox[2]>=e && r.bbox[3]>=n;
  }
  ...
  if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;  ← bundled already covers it
  if (covers(viewRef.current, bounds)) return;                    ← current view already covers it
       │
       └─ these two returns are what prevent re-building areas you already have.
          Without them every pan re-runs the pipeline.
```

**The corridor trigger — `mobile/src/MapScreen.tsx` (lines 131-140).**

```
  useEffect(() => {
    if (!startPt || !endPt) return;
    const M = 0.004;                                  ← ~1 tile of margin
    ensureBbox([ min(lng)-M, min(lat)-M, max(lng)+M, max(lat)+M ]);  ← build the corridor
  }, [startPt, endPt, ensureBbox]);
       │
       └─ when both endpoints are set, force a corridor build spanning them so
          start and end land in ONE connected component (else "no route").
```

---

## Elaborate

On-device ETL shows up wherever apps want offline/edge capability without server
cost: a maps app that vectorizes tiles locally, an analytics SDK that aggregates
events on-device before upload, a local-first app that derives views from a
synced log. The pattern is always "move the transform to where the data is
consumed." flattr's version is unusual only in that it re-uses its *offline build
pipeline verbatim* — the same `buildGraph` runs in both places, which is why
`build-graph.ts` is carefully free of `node:fs` (`build-graph.ts:2`). That
constraint is the seam that makes the leak possible.

The reason this is the repo's most important finding: it's invisible in the
architecture diagram unless you read the imports. The spec describes a clean
build/runtime split; the code honors it for the *bundled* path and inverts it
for the *extended* path. A reviewer who only reads the spec will be surprised;
naming it yourself — "I run the pipeline on-device to extend coverage without a
server, and here's what that costs" — is the senior move.

The fix path is known and cheap (Move 2.5): the pump's build call is the only
thing that changes to go back to fetched tiles. Everything that's actually hard
to get right — single-flight, priority, coverage caching, merge/stitch — stays.

Read next: `04-tile-merge-stitch.md` — how a freshly built region gets composed
into the live graph so routing crosses the seam between regions.

---

## Interview defense

**Q: Walk me through what happens when I pan the map.**
> `onRegionDidChange` fires, debounced 600 ms. It checks whether the bundled base
> graph or the current viewport already covers the new bounds — if so, nothing
> happens. If not, it queues a viewport bbox and calls `pump`. The pump is
> single-flight: one build at a time, corridor (route) priority over view (pan).
> The build itself runs the *actual pipeline on the phone* — Overpass fetch,
> elevation, grade — then merges the result into the live graph. So a pan can
> trigger build-time work at runtime.

```
  pan ─► debounce ─► cover-check ─► pump (1 at a time) ─► run pipeline ON PHONE ─► merge
```

**Q: Isn't that a violation of your build/runtime split?**
> Yes, deliberately. The bundled bbox honors the split — pure read, A\* local.
> But to cover anything beyond it without a server, I run the same `buildGraph`
> on-device. It's a real inversion of the architecture's central boundary, not
> an elimination of it. The cost is free-tier APIs on the phone's hot path and
> the heaviest code on the weakest device. I scoped it with single-flight,
> priority, debounce, and coverage caching to stay under rate limits. The clean
> fix is the spec's design: serve prebuilt tiles from storage. The migration only
> touches one line in the pump — fetch instead of build.

```
  bundled bbox: read-only (split honored)
  beyond bbox:  build on device (split inverted) ──► fix: fetch tiles, swap 1 call
```

**Q: What's the single most load-bearing part of this, and what breaks without
it?**
> The single-flight guard plus the corridor-first priority in `pump`. Drop
> single-flight and a fast pan fires concurrent builds that instantly 429 the
> free-tier APIs. Drop priority and a pending route gets starved behind viewport
> builds — the route hangs while you scroll. Together they're what make on-device
> ETL survivable on free infrastructure.

```
  no single-flight ─► concurrent builds ─► 429 storm
  no priority      ─► route starved behind pans ─► route hangs
```

---

## Validate

1. **Reconstruct.** Draw the pump loop: the busy guard, the corridor-before-view
   pick, the build, the `finally { pump() }` drain (`useTileGraph.ts:89-129`).
2. **Explain.** Why does the runtime build use `retries: 1`
   (`useTileGraph.ts:111`) when the offline build uses 3
   (`overpass.ts:27`)? What does fail-fast buy on a phone?
3. **Apply.** A user pans rapidly across five new tiles in two seconds. Trace
   how many builds run and in what order, given the debounce
   (`useTileGraph.ts:138-148`) and single-flight pump.
4. **Defend.** Argue for or against keeping on-device ETL versus adding a tile
   server, grounded in the rate-limit guards (`useTileGraph.ts:31,34,89-104`)
   and the spec's fork D (§11).

---

## See also

- `01-build-time-runtime-split.md` — the clean split this inverts.
- `02-bundled-graph-artifact.md` — the read-only path this extends.
- `04-tile-merge-stitch.md` — how built regions compose into one graph.
- `06-elevation-provider-fallback.md` — `bestEffortElevation` inside the build.
- `audit.md` §2 (data flow C), §8.1 (the leak, ranked #1).
- `.aipe/study-networking/` — Overpass/Open-Meteo retry + backoff on the wire.
- `.aipe/study-performance-engineering/` — on-device build latency cost.
