# 03 — Honest degradation under a throttled free elevation API

> **Decision:** when the free elevation API is throttled, build the graph with flat
> (0 m) elevation rather than failing — but *mark that region degraded*. Degraded
> regions still route (connectivity over fidelity) but are excluded from the
> heatmap (so bogus all-green grades never paint over real ones), retried a capped
> number of times to self-heal, and every successfully-fetched value is cached
> persistently so a region is never re-fetched.

---

## Context / problem

flattr's grades come from elevation. On device, viewport and corridor graphs are
built live by sampling Open-Meteo's free elevation API (Copernicus 90m DEM). Free
means throttled: under heavy use it returns `429`, and the project's own context
warns about it — *"Open-Meteo free elevation API 429s when quota is exhausted by
heavy testing."*

So the design is forced to answer: **what happens to a graph build when elevation
fails mid-flight?** Three honest options, and the first two are both wrong:

- **Fail the build.** The streets don't render, routing doesn't connect — one `429`
  takes down the whole map. Unacceptable for a UI the user is actively panning.
- **Silently fake flat.** Substitute 0 m, build the graph, and say nothing. The
  streets render and routing connects — but the heatmap now paints that region
  *all green* (0 m everywhere = 0% grade = flat = green). The user reads "this
  whole area is flat" when the truth is "we have no idea." **This is the bug that
  forced the real design.** A masking bug is worse than a visible failure, because
  the user trusts it.

The all-green masking bug is the origin story. The decision is the third option:
fake flat *for connectivity*, but never let the lie reach the display, and heal it.

---

## Goals & non-goals

**Goals**
- A throttled elevation API never breaks street rendering or routing connectivity.
- A region built on faked-flat elevation is **marked**, not silent.
- The heatmap shows only real grades — degraded regions are excluded until real
  data lands.
- Degraded regions self-heal: retried (capped) until the API recovers.
- Re-visiting an area costs **zero** elevation requests — the cache, the main
  defense against throttling in the first place.

**Non-goals**
- Guaranteeing grade fidelity under sustained outage. If the API is down for an
  hour, those regions stay flat-but-marked; we don't invent grades.
- Offline-first elevation. The DEM isn't bundled; degradation is the offline story.
- Perfect retry. Capped retries mean a long outage eventually stops retrying and
  keeps the last (degraded) data rather than looping forever.

---

## The decision

Wrap the elevation provider in two layers — a cache, then a best-effort fallback —
and thread a `degraded` boolean from the build all the way to the display, where it
gates two different merges.

```
  The degradation pipeline — connectivity always, fidelity when honest

  ┌─ provider stack (mobile/src/useTileGraph.ts) ─────────────────────────┐
  │                                                                        │
  │   bestEffortElevation( cachedElevation( openMeteoProvider() ) )        │
  │        │ catch → flat            │ hit → 0 requests   │ retry 429s      │
  │        │ + mark degraded         │ miss → fetch+cache │                 │
  └────────┼────────────────────────┼────────────────────┼────────────────┘
           │                        │                    │
           ▼                        ▼                    ▼
     degraded = true          elevCache.ts          Open-Meteo (free, 429s)
     (region flagged)        (AsyncStorage,
                              survives restart)
                                    │
  ┌─ the seam: degraded splits two graphs ─────────────────────────────────┐
  │                                                                         │
  │   routing graph   = base + corridor + view      (INCLUDES degraded)     │  ← connect
  │   display graph   = base + corridor + view       (EXCLUDES degraded)    │  ← honesty
  │                       where !degraded                                    │
  └─────────────────────────────────────────────────────────────────────────┘
           │ degraded region re-queued, silent, capped (MAX_RETRIES)
           ▼
     self-heal: real grades replace flat once API recovers → green reappears
```

The load-bearing move is that **one boolean drives two different inclusion
decisions**. Routing wants the degraded region (flat grades are fine for "are these
streets connected?"). Display refuses it (flat grades are a lie on a grade map). The
same `degraded` flag answers both — opposite answers — because the two consumers ask
different questions of the same data.

### Best-effort fallback marks, doesn't hide

The fallback catches the throttle, returns flat, and *calls back to flag it*
(`mobile/src/useTileGraph.ts:20`):

```ts
// mobile/src/useTileGraph.ts:20 — fallback that's honest about being a fallback
function bestEffortElevation(p, onFallback) {
  return { async sample(points) {
    try { return await p.sample(points); }
    catch { onFallback(); return points.map(() => 0); }   // flat — AND raise the flag
  }};
}
```

The `onFallback` flips a local `degraded` that rides along with the built region
(`mobile/src/useTileGraph.ts:189`):

```ts
// mobile/src/useTileGraph.ts:189 — degraded travels with the region
let degraded = false;
const elev = bestEffortElevation(cachedElevation(openMeteoProvider(...)), () => { degraded = true; });
const g = await buildGraph(kind, bbox, osm, elev, ...);
const region = { bbox, graph: prefixGraph(g, kind), degraded };   // flag stored on the region
```

### The flag gates display, not routing

This is the part that actually fixed the all-green bug. Two memoized graphs, same
inputs, one filter difference (`mobile/src/useTileGraph.ts:132` and `:150`):

```ts
// routing graph — INCLUDES degraded regions (flat is fine for connectivity)
const graph = mergeGraphs([ base, ...corridor, ...view ]);          // useTileGraph.ts:132

// display graph — EXCLUDES degraded (bogus all-green must not paint over real grades)
const displayGraph = mergeGraphs([
  base,
  ...(corridor && !corridor.degraded ? [corridor.graph] : []),       // useTileGraph.ts:150
  ...(view && !view.degraded ? [view.graph] : []),
]);
```

And `covers()` treats a degraded region as *not covering* its own bbox, so a pan
back over it re-fetches to upgrade the flat grades (`mobile/src/useTileGraph.ts:82`):

```ts
// useTileGraph.ts:82 — degraded → "not covered" → triggers a re-fetch
if (!r || r.degraded) return false;
```

### Self-heal, capped

A degraded build re-queues itself silently (no loader flash), capped at
`MAX_RETRIES = 6` so a sustained outage doesn't loop forever
(`mobile/src/useTileGraph.ts:209`):

```ts
// useTileGraph.ts:65, 209 — bounded self-heal
const MAX_RETRIES = 6;   // line 65
if (degraded && retryCountRef.current < MAX_RETRIES) {
  retryCountRef.current += 1;
  retryRef.current = setTimeout(() => { /* re-queue degraded bbox, silent */ pump(); }, RETRY_MS);
}
```

### The cache is the real throttle defense

Every *successfully fetched* value is cached by ~90m DEM cell, in memory and on disk
(`mobile/src/elevCache.ts`). DEM samples never change, so a cached value is valid
forever, and a revisited area issues zero requests — which is what keeps you under
the rate limit to begin with. Only real values are cached; flat-fallback zeros never
are (`mobile/src/useTileGraph.ts:38`, `mobile/src/elevCache.ts:35`):

```ts
// elevCache.ts:35 — persistent, keyed by DEM cell, debounced writes to AsyncStorage
export function putElev(key, value) {
  if (mem.has(key)) return;
  mem.set(key, value); dirty = true;
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}
```

```
  Three layers, three failure responses

  layer            on success         on 429 / failure          honest?
  ───────────────  ─────────────────  ────────────────────────  ───────
  openMeteo        real elevation     retry w/ backoff, then     —
                                        throw
  cachedElevation  serve from cache,  pass the throw up;         ✓ never
                     0 requests         flat zeros never cached     caches a lie
  bestEffort       (transparent)      catch → flat + mark        ✓ marked,
                                        degraded                    not hidden
```

---

## Alternatives considered

**1. Fail the build on elevation error.** Cleanest code: let the `429` propagate,
show an error. Lost because it couples *street rendering and routing* to *elevation
availability* — two things that shouldn't be coupled. The user panning a map
doesn't care about grades yet; failing the whole build over a grade-data hiccup is
the wrong blast radius. Streets and connectivity don't need elevation.

**2. Silently substitute flat.** Build with 0 m, say nothing, move on. Lost because
it's the all-green masking bug — the elevation pipeline's degradation should never
be invisible to the user, and on a grade map "flat" is a *claim*, not a neutral
default. Flat-everywhere reads as "this area is genuinely flat," which is a lie the
user trusts. A masking bug beats an honest failure only on the demo; in the user's
hands it's worse. This option being *tried and reverted* is what produced the
marked-degraded design.

**3. Block routing until real grades arrive.** Exclude degraded regions from the
*routing* graph too, not just display. Lost because it re-breaks the "no flat route
vs no route" distinction from doc 02 — excluding a region makes its endpoints
disconnected, so the user gets "no route" when the truth is "we have the streets,
just not the grades." Routing wants the region; display doesn't.

```
  Alternatives, on the two things that matter

                    streets render   heatmap honest   routing connects
  ────────────────  ──────────────   ──────────────   ────────────────
  fail the build      no  ✗            n/a              no ✗
  silently flat       yes ✓            no  ✗ (lies)     yes ✓
  block routing       yes ✓            yes ✓            no  ✗
  ★ mark degraded     yes ✓            yes ✓            yes ✓
```

The marked-degraded row is the only one that's "yes" on all three — and it gets
there by letting routing and display make *different* decisions from the same flag.

---

## Tradeoffs accepted

We chose connectivity-with-honest-marking, accepting:

- **Grades are wrong (flat) in degraded regions until they heal.** Routing over a
  degraded region treats hills as flat — so a route through it isn't grade-optimal
  until real elevation lands. We chose "a route that works now" over "no route until
  grades arrive," and mark it so the UI can say so.
- **Bounded retries mean eventual give-up.** After `MAX_RETRIES`, a region under a
  sustained outage stops self-healing and keeps its last (degraded) data. We chose a
  finite retry budget over an infinite loop that hammers a down API.
- **Two graph builds (`graph` and `displayGraph`) from the same regions.** A little
  duplication in the memo layer — the cost of letting routing and display diverge on
  the `degraded` flag. Worth it; collapsing them is what caused the bug.
- **Cache grows unbounded-ish.** Capped at `MAX_ENTRIES = 50000` with oldest-first
  drop (`elevCache.ts:9`). A blunt eviction, but DEM cells are cheap and the cap is
  generous.

---

## Risks & mitigations

```
  Risk                                  Mitigation                          where
  ────────────────────────────────────  ──────────────────────────────────  ──────────────
  flat zeros leak into the heatmap      displayGraph excludes degraded;     useTileGraph.ts
    (the original bug)                    only real values cached             :150, :38
  self-heal loops forever during        MAX_RETRIES = 6, silent retries     useTileGraph.ts
    a sustained outage                                                        :65, :209
  cache serves stale elevation          DEM samples never change → cached   elevCache.ts:1
                                          values valid forever (no staleness)
  AsyncStorage corrupt / unavailable    load wrapped in try/catch, starts   elevCache.ts:26
                                          from whatever's in memory
  user never sees grades heal           covers() returns false for          useTileGraph.ts
    (thinks it's broken)                  degraded → re-fetch on revisit      :82
    corridor degraded not surfaced      corridorDegraded exposed to UI for  useTileGraph.ts
                                          a route-level honesty note          :286
```

---

## Rollout / migration

This is the architecture as built, healing from a real bug, not a change in flight.
The forward-looking migration: a **fidelity upgrade**. Open-Meteo's 90m DEM is
coarse — it smooths short steep pitches (`pipeline/elevation.ts:88`). Swapping in
`googleProvider` (or LIDAR) is a provider swap behind the same `ElevationProvider`
interface (`pipeline/elevation.ts:7`); the degradation machinery, the cache, and the
`degraded` flag don't change. **What doesn't have to change is the point** — the
honest-degradation layer is provider-agnostic. The migration is one constructor
call.

For data in flight: the persistent cache (`flattr.elevCache.v1`) survives across the
swap; a versioned `STORAGE_KEY` (`elevCache.ts:7`) means a breaking change to the
cache shape bumps the key and starts fresh rather than reading garbage.

---

## Open questions

- **Should the user see a region is degraded on the map itself, not just per-route?**
  `corridorDegraded` surfaces for a route-level note, but a panned-into degraded
  viewport heals silently. Is silent-heal the right UX, or should there be a subtle
  "grades loading" affordance?
- **Is `MAX_RETRIES = 6` × `RETRY_MS = 12s` the right budget?** Roughly 72s of
  self-heal before giving up. Un-tuned against real outage durations.
- **Eviction is oldest-first, not least-recently-used.** A frequently-revisited area
  could get evicted while a one-off lingers. LRU is the obvious upgrade; is it worth
  it at 50k entries?
- **Flat-fallback affects routing silently.** A route through a degraded region is
  grade-blind but the summary doesn't always say so. Should `steepEdges` /
  `RouteSummaryCard` distinguish "no steep blocks" from "we couldn't measure"?

---

## Coach notes

- **Lead with the bug.** "We had an all-green masking bug — the elevation API
  throttled, we faked flat, and the heatmap confidently painted a hilly area as
  flat. The fix is the design." Starting from the failure makes the decision
  inevitable instead of arbitrary. Reviewers trust a design that's scar tissue.
- The staff move to name explicitly: **one flag, two consumers, opposite answers.**
  Routing includes degraded (connectivity); display excludes it (honesty). That
  single asymmetry *is* the design — say it in one sentence and the rest follows.
- "Honest degradation" is the phrase. Not "graceful" — graceful can still be
  silent. Honest means the system tells the truth about what it doesn't know. That
  framing reads as someone who's thought about trust, not just uptime.
- Distributed-systems bridge if the room is senior: this is partial failure handled
  with a *typed* degraded state, best-effort with a bounded retry and a persistent
  cache as the rate-limit shield. Don't over-claim it as distributed systems at
  scale — it's the single-client version, and saying so is more credible than
  inflating it.

## See also

- `02-parametric-directional-router.md` — what consumes these grades; why
  `BLOCKED` finite and degraded-but-routable share a philosophy
- `01-build-time-graph-artifact.md` — the offline build uses the same provider
  interface (`pipeline/elevation.ts`)
- `.aipe/study-distributed-systems/` — partial failure, degraded modes, bounded retry
- `.aipe/study-networking/` — rate limits, 429 backoff, caching as a throttle defense
