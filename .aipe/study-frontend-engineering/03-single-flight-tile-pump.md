# Single-flight tile pump — the `useTileGraph` fetch machine

**Industry name(s):** single-flight / request coalescing + priority queue + debounce + self-heal retry.
**Type:** Industry-standard primitives, project-specific composition.

## Zoom out, then zoom in

flattr ships with one neighborhood bundled (`graph.json`). Pan or route outside it and the app fetches
more street + elevation data on the fly. The naive version — one fetch per map tile — would hammer the
free Overpass and Open-Meteo APIs into rate-limit oblivion. `useTileGraph` is the hook that turns chaotic
user input (pans, route requests, retries) into *one network build at a time*, prioritized, debounced, and
self-healing.

```
  Zoom out — the data layer of the frontend

  ┌─ UI (MapScreen) ──────────────────────────────────────────────┐
  │  pan → onRegionDidChange    route → ensureBbox                 │
  └───────────────┬──────────────────────┬────────────────────────┘
                  │ debounce             │ immediate
  ┌─ useTileGraph ▼──────────────────────▼────────────────────────┐
  │  pendingView ──┐                                               │
  │  pendingCorridor ──► ★ pump() — single-flight, corridor-first ★│ ← here
  │                          │ (one build at a time)               │
  └──────────────────────────┼────────────────────────────────────┘
                            │ Overpass + Open-Meteo
  ┌─ pipeline + cache ───────▼────────────────────────────────────┐
  │  fetchOverpass · openMeteoProvider · elevCache (AsyncStorage)  │
  └────────────────────────────────────────────────────────────────┘
```

This hook is flattr's react-query — except hand-rolled, because the requirements (rate limits, priority,
degraded-fallback) don't map cleanly onto a generic query cache.

## Structure pass

**Layers:** (1) UI events, (2) debounce + coverage-check gate, (3) two pending slots + `pump`,
(4) the build (Overpass → elevation → `buildGraph`), (5) region state + retry scheduler.

**Axis traced — "what controls whether a fetch actually fires?"** Watch the gate flip at each layer:

```
  axis = "what decides a network build happens?"

  ┌─ UI event ──────────────┐   user controls (pan/route)
  └───────────┬──────────────┘
              │ seam: debounce + covers() coverage check
  ┌─ gate ────▼──────────────┐   CODE controls — drops if already covered,
  │  queueViewport/ensureBbox │   coalesces rapid events
  └───────────┬──────────────┘
              │ seam: busyRef single-flight latch
  ┌─ pump ────▼──────────────┐   ONE build runs; others wait in 2 slots
  └───────────┬──────────────┘
              │ seam: degraded flag
  ┌─ retry ───▼──────────────┐   CODE re-queues degraded regions silently
  └───────────────────────────┘
```

The two load-bearing seams: **`busyRef`** (the single-flight latch, `useTileGraph.ts:113,167,182`) and
**`covers()`** (the coverage cache that drops redundant fetches, `:82-86`). Control flips from "user
decides" to "code decides" precisely at those joints — that's where rate-limit safety is enforced.

## How it works

### Move 1 — the mental model

You know the single-flight pattern from de-duping in-flight requests — "a fetch is already running, so
don't start another; queue the latest and run it when this one finishes." flattr's `pump` is that, plus a
*priority* twist: there are two queues of depth one (viewport and corridor), and corridor always wins.

```
  the pump kernel

   ┌──────────────────────────────────────────────┐
   │  if busy: return                              │ ← single-flight latch
   │  pick req = corridor ?? view  (priority)      │ ← corridor wins
   │  busy = true                                  │
   │  build(req) ──────────► set region            │
   │  if degraded: schedule silent retry           │ ← self-heal
   │  busy = false                                 │
   │  pump()   ◄──────── drain next pending        │ ← tail-call drains queue
   └──────────────────────────────────────────────┘
```

### Move 2 — the walkthrough, one part at a time

**Part 1 — the single-flight latch.** `busyRef` is the part that breaks everything if removed: drop it
and every pan fires a concurrent Overpass build, instantly blowing the rate limit (`useTileGraph.ts:166-182`):

```ts
const pump = useCallback(() => {
  if (busyRef.current) return;          // ← latch: a build is in flight, do nothing
  let kind, req;
  if (pendingCorridorRef.current) {     // corridor first — a route must not be starved by panning
    kind = "corridor"; req = pendingCorridorRef.current; pendingCorridorRef.current = null;
  } else if (pendingViewRef.current) {
    kind = "view"; req = pendingViewRef.current; pendingViewRef.current = null;
  } else return;
  busyRef.current = true;
  // ... build ...
```

Refs, not state, on purpose: `busyRef`/`pendingViewRef`/`pendingCorridorRef` must be read/written
synchronously inside the async build without triggering re-renders or capturing stale closures. State is
for what the UI shows (`loadingStep`, `view`, `corridor`); refs are for the machine's bookkeeping.

**Part 2 — the two pending slots (priority + coalescing).** Each kind has exactly *one* pending slot. A
new viewport request while one is pending just overwrites the slot — you only ever fetch the *latest*
viewport, never a backlog (`:174,239`). Corridor and viewport are separate so a route request jumps the
queue.

```
  Layers-and-hops — events → slots → one build

  ┌─ events ──────────────────────────────────────────────────────┐
  │  pan, pan, pan (rapid)        route request                    │
  └───────┬───────────────────────────┬───────────────────────────┘
          │ debounce coalesces        │ immediate
          ▼                           ▼
  ┌─ slots (depth 1 each) ────────────────────────────────────────┐
  │  pendingView  ◄── only latest      pendingCorridor             │
  └───────┬───────────────────────────┬───────────────────────────┘
          └──────────► pump() picks corridor first ◄───────────────┘
                              │ one build
                              ▼
                      Overpass + Open-Meteo
```

**Part 3 — the coverage cache (`covers`).** Before queueing, both entry points check whether the bbox is
already covered by real (non-degraded) data and bail if so (`:82-86, 233-234, 273`):

```ts
function covers(r: Region | null, bbox: Bbox): boolean {
  if (!r || r.degraded) return false;       // ← degraded counts as a MISS → forces refetch
  const [w, s, e, n] = bbox;
  return r.bbox[0] <= w && r.bbox[1] <= s && r.bbox[2] >= e && r.bbox[3] >= n;
}
```

The clever bit is `r.degraded` returning false: a region built with flat-fallback elevation is treated as
*not covered*, so it gets refetched once the API recovers. The cache key is "do we have real grades for
this box," not just "do we have this box."

**Part 4 — best-effort elevation + the degraded flag.** When Open-Meteo throttles, the build doesn't
fail — it fills elevation with `0` and sets `degraded` (`:20-31`). Streets still render, routing still
connects; only the *grades* are bogus. This is connectivity-over-fidelity, and it's why "no flat route"
stays distinct from "no route at all."

**Part 5 — the silent self-heal retry.** A degraded region re-queues itself with `silent: true` (no
loader flash) up to `MAX_RETRIES = 6`, every `RETRY_MS = 12s`, until a real build lands (`:209-218`):

```ts
if (degraded && retryCountRef.current < MAX_RETRIES) {
  retryCountRef.current += 1;
  retryRef.current = setTimeout(() => {
    if (viewRef.current?.degraded)     pendingViewRef.current     = { bbox: viewRef.current.bbox, silent: true };
    if (corridorRef.current?.degraded) pendingCorridorRef.current = { bbox: corridorRef.current.bbox, silent: true };
    pump();
  }, RETRY_MS);
}
```

The `silent` flag is a nice UX detail: user-initiated fetches show "Loading grades…", background
self-heals don't, so the overlay doesn't strobe while green grades quietly fill in.

**Part 6 — two output graphs.** The hook exposes `graph` (everything, including degraded — flat grades are
fine for *connectivity*) and `displayGraph` (excludes degraded — so bogus all-green doesn't paint over
real grades) (`:132-162`). Routing reads `graph`; the heatmap/zones read `displayGraph`. Same machine, two
projections.

```
  Comparison — the two graphs from one machine

  graph (routing)              displayGraph (heatmap/zones)
  ────────────────             ────────────────────────────
  base + corridor + view       base + corridor + view
  INCLUDES degraded            EXCLUDES degraded
  → connectivity preserved     → no fake-green over real grades
  → "no route" stays honest    → grades reappear after self-heal
```

**Part 7 — debounce, the throttle.** Pans are debounced 600ms before queueing (`:64, 254-255`); corridor
requests fire immediately (a route shouldn't wait). Autocomplete has its own 400ms debounce in `MapScreen`
(→ `05-debounced-controlled-inputs.md`). Debounce is the only throttle — there's no token bucket; the
single-flight latch + debounce + cache together keep request volume under the free tiers.

### Move 3 — the principle

When you can't use a generic data-fetching library because the constraints are domain-specific (rate
limits, priority between request *kinds*, a "good enough" fallback that must be retried later), the
primitives are still standard: a single-flight latch, depth-one pending slots for coalescing, a coverage
cache keyed on *quality* not just *presence*, and a capped silent retry. Compose those four and you have a
purpose-built query layer that a generic cache couldn't express.

## Primary diagram

```
  Single-flight tile pump — full picture

  ┌─ UI events ───────────────────────────────────────────────────┐
  │  onRegionDidChange (pan)            ensureBbox (route)         │
  └────────┬────────────────────────────────┬────────────────────┘
           │ 600ms debounce                  │ immediate
           ▼                                 ▼
     queueViewport ──covers? drop──    ensureBbox ──covers? skip──
           │ miss                            │ miss
           ▼                                 ▼
  ┌─ pending slots (depth 1) ─────────────────────────────────────┐
  │  pendingView                     pendingCorridor (priority)    │
  └────────────────────────┬──────────────────────────────────────┘
                           ▼  pump() — busyRef single-flight latch
  ┌─ build (one at a time) ───────────────────────────────────────┐
  │  fetchOverpass → cachedElevation(bestEffort(openMeteo))        │
  │  → buildGraph → region {bbox, graph, degraded}                 │
  └────────────────────────┬──────────────────────────────────────┘
              degraded?     │                 set region state
         ┌── yes ───────────┤                       │
         ▼                  │                        ▼
  silent retry (≤6, 12s)    │            ┌─ graph (routing, incl degraded) ─┐
  re-queue self ────────────┘            │  displayGraph (excl degraded)    │
                                         └──────────────────────────────────┘
  ┌─ persistent cache ────────────────────────────────────────────┐
  │  elevCache: ~90m DEM cells, AsyncStorage, survives restarts    │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Single-flight (a.k.a. request coalescing) is the same idea as Go's `singleflight.Group` or SWR's
deduping — collapse concurrent identical work into one. The depth-one pending slot is the "keep only the
latest" variant you'd use for a search box or a resize handler. What's unusual here is the *priority*
dimension (two kinds, one wins) and the *quality-keyed cache* (`degraded` = miss), both forced by the
free-tier rate limits documented in the project context's external-data caveat.

If this grew, the natural next steps: a real bounded queue instead of depth-one slots (to fetch multiple
viewports ahead), and moving `buildGraph` off the JS thread. Read next: `01-render-time-astar.md` (the
`graph` output drives the route), `02-coords-not-ids-endpoints.md` (why a changing `graph` re-snaps
endpoints). HTTP-level retry/backoff belongs to `study-networking`; the merge architecture to
`study-system-design`; the AsyncStorage cache durability to `study-system-design` (local-first).

## Interview defense

**Q: Walk me through how you keep this under a free API rate limit.**

Four things compose. One, a single-flight latch (`busyRef`) so only one build runs at a time. Two,
depth-one pending slots so rapid pans coalesce to just the latest viewport instead of a backlog. Three, a
600ms debounce on pans so a drag is one fetch, not fifty. Four, a coverage cache that drops any request
whose bbox is already covered — and the persistent elevation cache means revisited areas need *zero*
elevation calls. The part people forget is the single-flight latch: without it, every pan fires a
concurrent build and you're throttled in seconds.

```
  the load-bearing part: busyRef

  with latch:    pan,pan,pan → 1 build → done
  without latch: pan,pan,pan → 3 concurrent builds → 429 → degraded
```

**Q: What happens when elevation is throttled mid-fetch?**

The build degrades instead of failing — flat 0m elevation, `degraded` flag set. Streets still render and
routing still connects (connectivity over fidelity), but that region is excluded from the *display* graph
so it doesn't paint fake-green, and it's treated as a cache miss so a capped silent retry refetches it
every 12s until real grades land. The user sees streets immediately and grades fill in quietly.

**Anchor:** "It's single-flight with corridor priority, debounced, with a coverage cache keyed on grade
*quality* — a degraded region counts as a miss so it self-heals; the `busyRef` latch is what keeps it
under the rate limit."

## See also

- `01-render-time-astar.md` — consumes the `graph` this produces
- `02-coords-not-ids-endpoints.md` — why a changing `graph` re-snaps endpoints
- `05-debounced-controlled-inputs.md` — the parallel debounce on autocomplete
- `study-networking` — Overpass/Open-Meteo HTTP semantics and retry
- `study-system-design` — graph merge architecture + local-first cache
