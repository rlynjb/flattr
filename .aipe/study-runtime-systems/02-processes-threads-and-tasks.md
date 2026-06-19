# Processes, threads, and tasks

*Process boundaries, threads, workers, schedulers — where work runs.*
**Type:** Industry standard (single-threaded JS execution model).

## Zoom out, then zoom in

The honest headline: **flattr has no threads you wrote and no workers at
all.** One JS thread per process, full stop. So this file isn't a tour of
flattr's threading — it's a tour of the threading model flattr *inherits*
from JavaScript, and a precise accounting of where that single thread
becomes a problem.

```
  Zoom out — the threading reality, marked on the runtime map

  ┌─ BUILD process (Node) ───────────────────────────────────┐
  │  ★ 1 JS thread ★   +   libuv I/O pool (hidden, untouched) │ ← we are here
  └──────────────────────────────────────────────────────────┘

  ┌─ RUN process (Hermes / RN) ──────────────────────────────┐
  │  ★ 1 JS thread ★   +   1 native UI/render thread (MapLibre)│ ← and here
  │     (your code)        (you never write code on it)        │
  └──────────────────────────────────────────────────────────┘

   what's NOT here: worker_threads, child_process, cluster,
   RN worklets, Atomics, SharedArrayBuffer — `not yet exercised`
```

Zoom in: the question this file answers is *which thread does each piece
of flattr's work run on, and what happens when one piece hogs it?* The
answer is "the same thread does everything," and the surprising
consequence is that a graph search and a UI repaint compete for the same
CPU in the mobile app.

## Structure pass

**Layers.** The thread model nests in three levels:

```
  Layered decomposition — "what can preempt this work?"

  ┌───────────────────────────────────────────────┐
  │ outer: the OS process                          │ → OS preempts it
  └───────────────────────────────────────────────┘   (true parallelism
      ┌─────────────────────────────────────────┐      with other procs)
      │ middle: the single JS thread              │ → NOTHING preempts it
      └─────────────────────────────────────────┘   (cooperative only)
          ┌─────────────────────────────────────┐
          │ inner: one task (a render, a search) │ → runs to completion
          └─────────────────────────────────────┘   (no yield points)

  the axis "can this be preempted?" flips YES→NO→NO down the stack —
  that NO at the JS-thread layer is the whole story
```

**Axis — control / preemption.** Trace "who can interrupt this work?"
The OS can interrupt the *process* (real preemptive multitasking). But
**inside** the JS thread, nothing interrupts a running task. A function
that doesn't `await` runs start to finish, and the event loop can't
service anything else — not a tap, not a frame — until it returns.

**Seam.** The load-bearing boundary is **JS thread ↔ native UI thread**
in the app. On the MapLibre side, rendering happens off the JS thread, so
a slow JS task doesn't freeze the *map tiles* themselves — but it does
freeze React (your markers, overlays, the route line), because those are
JS-thread work. The seam is where "preemptible" flips to "cooperative."

## How it works

### Move 1 — the mental model

You know this shape from the browser: **JavaScript is single-threaded with
a run-to-completion guarantee.** A function holds the thread until it
returns or hits an `await`. That's the same model in Node and in Hermes.
The only "parallelism" you get is the event loop interleaving *tasks* —
and a task only yields the thread at an `await`/callback boundary, never
mid-function.

```
  Pattern — run-to-completion on one thread

  time ─────────────────────────────────────────────►
  │ task A (render)  │ task B (astar)        │ task C │
  └──────────────────┴───────────────────────┴────────┘
   ▲                  ▲                        ▲
   each task owns      no preemption — B can't  next task
   the thread until    be paused to paint a     waits its
   it returns          frame; the frame waits   turn

   long task B = dropped frames (the freeze)
```

### Move 2 — walk the pieces

**The build process is one thread that mostly waits.** `run-build.ts`'s
`main()` is a sequence of `await`s. While it waits on `fetchOverpass`, the
JS thread is *free* — libuv handles the socket on a background thread and
wakes the JS thread when bytes arrive. So the build thread is rarely the
bottleneck; the network is. The CPU work (`buildGraph`) is synchronous,
but it runs after the I/O, on an otherwise-idle thread, and nobody's
watching a UI. (Detail: `03-`.)

**The run process is one thread that can't afford to wait.** Everything
React does is JS-thread work. When `MapScreen` re-renders, the `useMemo`
that calls `directedAstar` runs *on that thread, synchronously, during
render*. There's no yield inside the search loop. So:

```
  Execution trace — a search during render (run process, JS thread)

  step  thread activity                       UI state
  ────  ────────────────────────────────────  ──────────────
  1     setUserMax(6) triggers re-render       responsive
  2     useMemo deps changed → call astar      FROZEN (no yield)
  3       open.pop() ... relax edges ... loop  FROZEN
  4       ...graph large → loop runs long...   FROZEN (dropped frames)
  5     astar returns path                     unfreezes
  6     routeToGeoJSON, render commits          new route paints

  the freeze in steps 2-5 is exactly as long as the search takes
```

**There is no worker to offload to.** In a browser you'd reach for a Web
Worker; in RN you'd reach for a worklet or a native module. flattr has
neither in the routing path. The `grep` for `Worker|worker_threads|
runOnJS|InteractionManager` comes back empty. So the only lever to keep
the thread responsive is *keep the synchronous task short* — which today
means *keep the graph small* (the bbox is deliberately tiny,
`config.ts:10`, comment: "Kept small so... graph.json stays
phone-friendly").

**The "tasks" flattr does schedule are timers, not threads.** The
debounce (`useTileGraph.ts:139`), the autocomplete delay
(`MapScreen.tsx:77`), the retry backoff (`elevation.ts:98`) — all
`setTimeout`. These don't add parallelism; they *defer* work to a later
turn of the same single thread. (Detail: `03-`.)

#### Move 2 variant — the load-bearing skeleton

The irreducible kernel of flattr's threading is brutally simple:

```
  Skeleton — one thread, cooperative scheduling

  [ single JS thread ] runs [ one task ] to completion,
  yields ONLY at await/timer boundaries,
  then picks the next task off the loop

  remove "yields at await": nothing async ever resumes — deadlock
  remove "runs to completion": you'd need locks — but JS has none
```

What breaks if you forget the "runs to completion" half? You write
`directedAstar` assuming it'll "share" the thread fairly with the UI — and
it doesn't. It takes the thread and holds it. That misunderstanding is
finding #1 in the audit. The *hardening* you'd add on top (chunking the
search across ticks, an `InteractionManager.runAfterInteractions`, a
worker) is all `not yet exercised`.

### Move 3 — the principle

On a single-threaded runtime, **responsiveness is a budget, not a
guarantee.** Every synchronous function you call on the interactive thread
spends from the same frame budget the UI needs. The discipline isn't
"add threads" — it's "keep synchronous tasks under one frame, or
explicitly yield." flattr buys responsiveness today by keeping the graph
small; it has no mechanism to stay responsive once the graph grows.

## Primary diagram

The full thread picture across both processes, with the one dangerous
overlap marked.

```
  flattr threading — both processes, the hazard marked

  BUILD PROCESS                    RUN PROCESS
  ─────────────                    ───────────
  ┌─ JS thread ──────────┐         ┌─ JS thread (Hermes) ──────────┐
  │ main():              │         │ React render loop              │
  │  await fetch  ◄──────┼─┐       │  useMemo → directedAstar ★     │
  │  buildGraph (sync)   │ │       │  nearestNode (sync O(N))       │
  └──────────────────────┘ │       │  setTimeout debounce/backoff   │
                           │       └────────────┬───────────────────┘
  ┌─ libuv I/O pool ──────┐│                    │ shares NOTHING with↓
  │ socket / disk threads ││       ┌─ native UI thread (MapLibre) ──┐
  │ (wake JS on done)     │┘       │  map tile render (off JS) ─────┤
  └───────────────────────┘        └────────────────────────────────┘

  ★ = the synchronous search runs ON the JS thread that also runs React;
      a long search freezes React (not the native map tiles)
```

## Implementation in codebase

**Use cases.** This model bites in exactly one place: a search or a
nearest-node scan that's too long for one frame. Today the bbox is small
enough that it doesn't (`config.ts:10`). The moment `useTileGraph` merges
enough tiles, it will.

The search is plainly synchronous — no `async`, no `await`, no yield:

```
  features/routing/astar.ts  (lines 22-48, condensed)

  export function search(...): SearchResult {   ← NOT async — returns directly
    const open = new PQueue<string>();
    ...
    while (!open.isEmpty()) {                    ← tight loop, no yield point
      const current = open.pop()!;
      ...                                        ← every iteration holds the thread
    }
  }
        │
        └─ no `await` anywhere inside: once called, this owns the JS thread
           until the goal pops or the heap empties. On the phone that's the
           same thread painting the UI — finding #1.
```

And it's called *during render*, the worst possible place for long sync
work:

```
  mobile/src/MapScreen.tsx  (lines 143-147)

  const routed = useMemo(() => {
    if (!graph || !startId || !endId) { ... }
    const r = directedAstar(graph, startId, endId, userMax);  ← sync call in render
    ...
  }, [graph, startId, endId, userMax]);
        │
        └─ useMemo runs its function synchronously during the render pass.
           So the search executes inside React's commit path — the UI can't
           paint the previous frame's result until the search returns.
```

The `nearestNode` scan has the same shape, run on every graph change:

```
  features/routing/nearest.ts  (lines 5-18)

  export function nearestNode(graph: Graph, point: LatLng): string {
    for (const id of Object.keys(graph.nodes)) {   ← O(N) over ALL nodes
      const d = haversine(point, ...);              ← a trig call per node
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
  }
        │
        └─ also synchronous, also called in a useMemo (MapScreen.tsx:125-126),
           and re-run every time the merged graph changes as tiles load.
           Linear, no spatial index — fine while N is small.
```

## Elaborate

The single-threaded event loop is JavaScript's defining runtime choice:
no shared-memory races *by construction*, at the cost of no free
parallelism. Node added `worker_threads` (2018) and the browser has Web
Workers precisely because CPU-bound work breaks the model — you have to
move it off the one thread or accept the freeze. flattr is squarely in
"accept it by keeping work small" territory, which is the right call for
a tiny bundled graph and the wrong call the day the graph grows.

The fix, when needed, is not threads first — it's *yielding*: chunk the
A* loop to run N expansions per tick and `await` a `setTimeout(0)`
between chunks, or gate it behind `InteractionManager`. Only if that's
not enough do you reach for a worker. What to read next: `03-` for the
event loop those yields would hook into; `07-` for the bounded-work and
cancellation gaps.

## Interview defense

**Q: "Is this app multi-threaded?"**

No — single JS thread per process. The build process has Node's libuv I/O
pool, but the code never touches it directly; it's just what makes
`await fetch` non-blocking. The app has the Hermes JS thread plus
MapLibre's native render thread, but all *my* code — React, the router,
geocoding — runs on the one JS thread.

```
  my code:   ████ one JS thread ████
  free pool: libuv (I/O only, I don't write to it)
  native:    MapLibre render (I don't write to it)
```

Anchor: *"One JS thread does everything I wrote; the other threads are the
runtime's, not mine."*

**Q: "What's the risk of running A* on that thread?"**

Run-to-completion. The search has no yield points
(`astar.ts:48` `while` loop, no `await`), and it's called in a `useMemo`
during render (`MapScreen.tsx:143-147`). So a long search freezes React
for exactly its duration — dropped frames, an unresponsive UI. It's safe
today only because the bbox is tiny (`config.ts:10`).

```
  search runs ──► thread held ──► no frames ──► freeze
  (the longer the search, the longer the freeze)
```

Anchor: *"Synchronous CPU on the interactive thread spends the same frame
budget the UI needs — the search and the repaint can't both have it."*

## Validate

**Reconstruct.** From memory, list every thread in each process and say
which ones flattr's code actually runs on. (Build: 1 JS + libuv pool, code
on JS only. Run: 1 JS + 1 native, code on JS only.)

**Explain.** Why does a slow `directedAstar` freeze the markers and route
line but *not* the base map tiles? (Markers/route are React = JS thread;
base tiles render on MapLibre's native thread — `MapScreen.tsx:263-292`,
seam in the Primary diagram.)

**Apply.** The graph grows 50× and searches take 200ms. Name two
JS-only fixes before reaching for a worker. (Chunk the `while` loop in
`astar.ts:48` across ticks with `setTimeout(0)` yields;
gate the `useMemo` call behind `InteractionManager.runAfterInteractions`.)

**Defend.** Argue that the current no-worker design is correct *today*.
(The bbox at `config.ts:10` keeps N small enough that the search is
sub-frame; adding a worker now is complexity with no payoff. The decision
flips when the merged graph from `useTileGraph` grows.)

## See also

- `03-event-loop-and-async-io.md` — the loop and where the yields go
- `07-backpressure-bounded-work-and-cancellation.md` — bounded-work fixes
- [`.aipe/study-dsa-foundations/`](../study-dsa-foundations/) — the A* loop itself
- [`.aipe/study-performance-engineering/`](../study-performance-engineering/) — measuring the freeze
