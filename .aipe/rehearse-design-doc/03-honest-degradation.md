# RFC 03 — Honest degradation under a throttled elevation API

**Decision:** when the free Open-Meteo elevation API throttles (429), an on-device graph
build does **not** fail and does **not** silently pretend the terrain is flat. It builds
with flat (0 m) elevation, **marks the region `degraded`**
(`mobile/src/useTileGraph.ts:20`), keeps it usable for *routing* (connectivity), but
**excludes it from the heatmap** so bogus all-green grades never paint over real ones
(`useTileGraph.ts:150`). A capped self-heal retry upgrades it once the API recovers, and a
persistent cache means revisited areas never re-hit the API at all.

> Coach: the verdict is "degrade visibly, never lie." The split that makes it work — flat
> data is fine for *connectivity*, fatal for *display* — is the whole insight. Lead with
> it. A reviewer's instinct is "just retry until it works"; you preempt that by showing
> retry alone doesn't solve the masking bug.

═════════════════════════════════════════════════
2. CONTEXT / PROBLEM
═════════════════════════════════════════════════

flattr builds graph tiles **on-device** as you pan and route (`useTileGraph.ts`). Each
build needs elevation for every node, sampled from Open-Meteo's free elevation API. That
API 429s under load — the project's own context flags it: "Open-Meteo free elevation API
429s when quota is exhausted by heavy testing" (`.aipe/project/context.md`).

So every on-device build has a dependency that *will* fail intermittently. Three things
collide:

- **Grade is the whole product.** Elevation → grade → the flat-routing decision and the
  color heatmap. Bad elevation isn't a cosmetic glitch; it's wrong grades.
- **Flat elevation is a *plausible* lie.** If a throttled build fakes 0 m everywhere,
  every edge computes to 0% grade — and 0% paints **green** ("flat") on the heatmap. The
  map looks fine and is completely wrong. This is the bug that forced the design: bogus
  all-green masking real grades underneath.
- **But flat elevation is *fine for connectivity*.** Routing needs the graph's *shape*
  (which streets connect), not its grades, to answer "is there a path?" Failing the whole
  build over missing elevation would break routing in a region whose streets are perfectly
  known — re-introducing "no route" for a connected area (`useTileGraph.ts:130-131`).

That tension — flat data is safe for one consumer and toxic for another — is the problem.

═════════════════════════════════════════════════
3. GOALS & NON-GOALS
═════════════════════════════════════════════════

**Goals**
- A throttled elevation fetch never fails a build and never blanks the map.
- Routing keeps working over degraded regions (streets still connect).
- The heatmap **never shows fake-flat grades as real** — degraded regions show nothing
  rather than a lie.
- Degraded regions self-heal: real grades fill in once the API recovers, without the user
  doing anything.
- Revisited areas hit the API zero times (caching), since that's the main throttle cause.

**Non-goals**
- *Not* a guarantee the API succeeds. Best-effort, not exactly-once.
- *Not* infinite retry. A sustained outage must not loop forever.
- *Not* a paid-tier upgrade in v1. The Google provider exists (`pipeline/elevation.ts:65`)
  as the fidelity path; v1 lives on the free tier and degrades honestly.

═════════════════════════════════════════════════
4. THE DECISION
═════════════════════════════════════════════════

One `degraded` flag, set at build time, read differently by the two consumers. Routing
reads "include everything." Display reads "exclude degraded." Same merged graph, two
projections.

```
  The degraded flag — one bit, two consumers, opposite reads

  on-device build (useTileGraph.ts pump, :184)
        │
        │  elevation fetch throttled?
        ▼
  ┌─────────────────────────────────┐
  │ bestEffortElevation (:20)        │
  │   try p.sample(points)           │
  │   catch → onFallback(); return 0 │ ── sets region.degraded = true
  └───────────────┬─────────────────┘
                  │  Region { bbox, graph, degraded }
                  ▼
        ┌─────────────────────────┐
        │   merged graph state     │
        └────────┬────────┬────────┘
                 │        │
   routing graph │        │ display graph
   (:132)        │        │ (:150)
                 ▼        ▼
   includes degraded     EXCLUDES degraded
   "flat is fine for     "fake-flat green must
    connectivity"         not mask real grades"
                 │        │
                 ▼        ▼
   route still works     heatmap shows nothing
   over the region       there until real grades land
```

**Step 1 — best-effort capture, not fail-fast.** The provider is wrapped so a thrown
fetch becomes flat data plus a flag flip (`mobile/src/useTileGraph.ts:20`):

```ts
  // useTileGraph.ts:20 — the honesty seam
  function bestEffortElevation(p: ElevationProvider, onFallback: () => void): ElevationProvider {
    return {
      async sample(points) {
        try {
          return await p.sample(points);
        } catch {
          onFallback();                 // ← flips region.degraded = true
          return points.map(() => 0);   // ← flat fallback, NOT a thrown error
        }
      },
    };
  }
```

**Step 2 — the two consumers split on the flag.** The routing graph includes degraded
regions; the display graph excludes them (`useTileGraph.ts:132` and `:150`):

```ts
  // useTileGraph.ts:132 — ROUTING: include everything, flat grades fine for connectivity
  const graph = useMemo(() => stitchGraph(mergeGraphs([
    baseGraph, ...(corridor ? [corridor.graph] : []), ...(view ? [view.graph] : []),
  ])), [baseGraph, corridor, view]);

  // useTileGraph.ts:150 — DISPLAY: EXCLUDE degraded so bogus all-green doesn't paint over real grades
  const displayGraph = useMemo(() => stitchGraph(mergeGraphs([
    baseGraph,
    ...(corridor && !corridor.degraded ? [corridor.graph] : []),   // ← the guard
    ...(view && !view.degraded ? [view.graph] : []),
  ])), [baseGraph, corridor, view]);
```

```
  Why the split — same flat data, opposite correctness

  flat (0m) region          ROUTING reads it        DISPLAY reads it
  ───────────────          ─────────────────        ────────────────
  streets connect: YES      ✓ correct — path found   ✗ grades all 0% = fake green
  grades real: NO           (doesn't need grades)    (a lie — exclude it)

  include in routing, exclude from display → both consumers stay honest
```

**Step 3 — capped self-heal retry.** A degraded region re-queues itself silently, and the
retry count is bounded so a sustained outage stops instead of looping
(`useTileGraph.ts:209`):

```ts
  // useTileGraph.ts:209 — re-queue degraded area, capped at MAX_RETRIES (=6)
  if (degraded && retryCountRef.current < MAX_RETRIES) {
    retryCountRef.current += 1;
    retryRef.current = setTimeout(() => {
      if (viewRef.current?.degraded) pendingViewRef.current = { bbox: …, silent: true };
      // silent: true → no loader flash while green self-heals in the background
      pump();
    }, RETRY_MS);   // RETRY_MS = 12000
  }
```

```
  Self-heal state machine — degraded is not terminal

  ┌──────────┐  API 429   ┌──────────┐  retry (12s, capped 6x)  ┌──────────┐
  │  REAL    │ ─────────► │ DEGRADED │ ───────────────────────► │  REAL    │
  │ (grades) │            │ (flat,   │   API recovers → real     │ (grades) │
  └──────────┘            │  hidden  │   elevation → flag clears └──────────┘
       ▲                  │  from    │
       │                  │  heatmap)│   retry budget exhausted
       └── covers()       └────┬─────┘   (sustained outage)
           refetch upgrades    │              │
           (:84 degraded→false)▼              ▼
                          stays degraded, keeps last data
                          (no infinite loop, no blank map)
```

**Step 4 — persistent cache kills the root cause.** The throttle comes from re-fetching.
Elevation is cached per ~90m DEM cell, in memory *and* on disk (AsyncStorage), surviving
restarts — because DEM samples never change (`mobile/src/elevCache.ts:3`,
`useTileGraph.ts:38`). Only *real* fetched values are cached; flat fallbacks are never
written, so the cache never poisons itself with zeros.

> Coach: the load-bearing detail people skip is "only real values get cached." If you
> cached the flat fallback, the self-heal would read a cached 0 m forever and never
> recover. Naming that — "fallbacks are never persisted, so the cache can't poison the
> heal" — is the kind of edge-case awareness that signals you've debugged this for real.

═════════════════════════════════════════════════
5. ALTERNATIVES CONSIDERED
═════════════════════════════════════════════════

```
  ┌─ A. fail the build on a 429 ────────────────────────────────┐
  │  throw, show an error, no graph for that region              │
  │  WHY IT LOST: breaks ROUTING over a region whose streets are │
  │  perfectly known. Re-introduces "no route" for a connected   │
  │  area — the exact bug RFC 02's finite-BLOCKED fought. A      │
  │  throttle on a side-signal (grades) shouldn't kill the core  │
  │  signal (connectivity).                                      │
  └──────────────────────────────────────────────────────────────┘
  ┌─ B. silently fake flat (0m everywhere) ─────────────────────┐
  │  on 429, just build with 0m and show it like real data      │
  │  WHY IT LOST: 0% grade paints GREEN. The map shows a flat,   │
  │  healthy neighborhood that is actually unknown. Worse than   │
  │  an error — it's confidently wrong, and it MASKS real grades │
  │  underneath. This is the bug that forced the whole design.   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ C. degrade visibly + self-heal (CHOSEN) ───────────────────┐
  │  flat fallback for connectivity, flagged, hidden from the    │
  │  heatmap, retried, cached                                    │
  │  WHY IT WON: routing survives (A's failure), the map never   │
  │  lies (B's failure), and it fixes itself. One bit splits the │
  │  two consumers cleanly.                                      │
  └──────────────────────────────────────────────────────────────┘
```

The deciding move was recognizing the data has **two consumers with opposite tolerances**.
A and B both treat the build as having one output. Once you see routing and display want
different things from the same flat data, the flag falls out naturally.

> Coach: option B is the one to spend time on, because it's what a reviewer would have
> shipped by default — "just use flat, ship it." Walk them through the all-green masking
> bug concretely: "the map showed Capitol Hill as a flat green grid; it's one of the
> hilliest neighborhoods in Seattle." That image is what sells the design.

═════════════════════════════════════════════════
6. TRADEOFFS ACCEPTED
═════════════════════════════════════════════════

We chose visible degradation + self-heal, accepting:

- **Best-effort, not guaranteed.** Under a sustained outage past `MAX_RETRIES` (6), a
  region stays degraded — routable but with no heatmap. We chose a bounded heal over an
  infinite one, accepting that a long outage leaves a region grade-blank rather than
  spinning forever. The user keeps routing; they just don't see colors there.
- **A blank heatmap region looks like "no data," not "throttled."** The user can't
  distinguish "we're fetching" from "we gave up." There's a loader for active fetches
  (`loadingStep`) but a *settled* degraded region just shows nothing. Honest, but mute.
- **Two graph projections in memory.** `graph` (routing) and `displayGraph` (heatmap) are
  separately memoized and merged (`useTileGraph.ts:132`, `:150`). Slightly more work and
  memory than one graph; the cost of keeping the two honesty contracts separate.

═════════════════════════════════════════════════
7. RISKS & MITIGATIONS
═════════════════════════════════════════════════

```
  Risk                              Mitigation
  ────                              ──────────
  cache poisoned with fake 0m       only real fetched values are written;
                                    fallbacks never cached (elevCache.ts +
                                    cachedElevation, useTileGraph.ts:38)
  retry loop hammers a dead API     capped at MAX_RETRIES (6), 12s apart,
                                    silent; a real build resets the budget
  doomed 429 backoff stalls build   on-device build uses retries:1 (fail
                                    fast to flat), useTileGraph.ts:191
  degraded never upgrades           covers() returns false for degraded →
                                    next pan/route refetches it (:84)
  cache grows unbounded             MAX_ENTRIES=50000, oldest dropped first
                                    (elevCache.ts:9,48)
```

═════════════════════════════════════════════════
8. ROLLOUT / MIGRATION
═════════════════════════════════════════════════

- **The provider abstraction is the swap point.** `ElevationProvider` is an interface
  (`pipeline/elevation.ts:7`). `openMeteoProvider` (free, default), `googleProvider`
  (paid, fidelity), and `fixtureProvider` (deterministic, tests) all satisfy it. Wrappers
  compose: `bestEffortElevation(cachedElevation(openMeteoProvider(...)))`
  (`useTileGraph.ts:190`). Upgrading to paid elevation is swapping the innermost provider;
  the degradation and cache layers wrap it unchanged.
- **Build-time vs on-device differ deliberately.** The build pipeline
  (`pipeline/elevation.ts:92`) retries 429s 3x with exponential backoff — it has time. The
  on-device path (`useTileGraph.ts:191`) uses `retries: 1` to fail fast to flat, because a
  user panning the map can't wait on doomed backoffs.
- **No caller change.** Routing consumes `graph`; the heatmap consumes `displayGraph`.
  Both already exist. The `corridorDegraded` flag is surfaced to the UI
  (`useTileGraph.ts:286`) for an honest route note.

═════════════════════════════════════════════════
9. OPEN QUESTIONS
═════════════════════════════════════════════════

- **Should a settled-degraded region tell the user *why* it's blank?** Right now it's
  silent. A subtle "grades unavailable — tap to retry" would close the "no data vs gave
  up" ambiguity. Worth the UI complexity?
- **Is `MAX_RETRIES = 6` the right budget?** It's a guess. Under what real outage pattern
  does 6 retries at 12s (≈72s of heal attempts) prove too short or too aggressive? No data
  yet.
- **Does the route summary fully reflect corridor degradation?** `corridorDegraded` is
  plumbed out (`useTileGraph.ts:286`), but the `RouteSummaryCard` honesty states are
  clean / steep / no-route (`RouteSummaryCard.tsx`). Should "routed over a region with
  unknown grades" be a distinct, visible caveat on the card?

> Coach: the staff move here is owning that "best-effort" is a *choice*, not a limitation.
> When a reviewer says "so it's not reliable," reframe: "it's reliably honest — it never
> shows a grade it didn't measure. Reliability of *truth* over reliability of *coverage*."
> That's the sentence that turns a perceived weakness into the design's whole point.

─────────────────────────────────────────────────
**See also**
- `study-system-design/05-elevation-provider-fallback.md` — the provider abstraction walkthrough
- `study-system-design/04-honest-fallback-routing.md` — honest degradation as a routing principle
- `study-distributed-systems/` — best-effort vs guaranteed, partial failure of an external dep
- `study-networking/` — 429 handling, backoff, throttle avoidance via caching
- RFC 02 — degraded (flat) tiles still route through the same engine
- RFC 01 — tiles merge into the bundled base artifact
- `.aipe/project/context.md` (the 429 caveat), `docs/flattr-spec.md` §11.A, §12, §14.4
