# Single-flight graph pump
### Single-flight / mutex-guarded async queue with leaked layer boundary — Industry pattern, the repo's complexity hotspot

## Zoom out, then zoom in

This is the module the audit names as the leakiest and hardest-to-touch in the
repo — and it's worth its own file precisely *because* it's where the engine's
clean discipline broke down. Here's where it sits.

```
  Zoom out — where the pump lives (and what it pulled up)

  ┌─ UI layer (mobile/src) ───────────────────────────────────────┐
  │  MapScreen.tsx → useTileGraph(baseGraph)                       │
  │                  ★ pump(): single-flight async build ★         │ ← we are here
  │                  knows: MAX_SEG_M=90, DEDUPE, retries, batches │ ← LEAK
  └───────────────────────────┬──────────────────────────────────┘
                              │ calls DOWN into build-time pipeline
  ┌─ Pipeline layer (pipeline/) ▼────────────────────────────────┐
  │  fetchOverpass · buildGraph · openMeteoProvider               │ ← these were
  │  (Overpass round-trip, DEM resolution, 429 backoff)           │   build-only
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** You know how you debounce a search box so you don't fire a request
per keystroke, and you guard so two requests don't race? `useTileGraph` does
that for *graph builds* — but each "request" is a full Overpass fetch +
elevation sampling + graph assembly, and only **one may run at a time** to stay
under free-tier rate limits. The pattern is **single-flight**: a mutex (`busy`)
plus a one-slot pending buffer per request kind, with the route corridor given
priority over the viewport. The design *problem* here isn't the pattern — it's
that build-time pipeline knowledge (DEM resolution, retry counts, Overpass
batching) leaked up into a React hook. This file walks both: the pattern that's
right, and the leak that isn't.

## Structure pass

**Layers.** The hook straddles two: the **UI concern** (debounce a pan, react to
state, expose `graph`) and the **build concern** (Overpass, elevation, rate
limits). The whole problem is that those two concerns share one module.

**Axis — "who owns the rate-limit knowledge?"** Trace it and watch it land in
the wrong layer:

```
  One question across the boundary: "who knows about the DEM / rate limit?"

  ┌─ where it SHOULD live ─┐   the leak   ┌─ where it ACTUALLY lives ─┐
  │ pipeline/elevation.ts  │ ◄═══╪═══════ │ useTileGraph.ts (UI hook) │
  │ (DEM res, batch, 429)  │  (pulled up) │ MAX_SEG_M=90, DEDUPE,      │
  │                        │              │ retries:1, delayMs:400     │
  └────────────────────────┘              └────────────────────────────┘
       a UI hook should not know the DEM is 90m. but it does (line 32).
```

**Seam.** The boundary between UI and build-time pipeline is supposed to be a
clean horizontal seam (the UI asks for a graph; the pipeline provides one). Here
the seam is *smeared*: the hook reaches across it and hard-codes the pipeline's
internal constants. That smear is the finding.

## How it works

### Move 1 — the mental model

The shape is a mutex plus a one-deep mailbox per request kind, drained by a
self-rescheduling pump.

```
  Pattern — single-flight with prioritized one-slot mailboxes

   onRegionPan ─┐                 ┌─ ensureBbox(route) ─┐
   (debounced)  │                 │                     │
                ▼                 ▼                     │
        pendingView slot     pendingCorridor slot ◄─────┘ (priority)
                │                 │
                └────────┬────────┘
                         ▼
                  ┌─ pump() ─────────────────┐
                  │ if busy: return           │ ← mutex: one build at a time
                  │ take corridor THEN view   │ ← priority drain
                  │ busy=true; build…; busy=false
                  │ pump()  ← drain next      │ ← self-reschedule
                  └───────────────────────────┘
```

Only one build runs. New requests don't queue up unboundedly — they overwrite
the single pending slot (latest pan wins). Corridor always beats view, so a
pending route isn't starved by panning.

### Move 2 — the walkthrough

**The mutex — `busyRef`.** Bridge from a "don't double-submit" form guard.
`pump` checks `busyRef.current` first and bails if a build is in flight
(`useTileGraph.ts:90`). What breaks without it: two concurrent Overpass fetches,
which blows the free-tier rate limit and gets you 429'd — the exact failure the
whole module exists to avoid.

**The one-slot mailboxes — pending refs.** There are two pending slots,
`pendingCorridorRef` and `pendingViewRef`. A new request *replaces* the slot's
contents rather than appending (`useTileGraph.ts:146,161`). What this buys:
panning five times while a build runs leaves only the *last* pan pending — no
backlog of stale viewports to chew through.

**The priority drain.** `pump` checks corridor *before* view
(`useTileGraph.ts:93–100`). What breaks without the ordering: a user requests a
route, then pans; the pan's view build runs first and the route waits, so the
route feels broken. Corridor-first keeps routing responsive.

```
  pump() drain order (pseudocode):
      if busy: return
      if pendingCorridor: kind=corridor; bbox=take(pendingCorridor)
      elif pendingView:   kind=view;     bbox=take(pendingView)
      else: return                       // nothing to do
      busy = true
      async:
          osm = fetchOverpass(bbox)
          elev = bestEffortElevation(openMeteoProvider(...))   // degrade, don't fail
          g = buildGraph(kind, bbox, osm, elev, ...)
          store region (corridor or view)
      finally:
          busy = false
          pump()                          // self-reschedule: drain the next
```

**The self-reschedule — `pump()` calls `pump()` in `finally`.** After each build
finishes (success *or* failure), it calls itself to drain whatever arrived while
it was busy (`useTileGraph.ts:126`). What breaks without it: a request that
arrived mid-build sits in its slot forever, because nothing else triggers a
drain.

**Best-effort degradation — the deliberate mask.** `bestEffortElevation`
(`useTileGraph.ts:18–28`) wraps the elevation provider so a failed elevation
call returns flat (0 m) instead of throwing. What this buys: if Open-Meteo is
throttled, you still get *connected streets* (routing works, grades fill in
later) instead of a blank screen. This mask is *defensible and named* — the
comment states "connectivity over fidelity" (lines 16–17).

**Now the leak (the finding).** Two problems sit in this otherwise-reasonable
pattern:

1. **Leaked constants.** `MAX_SEG_M = 90` "match the ~90m free DEM" and
   `DEDUPE = 0.0008` (lines 32–33) are properties of the *elevation provider*,
   declared in a *UI hook*. `openMeteoProvider(fetch, { delayMs: 400, retries: 1
   })` (line 111) tunes the provider's rate-limit behaviour from the UI. Change
   the elevation source and you edit a React hook. That's the boundary smear.

2. **Swallowed catch.** The `pump` catch (lines 121–122) discards *every* error
   with only a comment — Overpass 429, a `buildGraph` bug, a network timeout are
   all silent and indistinguishable. The user sees the loading overlay vanish
   with no change. The next developer debugging "why didn't my tile load" has
   nothing.

```
  Layers-and-hops — the leak and the swallow

  ┌─ UI hook (useTileGraph) ─────────────────────────────────────┐
  │ MAX_SEG_M=90  DEDUPE  retries:1  ← should be pipeline's       │
  │ catch { /* comment only */ }     ← every error → silence      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ hop: build (may 429 / throw / bug)
  ┌─ pipeline (fetchOverpass, buildGraph, openMeteoProvider) ─────┐
  │ owns the DEM resolution, the batch sizes, the 429 backoff     │
  └───────────────────────────────────────────────────────────────┘
  the constants belong below the line; the error info should come back up it.
```

### Move 2.5 — current state vs the fix

What's true now vs the constructive move:

```
  Comparison — now vs fixed

  NOW                                  FIXED
  ┌──────────────────────────────┐     ┌──────────────────────────────┐
  │ hook hard-codes DEM/retry/    │     │ pipeline owns those; hook     │
  │ batch constants               │     │ passes a bbox + a kind only   │
  │ catch swallows all errors     │     │ catch sets a transient-error  │
  │ silently                      │     │ state distinct from loading   │
  │ single-flight pump: KEEP      │ ──► │ single-flight pump: UNCHANGED │
  │ best-effort elevation: KEEP   │     │ best-effort elevation: stays  │
  └──────────────────────────────┘     └──────────────────────────────┘
```

The takeaway is *what doesn't have to change*: the single-flight pump and the
best-effort degradation are sound. The fix is narrow — move the constants down,
stop swallowing the catch. You don't rewrite the module; you un-smear its seam.

### Move 3 — the principle

A module that straddles two layers inherits the complexity of both. The pump
*mechanism* is fine; the *placement of knowledge* is the bug. When a UI module
starts declaring constants that describe a data source two layers down, that's
the signal the seam has smeared — push the knowledge back to the layer that owns
it, and let the boundary carry a clean contract (here: "give me a graph for this
bbox" in, "graph or a named error" out).

## Primary diagram

The full hook: the sound pattern and the leak, in one frame.

```
  useTileGraph — single-flight pump + the leak, full picture

  ┌─ inputs ──────────────────────────────────────────────────────┐
  │ onRegionDidChange (debounced 600ms) → pendingView              │
  │ ensureBbox(routeSpan)               → pendingCorridor (priority)│
  └───────────────────────────┬───────────────────────────────────┘
                              ▼
  ┌─ pump() — single-flight (SOUND) ──────────────────────────────┐
  │ busyRef mutex · corridor-before-view drain · self-reschedule   │
  │ bestEffortElevation: degrade to flat on failure (deliberate)   │
  │ ✗ MAX_SEG_M/DEDUPE/retries hard-coded here  ← LEAK             │
  │ ✗ catch {} swallows all errors silently     ← LEAK            │
  └───────────────────────────┬───────────────────────────────────┘
                              ▼
  ┌─ outputs ─────────────────────────────────────────────────────┐
  │ graph = stitchGraph(mergeGraphs([base, corridor, view]))       │
  │ loadingStep · onRegionDidChange · ensureBbox                   │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Pan the map past the bundled base area → `onRegionDidChange`
debounces, then queues a viewport build. Enter two addresses far apart →
`MapScreen`'s endpoint effect calls `ensureBbox` with the spanning box
(`MapScreen.tsx:131–140`), which queues a *corridor* build that jumps the line
so the route connects. Both flow through one `pump`, one at a time, corridor
first.

**The mutex + drain + self-reschedule — `mobile/src/useTileGraph.ts:89–129`.**

```
  useTileGraph.ts  (lines 89–129, condensed)

  const pump = useCallback(() => {
    if (busyRef.current) return;                    ← mutex: one build at a time
    let kind, bbox;
    if (pendingCorridorRef.current) {               ← corridor FIRST (priority)
      kind = "corridor"; bbox = pendingCorridorRef.current;
      pendingCorridorRef.current = null;
    } else if (pendingViewRef.current) {            ← then view
      kind = "view"; bbox = pendingViewRef.current;
      pendingViewRef.current = null;
    } else return;                                  ← nothing pending
    busyRef.current = true;
    (async () => {
      try {
        const osm = await fetchOverpass(bbox);
        const elev = bestEffortElevation(openMeteoProvider(fetch,
                       { delayMs: 400, retries: 1 }));   ← LEAK: provider tuning in UI
        const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, …);  ← LEAK: DEM const
        … store region …
      } catch {                                     ← LEAK: every error swallowed
        // comment only
      } finally {
        busyRef.current = false;
        pump();                                     ← self-reschedule: drain next
      }
    })();
  }, []);
```

**The deliberate mask — `mobile/src/useTileGraph.ts:18–28`.**

```
  useTileGraph.ts  (lines 18–28)

  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return { async sample(points) {
      try { return await p.sample(points); }
      catch { return points.map(() => 0); }   ← elevation down → flat, not failure
    }};
  }
       │
       └─ THIS mask is fine: named intent (connectivity over fidelity, lines 16–17),
          scoped to one concern. contrast with the pump catch, which is unnamed
          and catches everything.
```

**The leaked constants — `mobile/src/useTileGraph.ts:32–33`.**

```
  useTileGraph.ts  (lines 32–33)

  const MAX_SEG_M = 90;     // match the ~90m free DEM      ← DEM is pipeline knowledge
  const DEDUPE = 0.0008;    // ~90m elevation sample dedup   ← so is the dedup precision
       │
       └─ FIX: these belong in pipeline/config.ts or as defaults on the provider.
          a UI hook deciding the DEM resolution is the seam smear (audit Lens 3, Leak #4).
```

## Elaborate

The pattern is **single-flight** (a.k.a. request coalescing / in-flight
deduplication) — the same idea as `golang.org/x/sync/singleflight` or an SWR
mutation lock: collapse concurrent demand into one execution. flattr's version
adds *prioritized* one-slot mailboxes, which is a small, sensible extension. The
design lesson isn't the pattern — it's APOSD's **information leakage** and
**different layer, different abstraction**: a module that knows facts owned by a
layer two steps away has a leak, and the cure is to move the knowledge home. The
swallowed catch is the **masking errors** anti-pattern done badly — masking is
fine when scoped and named (the elevation degradation), harmful when it eats
every error indiscriminately.

Read next: the engine pattern files (`01`–`05`) for the contrast — that code
does *not* leak across layers, which is exactly why this module stands out.
`build-graph.ts` (audit Lens 4) is the positive counterexample: a clean
orchestrator that sequences the same pipeline without inheriting its constants.

## Interview defense

**Q: Is the single-flight pump over-engineered for a map app?** No — the
constraint is real: each build is an Overpass + Open-Meteo round-trip on free
tiers that 429 under concurrency. Without the mutex you'd race two builds and
get throttled; without the one-slot mailbox you'd queue stale viewports;
without corridor priority a route would wait behind panning. The mechanism earns
its place.

**Q: So what's actually wrong with it?** Two things, and they're placement, not
logic. (1) It hard-codes the DEM resolution and provider retry counts (lines
32–33, 111) — knowledge that belongs in the pipeline, so changing the elevation
source means editing a React hook. (2) Its catch swallows every error silently
(lines 121–122), so a rate-limit, a bug, and a timeout are indistinguishable.
Fix: push the constants down to `pipeline/config.ts`/the provider, and surface a
transient-error state. The pump and the best-effort elevation stay as-is.

```
  the leak in one line:
  UI hook ──knows──► "the DEM is 90m"   ✗  (should be pipeline's secret)
```

**Q: What's the load-bearing part people forget?** The `pump()` call in the
`finally` (line 126). It's the self-reschedule that drains requests which
arrived mid-build. Drop it and a pan-during-build is lost forever — the most
subtle bug in the module, because it only manifests under timing.

**Anchor:** "Single-flight pump — mutex, prioritized one-slot mailboxes,
self-rescheduling drain. Sound mechanism; the bug is that it leaked the
pipeline's DEM/retry constants up into the UI and swallows its errors."

## Validate

1. **Reconstruct:** draw the pump's drain order and the self-reschedule from
   memory (`useTileGraph.ts:89–129`).
2. **Explain:** why corridor before view (lines 93–100)? What user-visible
   symptom does the wrong order cause?
3. **Apply:** name the exact lines to move where, to un-leak the boundary
   (`MAX_SEG_M`/`DEDUPE` at 32–33, provider opts at 111 → `pipeline/config.ts`
   / provider defaults).
4. **Defend:** distinguish the *good* mask (`bestEffortElevation`, lines 18–28)
   from the *bad* one (pump catch, 121–122). Why is one named-and-scoped and the
   other a red flag?

## See also

- `01`–`05` — the engine patterns that do *not* leak across layers (the
  contrast).
- `audit.md` Lens 1 (complexity hotspot), Lens 3 (leak #4), Lens 6 (swallowed
  catch).
- `.aipe/study-system-design/` — the build-time vs run-time boundary this hook
  straddles.
