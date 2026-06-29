# Event Loop & Async I/O — the JS thread and the blocking hazard

**Industry name(s):** event loop · microtask queue · cooperative concurrency ·
CPU-bound work on the UI thread. **Type:** Industry standard.

## Zoom out, then zoom in

Both of flattr's runtimes are single-threaded event loops — Node's libuv loop at
build time, Hermes's loop on the phone. Everything is either a synchronous run to
completion or an `await` that yields the loop. The whole story of this file lives
in the run-time loop, where one specific synchronous block — A* — competes with
the next animation frame.

```
  Zoom out — the event loop owns the run-time JS thread

  ┌─ UI layer ──────────────────────────────────────────┐
  │  user pans, taps, drags slider → native events       │
  └───────────────────────┬───────────────────────────────┘
                          │ marshalled to JS as callbacks
  ┌─ JS thread = ONE event loop (Hermes) ───────────────┐
  │  ┌ macrotasks: timers, native callbacks ─────────┐  │
  │  │  onRegionDidChange, setTimeout, GPS fix        │  │ ← we are here
  │  ├ microtasks: Promise .then / await resumptions ─┤  │
  │  │  fetch resolution, async build steps           │  │
  │  ├ render: React reconcile + paint ───────────────┤  │
  │  │  ★ A* runs HERE, synchronously, no yield ★      │  │
  │  └────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the question is **what runs to completion without yielding, and what
yields the loop?** Async I/O (`fetch`, `await sleep`) yields — that's why the
single-flight scheduler works without blocking the UI. But A* does *not* yield,
and it runs during render. That contrast is the lesson.

## Structure pass

**Layers.** Three kinds of work share the one loop: (1) async I/O — yields at
every `await`; (2) timer callbacks — macrotasks scheduled by `setTimeout`;
(3) synchronous compute — runs start-to-finish, blocking everything, including A*
and the graph-merge `useMemo`s.

**Axis traced — "does this yield the event loop (control)?"**

```
  One axis — "does it yield?" — across the work types

  fetchOverpass / await sleep   → YES, yields at every await   (I/O-bound)
  buildGraph (mostly awaits)    → YES, yields during sampling   (I/O-bound)
  setTimeout debounce/retry     → schedules a future macrotask  (yields now)
  stitchGraph + mergeGraphs     → NO, synchronous useMemo       (CPU-bound)
  directedAstar                 → NO, tight while-loop, no yield (CPU-bound) ★
```

**Seam — the `await` keyword itself.** Every `await` in `pump`'s async body
(`useTileGraph.ts:184-226`) is a point where the loop is handed back so the UI
stays responsive *during the network build*. The seam flips control from "this
task" to "whatever else is queued." The places with **no** `await` —
`directedAstar`, `stitchGraph`, `nearestNode` — are the seams that *don't* exist,
and that's the hazard.

## How it works

### Move 1 — the mental model

You know this from the browser: a `fetch()` doesn't freeze the page because it
yields; a `while(true){}` does freeze it because it never yields. The event loop
can only switch tasks at yield points, and a synchronous function has none.
flattr's network work is full of yields (so the spinner animates while streets
load); its A* has zero (so a big search would freeze the map).

```
  Pattern — the single loop, two fates for a task

   ┌──────────────── event loop tick ────────────────┐
   │                                                  │
   │  async task:  ──work──await──[YIELD]──work──done │  loop free here ↑
   │                                                  │
   │  sync  task:  ──────────work to completion───────│  loop BLOCKED entire time
   │               (A*, stitchGraph)        no yield  │
   └──────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Part 1 — async I/O yields, so the build never freezes the UI.** Inside `pump`,
every network step is awaited. While `fetchOverpass` is in flight, the loop is
free to animate the spinner, handle a pan, fire a timer:

```ts
// mobile/src/useTileGraph.ts:185-197
const osm = await fetchOverpass(bbox);     // ① yields ~seconds while network runs
...
const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, ..., onPhase); // ② yields
```

At ① and ②, the JS thread is *not* busy — it's parked, waiting on a microtask
that resolves when the socket delivers bytes. This is why `setLoadingStep` can
update a spinner mid-build: the render loop gets turns between awaits. The
boundary condition: nothing here is CPU-heavy on the JS side, so the loop is
genuinely idle during I/O.

**Part 2 — the backoff sleeps are macrotasks, not busy-waits.** When Open-Meteo
429s, the retry waits without burning CPU:

```ts
// pipeline/elevation.ts:98, 114-116
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
...
if (res.status === 429 && attempt < retries) {
  await sleep(delayMs * 2 ** (attempt + 1)); // ← parks the task; loop stays free
  continue;
}
```

`setTimeout` schedules a macrotask; the `await` parks this build until it fires.
During the (exponentially growing) wait, the UI thread is fully available. Contrast
with a `while (Date.now() < deadline) {}` spin, which would freeze the app for the
entire backoff. The choice here is correct.

**Part 3 — the hazard: A\* runs synchronously during render.** This is the one
piece of CPU work with no yield, and it's on the hottest path:

```ts
// mobile/src/MapScreen.tsx:151-162
const routed = useMemo(() => {
  ...
  const r = directedAstar(graph, startId, endId, userMax); // ← no await anywhere inside
  ...
}, [graph, startId, endId, userMax]);
```

And the search loop it calls (`astar.ts:48-76`) is a tight `while (!open.isEmpty())`
with heap pushes/pops and no `await`, no `yield`, no chunking. Whatever that loop
costs, the JS thread is blocked for the whole duration — and because it's in a
`useMemo`, it runs as part of React's render, so the frame can't paint until A*
returns.

```
  Execution trace — what the loop does during a route recompute

  frame N:  graph/startId changes → React render begins
            └─ useMemo runs → directedAstar()
               └─ while(open not empty): pop, expand, push ...  ← loop BLOCKED
               └─ ... returns path
            └─ render continues → setState → paint
  frame N+1: finally paints   ← if A* took >16ms, frame N was dropped (jank)
```

On the bundled 544 KB Capitol Hill graph this is fine — the haversine heuristic
keeps `nodesExpanded` small (see the bench harness). The hazard is *scale*: merge
a wide corridor from many tiles and the graph grows, A* expands more nodes, and
the block lengthens with no ceiling. **Inference:** there is no measured frame
budget in the repo, so the safe-graph-size threshold is untested — flagged in
`08-runtime-systems-red-flags-audit.md`.

**Part 4 — the merge `useMemo`s are also synchronous CPU.** `graph` and
`displayGraph` (`useTileGraph.ts:132-162`) rebuild via `stitchGraph(mergeGraphs(...))`
on every region change. `stitchGraph` (`tiles.ts:45-86`) iterates all nodes to
bucket by coordinate. That too is a non-yielding block on the render thread, run
each time a tile lands. Smaller than A* today, same category of hazard.

### Move 3 — the principle

A single-threaded event loop gives you concurrency *for free on I/O* and *nothing
for CPU*. Async I/O is safe to pile on because every `await` is a yield. CPU-bound
work is the opposite: it has no yield, so it owns the thread until it returns, and
if it's on the render path it owns the next frame too. The discipline is to keep
the loop's synchronous segments shorter than a frame — or move them off the thread.

## Primary diagram

```
  The run-time event loop — yields vs blocks, fully labelled

  ┌─ JS thread (Hermes) · one event loop ────────────────────────┐
  │                                                              │
  │  MACROTASKS                MICROTASKS            RENDER       │
  │  ┌──────────────┐          ┌──────────────┐    ┌──────────┐  │
  │  │ setTimeout   │          │ await resume │    │ useMemo: │  │
  │  │ (debounce,   │──────────│ (fetch, sleep│────│ A* +     │  │
  │  │  retry,      │  yields  │  resolve)    │    │ merge    │  │
  │  │  persist)    │   ←──────│  yields      │    │ NO YIELD │  │
  │  └──────────────┘          └──────────────┘    └────┬─────┘  │
  │       free during I/O ▲          free ▲              │ BLOCKS │
  │                       └───── loop available ─────────┘ frame  │
  └──────────────────────────────────────────────────────────────┘
   ★ I/O is safe to pile on (yields); CPU (A*) owns the thread till done ★
```

## Elaborate

This is the same lesson the browser taught with "don't block the main thread" and
that Node taught with "don't do sync `crypto`/`zlib` in a request handler." The
fix vocabulary is identical across runtimes: move CPU off-thread (Web Worker, RN
worklet, Node `worker_threads`), or chunk it with cooperative yields
(`setTimeout(0)` / `requestIdleCallback` / `scheduler.yield`). flattr does
neither yet because the current graph is small — a defensible call, but one with
no guardrail measuring when it stops being true.

## Interview defense

**Q: A\* is CPU-bound. Where does it run, and what's the risk?**

It runs synchronously inside a `useMemo` on the React render thread —
`MapScreen.tsx:151`. The search loop in `astar.ts:48` has no yield point, so the
JS thread is blocked for the whole search, and because it's during render, the
next frame can't paint until it finishes.

```
  the risk in one picture

  small graph:  A* < 16ms → fits in a frame → smooth
  big corridor: A* > 16ms → blocks render → dropped frames (jank)
                └─ no frame budget, no chunking, no worker → unbounded
```

Anchor: *"The network I/O is fine — every `await` yields the loop, so the spinner
animates while streets load. It's the synchronous A* and graph-merge `useMemo`s
that are the exposure, and there's no measurement gating graph size."*

**Q: Why doesn't the Open-Meteo backoff freeze the app?**

Because the wait is `await sleep(ms)` where `sleep` wraps `setTimeout` —
`elevation.ts:98`. That parks the task as a macrotask and hands the loop back; it
doesn't busy-wait. The exponential backoff can grow to seconds and the UI stays
fully responsive the whole time.

## See also

- `02-processes-threads-and-tasks.md` — the `pump()` scheduler that rides this loop.
- `07-backpressure-bounded-work-and-cancellation.md` — A* and `fetch` can't be cancelled.
- `.aipe/study-performance-engineering/` — measuring the A* frame cost and budget.
- `.aipe/study-dsa-foundations/` — the A* loop and heap that do the blocking work.
