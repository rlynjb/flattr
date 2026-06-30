# Processes, Threads, and Tasks — where work actually runs

**Industry name:** execution context / threading model — *Industry standard*.

## Zoom out, then zoom in

Where does flattr's work *physically* run? The honest answer is short: on one JS thread per
process, always. Here's where that thread sits in the stack.

```
  Zoom out — the threading model in the layer stack

  ┌─ App code (yours) ───────────────────────────────────────────┐
  │  MapScreen, useTileGraph, astar, buildGraph                  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ all runs on ↓
  ┌─ JS runtime ─────────────────▼───────────────────────────────┐
  │  ★ ONE JS THREAD ★  (Hermes in app · Node in pipeline)       │ ← we are here
  │  event loop schedules tasks cooperatively                    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ delegates blocking I/O / render to ↓
  ┌─ Native threads (not yours) ─▼───────────────────────────────┐
  │  GC · MapLibre render · AsyncStorage disk · network sockets  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question this file answers is **"how many threads, and what runs on each?"**
The answer — one JS thread doing all your logic, native threads underneath doing I/O and
rendering you never directly touch — determines everything about how you reason about
races (`04`), blocking (`03`), and memory (`05`). Get this layer right and the rest follows.

## Structure pass — layers, one axis, the seams

**The layers** are process → JS thread → native threads, already drawn above. **The axis:
"can two pieces of *my* code run at the same instant?"** Trace it down:

```
  Axis: "can two pieces of MY code run simultaneously?"  — held constant

  ┌─ process ────────────────────────────────────┐
  │  two processes, but never co-resident         │  → N/A (build then run)
  └────────────────────────────────────────────────┘
      ┌─ JS thread ──────────────────────────────┐
      │  one thread, cooperative scheduling       │  → NO. Never. This is the
      └────────────────────────────────────────────┘    load-bearing answer.
          ┌─ native threads ─────────────────────┐
          │  GC / render / I/O run concurrently   │  → YES, but you can't touch
          └────────────────────────────────────────┘    their state from JS
```

The answer is **NO at the layer that matters** (your JS code) and YES only at the native
layer you can't reach. That single fact is why flattr has no mutexes and no data races
(`04`) — and why a synchronous A\* freezes the *whole* app, not just one worker (`03`).

**The seams:**

```
  Two seams where the threading answer flips

  seam 1: JS thread ═╪═► native I/O thread
    at every `await`: your code pauses, native does the work concurrently,
    a microtask resumes you LATER — never interleaved mid-statement

  seam 2: JS thread ═╪═► MapLibre render thread
    you hand GeoJSON across; MapLibre renders on its own thread.
    a sync A* that blocks JS does NOT block MapLibre's existing frame —
    but blocks the NEXT GeoJSON update you'd send it
```

Hand off to How it works with the model named: one JS thread, native concurrency you
delegate to but never share state with.

## How it works

### Move 1 — the mental model

You've felt this exact model every time a heavy `.map()` over 50k items froze a React page.
React runs on one thread; a long synchronous loop blocks paint, input, everything, until it
returns. flattr's app is the same runtime with the same rule. The strategy isn't "use
threads" — it's **"keep every task short enough that the event loop can breathe between
them, and push anything blocking to a native thread via `await`."**

```
  The one-thread cooperative model — the kernel

   event loop owns control
        │
        ▼
   ┌─────────────┐   task runs to completion or to an await
   │  run task   │──────────────────────────────────────────┐
   └─────────────┘                                           │
        ▲                                                    │
        │  loop picks next ready task                        │
        └────────────────────────────────────────────────────┘

   RULE: no task is preempted mid-statement.
   A task that never yields (sync A* over a huge graph) starves every other task.
```

### Move 2 — the parts, one at a time

**Part 1 — the two processes (build vs run).** These are genuinely separate OS processes
that never run at the same time. The build process is Node, launched by `tsx`:

```ts
// package.json (scripts) — the build-time process entry
"build:graph": "tsx pipeline/run-build.ts"
```

```
  Process lifecycle — build dies before run starts

  developer runs `npm run build:graph`
    └─► Node process spawns ─► main() ─► writes graph.json ─► EXITS
                                                                │
  developer ships the app; user opens it                       │ (later, different machine)
    └─► Hermes process spawns ─► loads graph.json ──────────────┘
```

What breaks if you conflated them? Nothing technically — but you'd reach for shared memory
or a lock between build and run that can't exist, because they're not even on the same
device. The artifact (`graph.json`) is the only thing that crosses. *This is the load-bearing
isolation: drop it and you'd have to keep the pipeline running as a server.* (See `01`.)

**Part 2 — the one JS thread (per process).** This is where every line of *your* code runs.
There are no worker threads in the repo — verified: zero hits for `Worker`, `worklet`,
`Atomics`, `SharedArrayBuffer` across the whole codebase. Hermes is the engine in the app
(Expo SDK 56 default, no `jsEngine` override in `mobile/app.json` — *inferred from Expo 56
defaults*); Node's V8 in the pipeline. Both single-threaded for your purposes.

```ts
// mobile/src/MapScreen.tsx:151-162 — A* runs ON the JS thread, synchronously
const routed = useMemo(() => {
  if (!graph || !startId || !endId) { /* ... */ }
  const r = directedAstar(graph, startId, endId, userMax);  // ← CPU-bound, blocking
  // ... build GeoJSON + summary, all sync
}, [graph, startId, endId, userMax]);
```

`directedAstar` is the heaviest synchronous task in the app. While it runs, the JS thread
does nothing else — no input handling, no debounce timers firing, no promise callbacks.
For a city-sized graph this is microseconds-to-milliseconds and invisible. The boundary
where it breaks: a graph large enough that one search exceeds a frame budget (~16ms). Then
you'd see input lag, and the fix is Part 3.

**Part 3 — native threads you delegate to (not yet exercised for *your* work).** Hermes
runs GC on its own thread; MapLibre renders on a render thread; AsyncStorage does disk I/O
off-thread. You never write code that runs there — you hand work across via `await` (I/O)
or props (render). The repo has **no** mechanism to run *your* CPU work on another thread.

```
  Move 2.5 — current vs future: where A* runs

  ┌─ NOW ───────────────────────┐   ┌─ IF the graph grew (not yet) ──────┐
  │ A* in useMemo, JS thread,   │   │ A* in a Worker / worklet           │
  │ synchronous, blocks frame   │   │ JS thread posts {graph, s, e} →    │
  │                             │   │ worker runs A* → posts path back   │
  │ fine for city-sized graphs  │   │ JS thread never blocks             │
  └─────────────────────────────┘   └─────────────────────────────────────┘
   Migration cost: A* is already pure (astar.ts:22-78, no I/O, no React).
   It would move to a worker almost unchanged — the cost is the message
   plumbing + serializing the graph, not the algorithm.
```

*Trigger:* a measured frame drop during routing. Until then, on-thread is the right call —
no worker plumbing, no graph serialization cost, simpler to reason about.

### Move 3 — the principle

In a single-threaded runtime, "where does work run" has exactly one answer for your code —
*here, on this thread* — and the entire discipline becomes **keeping each task short enough
to yield.** You don't get parallelism; you get cooperative concurrency, and the failure
mode is starvation, not a race. The skill is spotting the one synchronous CPU task hiding
among the async ones (here, A\* in a `useMemo`) and knowing the escape hatch (a worker) and
its cost before you need it.

## Primary diagram

Every thread in flattr and what runs on it, in one frame.

```
  flattr threading model — one JS thread per process, native underneath

  BUILD PROCESS (Node)              RUN PROCESS (Hermes)
  ┌─────────────────────┐          ┌──────────────────────────────────┐
  │ JS thread:          │          │ JS thread (event loop):          │
  │  fetch→build→write  │          │  region/route/geocode tasks      │
  │  (sequential)       │          │  directedAstar (SYNC, blocks)    │
  └─────────────────────┘          └──────────────┬───────────────────┘
       │ native: net socket                       │ delegates via await/props
       ▼                                          ▼
  (transient, exits)               ┌─ native threads (not your code) ─┐
                                   │ GC · MapLibre render · disk I/O  │
                                   └──────────────────────────────────┘
```

## Elaborate

The "one JS thread + native delegation" model is the **Node/browser event-loop model**,
and React Native inherits it directly — your JS runs on a single thread and crosses a
bridge (or JSI, in newer RN) to native modules that have their own threads. The classic
escape hatches when CPU work won't fit are Web Workers (browser), `worker_threads` (Node),
and RN's reanimated worklets or `react-native-worklets-core` — the last is exactly what
flattr's sibling project `contrl` uses for its on-device ML pipeline (per `me.md`). flattr
hasn't needed it because its CPU task (A\*) is small. For how the *async* tasks get
scheduled on this one thread, see `03`; for why no threads means no races, see `04`.

## Interview defense

**Q: "How many threads does this app use for your code, and what's the risk?"**

One. All app logic — React, A\*, on-device graph building — runs on a single Hermes JS
thread. The risk is starvation: any synchronous task that runs too long blocks input,
rendering, and timers. The candidate is `directedAstar` in a `useMemo`.

```
  one JS thread:  [render][A* sync][timer][input]...
                          └─ if this is long, everything after it waits
```

*Anchor:* "Single-threaded means the bug isn't a race, it's a freeze — and the freeze
source is the one synchronous CPU task among the async ones."

**Q: "If A\* got too slow, what would you do?"**

Move it to a worker. It's already a pure function (`astar.ts:22-78`) with no I/O and no
React, so it ports almost unchanged — the cost is message plumbing and serializing the
graph across, not rewriting the search.

*Anchor:* "The algorithm's already isolated; the work is the boundary, not the code."

## See also

- `01-runtime-map.md` — where these threads sit in the full topology.
- `03-event-loop-and-async-io.md` — how tasks on the one thread are scheduled.
- `04-shared-state-races-and-synchronization.md` — why one thread means no real races.
- `study-system-design` (sibling) — the build/run process split as an architecture seam.
