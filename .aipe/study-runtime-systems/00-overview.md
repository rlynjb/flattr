# Runtime Systems — flattr

> Where does work execute, what resources does it own, and what breaks
> under concurrency or overload?

This guide reads `flattr` through one lens: the **execution model**. Not
*what* the code computes (the A* mechanics live in
[`.aipe/study-dsa-foundations/`](../study-dsa-foundations/)) and not
*where* the components sit (boundaries live in
[`.aipe/study-system-design/`](../study-system-design/)) — but *how* it
runs. Which thread. Which event-loop tick. How much memory it holds at
once. What happens when the network throttles or the user pans twice
before the first build finishes.

## The verdict up front

flattr is a **single-threaded, two-runtime, mostly-synchronous** system.
There is exactly one place where it does real concurrency control
(`mobile/src/useTileGraph.ts`, the `pump()` single-flight gate) and
exactly one place where async I/O sequencing matters (`pipeline/`'s fetch
loops). Everything else — the entire routing core, the grade
classification, the GeoJSON shaping — is straight-line synchronous CPU
work on whatever thread called it.

That simplicity is mostly a strength. It's also where the one genuine
runtime hazard hides: the A* search runs **synchronously on the
JavaScript thread**, and in the mobile app that thread is also the UI
thread. A big enough graph and the screen freezes mid-search. Hold that
thought — it's finding #1.

```
  flattr's runtime — two execution contexts, one threading model

  ┌─ BUILD-TIME runtime (Node via tsx) ──────────────────────┐
  │  pipeline/run-build.ts   bench/run.ts                     │
  │    async I/O: Overpass + Open-Meteo fetches (sequential)  │
  │    CPU: parse → split → grade → buildAdjacency            │
  │    one process, one thread, one event loop                │
  └──────────────────────────────┬───────────────────────────┘
                                  │  emits  data/graph.json
                                  │  (static artifact, ~544 KB)
                                  ▼
  ┌─ RUN-TIME runtime (Hermes JS engine on the phone) ───────┐
  │  mobile/src/MapScreen.tsx  (React render loop)            │
  │    useTileGraph.pump()  ── async I/O: same fetch code     │
  │    directedAstar()      ── SYNCHRONOUS CPU on JS thread ★ │
  │    nearestNode()        ── SYNCHRONOUS O(N) scan          │
  │  single JS thread (Hermes) + native UI thread (MapLibre)  │
  └──────────────────────────────────────────────────────────┘

  ★ = finding #1: the search blocks the same thread that paints the UI
```

## Ranked findings

**1. The A* search is synchronous and runs on the UI's JS thread.**
`directedAstar` (`features/routing/astar.ts:22-78`) is a plain `while`
loop — no `await`, no yielding. In the mobile app it's called inside a
`useMemo` during render (`mobile/src/MapScreen.tsx:143-154`). For the
bundled Capitol Hill slice this is fine (small graph, microseconds). But
once `useTileGraph` merges viewport + corridor tiles, the graph grows,
and a long search will block Hermes — the thread that runs React and
hands frames to MapLibre. There is no `InteractionManager`, no chunking,
no worker offload. → `02-`, `03-`, `07-`.

**2. There's exactly one concurrency-control primitive, and it's hand-rolled.**
`useTileGraph`'s `pump()` (`mobile/src/useTileGraph.ts:89-129`) is a
single-flight mutex: `busyRef` is the lock, two `pending*Ref` slots are
the one-deep queue, corridor beats view as a fixed priority. This is the
backpressure story for the whole app — and it's a 40-line `useRef`
state machine, not a library. It's correct, and it's the most
interesting runtime object in the repo. → `04-`, `07-`.

**3. Nothing is cancellable.** No `AbortController`, no abort signals
threaded into `fetch`, no way to stop an in-flight build when the user
pans away or picks a new route. A superseded viewport fetch runs to
completion and *then* `pump()` drains the next one
(`useTileGraph.ts:123-127`). Stale work isn't killed; it's just ignored
when it lands (the result overwrites state, but a newer pan already
queued behind it). → `07-`.

**4. Async I/O is strictly sequential, by deliberate choice.**
Every external call — Overpass, Open-Meteo, Nominatim — is `await`ed one
at a time. The elevation provider sleeps `300ms` between batches
(`pipeline/elevation.ts:121`); the two geocode calls in `handleRoute`
run back-to-back, not in parallel (`MapScreen.tsx:181`). This is rate-limit
politeness, not a perf bug. The retry loops with exponential backoff
(`elevation.ts:108-119`, `overpass.ts:32-47`) are the only place the
event loop does timed work. → `03-`, and the protocol detail lives in
[`.aipe/study-networking/`](../study-networking/).

**5. Memory is bounded by the bbox, held entirely in the JS heap.**
The whole graph is a plain in-memory object graph: `Record<string, Node>`
plus an `Edge[]` plus an adjacency `Record`. The bundled artifact is
~544 KB of JSON, parsed once at module load (`mobile/src/loadGraph.ts`).
A* allocates a handful of `Map`/`Set` per search and lets GC reclaim them
after. Merged tiles accumulate in React state and are never evicted —
the one place memory grows without bound as you pan. → `05-`.

## `not yet exercised` — honest gaps

These are real runtime topics the repo simply does not contain. The
concept files teach them and say when they'd become relevant.

- **Threads / workers / process pools.** Zero. No `worker_threads`, no
  `child_process`, no `cluster`, no RN worklets in the routing path.
  Single thread everywhere. (`02-`)
- **Shared mutable state across threads.** Can't exist without threads.
  No `Atomics`, no `SharedArrayBuffer`, no locks-for-correctness. The one
  "lock" (`busyRef`) is cooperative single-thread coordination, not a
  memory-safety primitive. (`04-`)
- **Streaming / descriptors / handle lifecycle.** The pipeline does one
  blocking `writeFileSync` (`pipeline/run-build.ts:12`) and reads JSON via
  bundler import. No streams, no open file descriptors held across awaits,
  no manual `close()`. (`06-`)
- **Graceful shutdown / deadlines / signal handling.** No `SIGTERM`
  handler, no request deadlines, no shutdown drain. The build process
  just sets `process.exitCode = 1` on error and exits
  (`run-build.ts:54-57`). (`07-`)
- **Manual GC tuning / off-heap memory.** Everything is ordinary V8/Hermes
  heap. No `Buffer` pools, no `WeakMap`-based caches, no GC pressure
  management. (`05-`)

## Reading order

```
  00  overview ............................ you are here
  01  runtime-map ......................... the as-built resource map
  02  processes-threads-and-tasks ......... one thread, two runtimes
  03  event-loop-and-async-io ............. the fetch loops + backoff
  04  shared-state-races-and-synchronization  the pump() single-flight
  05  memory-stack-heap-gc-and-lifetimes .. the graph in the heap
  06  filesystem-streams-and-resource-lifecycle  writeFileSync + import
  07  backpressure-bounded-work-and-cancellation  the bounded-work story
  08  runtime-systems-red-flags-audit ..... ranked risks, with evidence
```

Start at `01` for the map, then read in order. `08` is the audit — every
risk there links back to the concept file that explains it.

## Cross-links

- **A* loop mechanics, heap, graph traversal** →
  [`.aipe/study-dsa-foundations/`](../study-dsa-foundations/)
- **The bench harness, profiling, latency budgets** →
  [`.aipe/study-performance-engineering/`](../study-performance-engineering/)
- **DNS / HTTP / retry protocol details for the pipeline fetches** →
  [`.aipe/study-networking/`](../study-networking/)
- **Component boundaries and where state is owned** →
  [`.aipe/study-system-design/`](../study-system-design/)
