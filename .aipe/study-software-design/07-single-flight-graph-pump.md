# Single-flight graph pump

> **Single-flight / bounded concurrency with a priority drain**
> — Industry standard. The "one in-flight, queue the rest, prioritize" loop.

## Zoom out, then zoom in

The mobile app builds graph regions on demand: the visible viewport (for the
heatmap) and the corridor between two route endpoints (for routing). Both
need Overpass + elevation round-trips, both are rate-limited, and a user
panning around could fire a dozen overlapping builds. flattr runs **exactly
one build at a time**, queues at most one pending request per kind, and lets
the route corridor jump ahead of the viewport so a pending route is never
starved by panning.

```
  Zoom out — where the pump lives

  ┌─ UI: MapScreen.tsx ────────────────────────────────────┐
  │  pan → onRegionDidChange    route → ensureBbox          │
  └──────────────────────┬───────────────────┬──────────────┘
              debounced view│        corridor │ (priority)
  ┌─ useTileGraph.ts ──────▼─────────────────▼──────────────┐
  │  pendingViewRef        pendingCorridorRef               │
  │            └──── ★ pump() ★ ─── busyRef gate ───┐       │ ← we are here
  └──────────────────────────────────────────────┬─┴────────┘
                                                 │ one build at a time
  ┌─ pipeline (on-device) ─────────────────────▼────────────┐
  │  fetchOverpass → buildGraph(provider) → prefixGraph     │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is **single-flight** — collapse concurrent demand into one
in-flight operation — with a two-slot priority queue and a self-draining
loop. It's the densest module in the repo (`audit.md` Lens 1), and the
complexity is inherent: bounded concurrency against a throttled API with
graceful degradation genuinely needs this many moving parts.

## Structure pass

**Layers.** Request sources, the gate, the drain:
- *Sources*: `onRegionDidChange` (debounced viewport), `ensureBbox`
  (corridor), the self-heal retry.
- *The gate*: `busyRef` — the single-flight lock.
- *The drain*: `pump()` — picks corridor-then-view, runs one build, re-pumps.

**Axis — "who controls when a build runs?"**

```
  axis = "what decides the next build?"

  ┌─ user (pan / route) ──────┐  REQUESTS, doesn't run — sets a pending ref
  └──────────┬─────────────────┘
             │ seam: busyRef gate
  ┌─ pump() ──────────────────┐  DECIDES: busy? bail. else drain corridor||view
  └──────────┬─────────────────┘
             │ seam: finally → pump()
  ┌─ the build itself ────────┐  RUNS once, then hands control back to pump
  └────────────────────────────┘

  control flips from "user asks" to "pump decides" at the busyRef gate
```

**Seam.** `busyRef` is the load-bearing boundary. Above it, any number of
requests can arrive. Below it, exactly one build runs. The `finally { pump() }`
at the end of every build is the second seam — it's what makes the loop
*self-draining*: control always returns to the pump to pick up the next
pending request.

## How it works

### Move 1 — the mental model

You know the debounced-search-box bug: type fast, fire ten requests, results
arrive out of order, the wrong one wins. The standard fixes are debounce
(wait for a pause) and single-flight (only one request alive at a time, newest
demand wins). flattr uses *both* — debounce on the viewport (`DEBOUNCE_MS`),
single-flight on everything — plus a priority so the route corridor beats the
viewport.

```
  the pattern — one in-flight, queue one per kind, drain by priority

  requests:  view, view, corridor, view  (rapid)
                              │
                  ┌───────────▼────────────┐
                  │ pendingCorridor (1 slot)│ ← priority
                  │ pendingView     (1 slot)│ ← overwritten by newest
                  └───────────┬─────────────┘
              busyRef? ─ yes ─┘ (bail, current build will re-pump)
                       └─ no ─► run corridor||view ─► finally: pump() again
```

In one sentence: **collapse all concurrent demand into one running build,
keep one pending slot per kind, and re-pump on completion so the queue
drains itself — corridor first.**

### Move 2 — the step-by-step walkthrough

#### The gate: one build at a time

```ts
// useTileGraph.ts:166-182 — pump(), the gate and priority pick, annotated
const pump = useCallback(() => {
  if (busyRef.current) return;            // ◄── single-flight: already building, bail
  let kind: "corridor" | "view";
  let req;
  if (pendingCorridorRef.current) {       // ◄── corridor wins (route not starved)
    kind = "corridor"; req = pendingCorridorRef.current;
    pendingCorridorRef.current = null;
  } else if (pendingViewRef.current) {
    kind = "view"; req = pendingViewRef.current;
    pendingViewRef.current = null;
  } else { return; }                      // nothing pending
  busyRef.current = true;                 // ◄── take the lock
  // ...run build...
}, []);
```

`busyRef` is a `useRef`, not state, on purpose — it must update synchronously,
because two `pump()` calls in the same tick would both see stale `false` if it
were `useState` (state updates are async/batched). **What breaks if `busyRef`
were `useState`?** You'd lose the single-flight guarantee — concurrent pumps
would both start builds and hammer the rate-limited API, the exact thing this
module exists to prevent. The ref is the correct tool for a synchronous lock.

#### One pending slot per kind — newest demand wins

The pending refs hold *one* request each (`pendingViewRef`,
`pendingCorridorRef`). A new viewport request overwrites the old pending one
(`useTileGraph.ts:239`) rather than queueing it. **Why one slot, not a
queue?** Because stale viewports are worthless — if the user pans A→B→C, you
only want C; building A and B wastes rate-limit budget on regions the user
already left. Overwriting is the right data structure here: a queue would
faithfully build obsolete regions.

#### The self-draining loop

```ts
// useTileGraph.ts:219-226 — the drain, annotated
  } catch {
    // Overpass failed — keep last region; a later pan retries.
  } finally {
    busyRef.current = false;   // ◄── release the lock
    if (!silent) setLoadingStep(null);
    pump();                    // ◄── drain the NEXT pending (corridor first)
  }
```

The `finally { pump() }` is what makes it a *loop* without a `while`. Every
build, on completion, releases the lock and immediately re-pumps. If a
corridor request arrived while a viewport build was running, this is where it
gets picked up — ahead of any newer viewport. **What breaks without the
re-pump?** Requests that arrived during a build would sit in their pending
slot forever (the gate rejected them at arrival because `busyRef` was true).
The re-pump is the only thing that drains them.

```
  execution trace — pan, pan, route, all during one build

  t0  view build running (busyRef=true)
  t1  pan      → pendingView = bboxA;  pump() → busy, bail
  t2  pan      → pendingView = bboxB   (overwrites A);  pump() → busy, bail
  t3  route    → pendingCorridor = bboxC;  pump() → busy, bail
  t4  build done → finally: busyRef=false, pump()
                   → corridor wins → build bboxC  (route NOT starved by pans)
  t5  build done → finally: pump() → view bboxB  (A was correctly dropped)
```

#### Graceful degradation feeds back into the pump

When the elevation provider is throttled, `bestEffortElevation` (pattern `06`)
returns flat grades and flips `degraded = true`. The pump notices and
schedules a *silent* self-heal retry (`useTileGraph.ts:209-218`), capped at
`MAX_RETRIES` so a sustained outage doesn't loop forever. The retry re-queues
the degraded region and calls `pump()` — closing the loop.

```
  layers-and-hops — degradation self-heal

  ┌─ pump build ──────────────────────────────────────────┐
  │  elevation throttled → degraded=true (via provider 06) │
  └──────────────────────┬──────────────────────────────────┘
        hop: schedule retry (RETRY_MS, silent, capped)
  ┌─ retry timer ─────────▼─────────────────────────────────┐
  │  re-queue degraded region → pump()  (no loader flash)   │
  └──────────────────────┬──────────────────────────────────┘
        hop: real elevation now available → non-degraded build stops retries
  ┌─ display graph ───────▼─────────────────────────────────┐
  │  excludes degraded regions until real grades land        │
  └─────────────────────────────────────────────────────────┘
```

**What breaks if the retry weren't capped?** A sustained API outage would
re-pump forever, burning battery and rate-limit budget with no hope of
success. The `MAX_RETRIES` cap (`useTileGraph.ts:65`) is the load-bearing
safety on the self-heal.

### Move 3 — the principle

When demand is concurrent but the resource is single-threaded and rate-
limited, don't run requests in parallel and don't queue them all — run one,
keep the freshest pending per category, and drain on completion with a
priority. The general lesson: **single-flight plus a one-slot-per-kind
pending buffer is the right shape for "user fires faster than the backend can
serve, and stale requests are worthless."** A naive queue is wrong here; it'd
faithfully serve obsolete viewports.

## Primary diagram

The full machine: sources set pending slots, the gate admits one, the build
runs and self-heals, the finally re-pumps by priority.

```
  single-flight graph pump — complete

  ┌─ UI sources ───────────────────────────────────────────────┐
  │  pan ─debounce─► queueViewport     route ─► ensureBbox      │
  └──────────┬───────────────────────────────┬──────────────────┘
       set pendingView (overwrite)     set pendingCorridor
             └──────────────┬────────────────┘
  ┌─ pump() ────────────────▼──────────────────────────────────┐
  │  busyRef? ── yes ──► bail (running build will re-pump)      │
  │           ── no ───► pick corridor||view → busyRef=true     │
  │                      build: Overpass → buildGraph(06 stack) │
  │                      degraded? → schedule silent retry(cap) │
  │                      finally: busyRef=false → pump() ◄──────┼─ self-drain
  └──────────┬──────────────────────────────────┬──────────────┘
    routing graph (incl. degraded)      display graph (excl. degraded)
```

## Elaborate

Single-flight is the name Go's `singleflight` package made standard:
collapse duplicate concurrent calls into one. flattr's variant adds a
priority drain and a one-slot-per-kind buffer because its two demand sources
have different urgency (a pending route matters more than a pan). The whole
thing is built on `useRef` for synchronous locking rather than `useState`,
which is the React-specific detail that makes the concurrency correct — the
one place this file's design depends on framework knowledge.

It sits directly on top of pattern `06`: the elevation decorator stack is what
produces the `degraded` flag the pump's self-heal reacts to, and the
provider's caching is what keeps the rate-limit budget survivable. At the
system altitude (the build-time-vs-runtime split, the on-device pipeline
reuse), see `study-system-design/`; for the rate-limit/throughput framing, see
`study-performance-engineering/`.

## Interview defense

**Q: "Why one build at a time? Parallel fetches would fill the map faster —
this looks like you're leaving throughput on the table."**

Parallel fetches would get me rate-limited and then I'd have *zero*
throughput. Overpass and the free Open-Meteo tier both throttle aggressively;
firing concurrent builds during a pan-heavy session is exactly how you trip a
429 storm. Single-flight keeps me under the limit, and the priority drain
means the latency that matters — getting a route corridor built — isn't stuck
behind viewport builds. The freshest-pending-wins buffer means I never waste a
build on a viewport the user already panned away from. So it's not leaving
throughput on the table; it's spending a constrained budget on the requests
that still matter.

```
  parallel builds              vs     single-flight + priority
  ┌──────────────────┐                ┌──────────────────────┐
  │ N concurrent      │ 429 storm      │ 1 in-flight          │ under limit
  │ stale viewports   │ wasted budget  │ freshest pending wins│ no waste
  │ route stuck behind│                │ corridor priority    │ route first
  └──────────────────┘                └──────────────────────┘
```

*Anchor: against a rate-limited backend, single-flight + freshest-pending +
priority drain beats parallelism — concurrency would just buy 429s.*

**Q: "What's the part that's easy to get wrong, and why `useRef` not
`useState`?"**

The lock must be synchronous. `busyRef` is a `useRef` because two `pump()`
calls in the same render tick both need to see the lock the instant it's
taken — `useState` updates are async and batched, so both would read stale
`false` and start builds. The other easy miss is the `finally { pump() }`:
without it, any request that arrived while a build was running (and got
rejected at the gate) would sit in its pending slot forever. The re-pump is
the only drain. People remember "only one at a time"; they forget the
self-drain that picks up what queued during the build.

*Anchor: the lock is a `useRef` for synchronous mutation, and the
`finally { pump() }` is the self-drain — forget it and queued requests never
run.*

## See also

- `06-provider-interface.md` — produces the `degraded` flag the pump heals.
- `04-lazy-deletion-priority-queue.md` — another "right data structure for the
  job" call (tolerate stale, don't over-engineer).
- `audit.md` Lens 1 (densest module, inherent complexity), Lens 6 (the masked
  throttle in the build try/catch).
- `study-performance-engineering/` — rate-limit budget and throughput control.
- `study-system-design/` — build-time vs runtime, on-device pipeline reuse.
