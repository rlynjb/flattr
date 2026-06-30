# 02 — Single-flight pump

**Industry names:** single-flight / request coalescing; a hand-rolled priority job
queue with a mutex. **Type:** Language-agnostic pattern, project-specific build.

## Zoom out, then zoom in

You've written the everyday version: a `loadingRef` so two clicks don't fire two
`fetch()`es. flattr scales that idea up — not "don't double-fire one request" but
"never run two graph *builds* at once, and when two are queued, run the route
corridor before the viewport." It's a one-at-a-time job queue, built by hand from
refs, because the free Overpass/Open-Meteo tiers throttle the moment you fan out.

```
  Zoom out — where the pump sits in the data path

  ┌─ UI (MapScreen) ──────────────────────────────────────────────┐
  │  pan → onRegionDidChange   route → ensureBbox   toggle → effect│
  └───────────────┬─────────────────┬─────────────────┬───────────┘
                  │ debounce         │ immediate       │ immediate
  ┌─ Hook (useTileGraph) ▼──────────▼─────────────────▼───────────┐
  │  pendingViewRef ───┐                                          │
  │  pendingCorridorRef ┼──► ★ pump() — one build at a time ★      │ ← we are here
  │  busyRef (mutex) ───┘     corridor drained before view        │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ one fetch+build at a time
  ┌─ Network (pipeline/*) ────────▼───────────────────────────────┐
  │  fetchOverpass → buildGraph(+elevation) → prefixGraph         │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pump is a tiny scheduler. Two pending slots, one busy flag, a drain
loop that always prefers the corridor. That's the whole kernel.

## Structure pass

**Layers:** (1) three UI triggers → (2) two pending-request ref slots → (3) the
`pump` drain loop guarded by `busyRef` → (4) committed regions mirrored into
state → (5) derived merged graph.

**Axis — control (who decides what runs next?):**

```
  Axis: "who decides the next build?"

  ┌─ UI triggers ─────────────┐  UI ENQUEUES (writes a pending slot)
  │  pan / route / toggle     │  but does NOT decide order
  └───────────┬───────────────┘
  ┌─ pump() ──▼───────────────┐  PUMP DECIDES: corridor slot first,
  │  drain loop               │  then view slot, then stop
  └───────────┬───────────────┘
  ┌─ busyRef ─▼───────────────┐  MUTEX DECIDES: if busy, do nothing —
  │  one-at-a-time gate       │  the running build re-calls pump when done
  └───────────────────────────┘
```

**Seams (load-bearing):**
- `busyRef` (`useTileGraph.ts:113`) — the mutex. Control flips here: callers
  *request*, the gate *grants*. Drop it and parallel builds hammer the rate limit.
- The `finally { pump() }` tail (`:221–225`) — the self-drain seam. Each build,
  on finishing, pulls the next. That's what makes it a queue and not just a lock.

## How it works

### Move 1 — the mental model

Think of the classic single-flight ref, then add a priority slot:

```
  Pattern — one-at-a-time drain with priority

   enqueue ──► [ corridor slot ] ─┐
   enqueue ──► [   view slot   ] ─┤
                                  ▼
              busy? ── yes ──► do nothing (running build will re-pump)
                │
                no
                ▼
         take corridor if present, else view
                │
                ▼
         build ──(finally)──► pump() again   ◄─ drains the next
```

The kernel — what breaks if you remove each part:
- **`busyRef` mutex** — remove it and N pans fire N parallel Overpass builds;
  the free tier 429s and *every* build fails. This is the load-bearing part.
- **two pending slots (not a list)** — remove the split and you can't prioritize;
  a queued route waits behind stale viewport pans. Latest-wins per kind is
  intentional: an older pan is worthless once you've panned again.
- **`finally { pump() }` self-drain** — remove it and a queued request sits
  forever after the current build finishes; it'd be a lock, not a queue.
- **corridor-before-view ordering** — remove it and a route you're waiting on
  starves behind background heatmap loads.

Optional hardening (not the kernel): the `silent` flag, the degraded-retry
re-queue, the debounce — those are pattern `05`.

### Move 2 — the walkthrough

**The pump body** — `useTileGraph.ts:166–227`:

```ts
const pump = useCallback(() => {
  if (busyRef.current) return;                       // ① mutex: a build is running → bail
  let kind, req;
  if (pendingCorridorRef.current) {                  // ② PRIORITY: corridor first
    kind = "corridor"; req = pendingCorridorRef.current;
    pendingCorridorRef.current = null;               //    claim it (clear the slot)
  } else if (pendingViewRef.current) {               // ③ else the viewport
    kind = "view"; req = pendingViewRef.current;
    pendingViewRef.current = null;
  } else { return; }                                 // ④ nothing queued → stop draining
  busyRef.current = true;                            // ⑤ take the lock
  (async () => {
    try {
      const osm = await fetchOverpass(bbox);         // ⑥ the slow part: streets
      const elev = bestEffortElevation(cachedElevation(openMeteoProvider(...)));
      const g = await buildGraph(kind, bbox, osm, elev, ...);
      const region = { bbox, graph: prefixGraph(g, kind), degraded };
      if (kind === "corridor") { corridorRef.current = region; setCorridor(region); } // ⑦ commit
      else { viewRef.current = region; setView(region); }
      // (degraded self-heal re-queue — see pattern 05)
    } catch { /* keep last region; a later pan retries */ } // ⑧ failure is non-fatal
    finally {
      busyRef.current = false;                       // ⑨ release the lock
      pump();                                         // ⑩ DRAIN the next (corridor first)
    }
  })();
}, []);
```

Walk the moves:

**①/⑤/⑨ The mutex.** A boolean ref, not state — flipping it must not re-render.
`pump` is the only writer. The invariant: at most one async build in flight. This
is the single fact that keeps you under the rate limit.

**②③ Priority by slot, not by queue position.** Two refs, each holding *the
latest* request of its kind. A route corridor always wins. Note "latest wins" is
free here: writing `pendingViewRef.current = newReq` overwrites the old pan —
exactly what you want, because the old viewport is stale once the user panned on.

**⑥ The slow part.** `fetchOverpass` + elevation + `buildGraph`. This is why
one-at-a-time matters: each build is a real Overpass round-trip plus elevation
samples. Two in parallel = throttled.

**⑦ Commit to ref *and* state.** Two writes on purpose: the ref
(`corridorRef.current`) so the next `pump` reads fresh values synchronously, and
`setCorridor(region)` so the derived `graph`/`displayGraph` memos recompute and
the UI updates. Ref = control plane, state = render plane.

```
  Layers-and-hops — commit writes both planes

  ┌─ control plane (refs) ────────┐   ┌─ render plane (state) ────────┐
  │ corridorRef.current = region  │   │ setCorridor(region)           │
  │ (next pump reads this NOW)    │   │ → graph/displayGraph memos     │
  └───────────────────────────────┘   │ → MapScreen re-renders         │
                                       └────────────────────────────────┘
```

**⑧ Failure is non-fatal.** A throttled/offline Overpass is caught and swallowed;
the last good region stays. The UI never breaks on a failed pan — it just keeps
the previous coverage. Honest about it: this means a failed load is *silent* to
the user beyond the loader vanishing.

**⑩ The self-drain.** The single line that turns a lock into a queue. After
releasing the mutex, call `pump()` again — if a corridor or view request arrived
*while this build ran*, it runs now. Without this, the second request would hang
until some unrelated future `pump()` call.

### Move 3 — the principle

When you're metered by an external rate limit, the frontend's job is to *shape
demand*, not just issue requests. The pump is backpressure: it converts bursty UI
events (pan, pan, pan, route) into a serialized, prioritized stream the upstream
can survive. The general lesson — a mutex makes it safe, a self-drain tail makes
it a queue, and splitting pending-by-kind makes it prioritizable — transfers to
any "one expensive thing at a time, newest wins, with a fast lane" problem.

## Primary diagram

```
  Single-flight pump — full picture (useTileGraph.ts)

  UI triggers                pending slots          drain loop
  ┌──────────────┐  write   ┌──────────────────┐
  │ ensureBbox   │ ───────► │ pendingCorridorRef│──┐
  │ (route)      │          └──────────────────┘  │  pump():
  ├──────────────┤  write   ┌──────────────────┐  │   if busyRef → return
  │ queueViewport│ ───────► │ pendingViewRef   │──┤   take corridor else view
  │ (pan/toggle) │          └──────────────────┘  │   busyRef = true
  └──────────────┘                                ▼
                              ┌─ async build ──────────────────────┐
                              │ fetchOverpass → buildGraph(+elev)   │
                              │ commit: ref + setState              │
                              │ finally: busyRef=false; pump() ◄────┼─ self-drain
                              └─────────────────┬───────────────────┘
                                                ▼
                              setCorridor/setView → graph memo → UI
```

## Elaborate

"Single-flight" is the Go `singleflight` package's name for collapsing duplicate
in-flight work; "request coalescing" is the CDN term. flattr's version adds
priority, which makes it closer to a tiny OS scheduler: a run queue (two slots), a
running flag (the mutex), and a dispatcher (`pump`) that picks by priority. The
ref-vs-state split is the React-specific twist — refs for the scheduler's
internal bookkeeping (no re-render), state for the committed result (re-render).
Read next: `study-runtime-systems` (this *is* a userland scheduler over the event
loop), `study-networking` (the rate limits this exists to respect),
`05-debounce-as-throttle-with-self-heal.md` (the hardening layered on top).

## Interview defense

**Q: "How do you avoid hammering the free Overpass/Open-Meteo APIs?"**
A single-flight pump in `useTileGraph` (`:166`). A `busyRef` mutex guarantees one
graph build at a time; UI events write into one of two pending ref-slots
(corridor or viewport); `pump` drains the corridor slot first, runs the build,
and in its `finally` calls `pump` again to drain the next. Bursty pans collapse to
the latest-per-kind, and a route never starves behind a background pan.

```
  triggers → [corridor slot]/[view slot] → pump (busyRef gate) → build → pump again
```
*Anchor: a mutex makes it safe; the `finally { pump() }` tail makes it a queue.*

**Q: "Why refs and not state for the queue?"**
Because mutating the queue must not re-render — `busyRef`, the pending slots, and
the cached regions are control-plane bookkeeping. Only the *committed* region is
mirrored into `useState` (`setCorridor`/`setView`) so the derived merged-graph
memo recomputes. Refs = control plane, state = render plane.

```
  refs (no render): busyRef, pending*Ref, *Ref
  state (renders):  view, corridor → graph memo → UI
```
*Anchor: the load-bearing part people forget — the self-drain tail; without it
it's a lock, not a queue.*

**Q: "What happens on a failed fetch?"**
Caught and swallowed in the `try/catch`; the last good region stays, so the UI
keeps its previous coverage and a later pan retries. Non-fatal by design — the
tradeoff is the failure is silent beyond the loader disappearing.

## See also

- `05-debounce-as-throttle-with-self-heal.md` — the debounce feeding the viewport
  slot and the degraded-region re-queue that rides on the pump.
- `06-persistent-write-behind-cache.md` — the elevation cache that lets revisited
  areas skip the build entirely.
- `01-render-thread-astar.md` — each committed region changes `graph` identity,
  re-running the route memo.
- `audit.md` §2, §4.
