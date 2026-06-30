# Runtime Systems — flattr

> Where work executes, what resources it owns, and what breaks under concurrency or overload.
> Every claim is grounded in `file:line`. Inferences are labeled. Mechanisms the repo
> doesn't have are marked `not yet exercised` with the trigger that would introduce them.

## The verdict, first

flattr is a **single-threaded JavaScript runtime, top to bottom.** There are two
distinct runtimes — but neither uses real threads:

- **Build-time pipeline** runs in **Node** via `tsx` (`pipeline/run-build.ts:54`,
  `package.json` → `build:graph`). One process, sequential async I/O, exits when done.
- **Mobile app** runs in **Hermes** (the Expo SDK 56 / RN 0.85 default — `mobile/app.json`
  declares no `jsEngine` override, so Hermes is in force; *inferred from Expo 56 defaults*).
  One JS thread, an event loop, MapLibre rendering on the native side.

There is no backend, no database server, no worker pool, no LLM. The "graph" the app
routes over is a static JSON artifact read off disk (`mobile/src/loadGraph.ts:7-11`).

The single most consequential runtime fact: **A\* runs synchronously on the JS thread,
inside a `useMemo`** (`mobile/src/MapScreen.tsx:151-162`). It is not offloaded, not
chunked, not cancellable. For a city-sized merged graph that's fine; it's the first thing
that bites if the graph grows.

The second: **`pump()` is a hand-rolled single-flight queue** with no real lock —
correctness rests entirely on the JS event loop being single-threaded
(`mobile/src/useTileGraph.ts:166-227`). The third: **there is no cancellation anywhere** —
no `AbortController`, no `AbortSignal` in the whole repo (verified by grep). Stale network
builds run to completion and their results are written even when the user has moved on.

## The runtime map — one frame

The whole execution model in one picture: two single-threaded runtimes, a static artifact
between them, and the network calls the app makes at runtime.

```
  flattr — two single-threaded runtimes, one shared artifact

  ┌─ BUILD TIME (Node process, via tsx) ─────────────────────────┐
  │  run-build.ts main()                                         │
  │    fetchOverpass ──► parseOsm ──► splitWays                  │
  │      ──► sampleElevations (sequential batches + backoff)     │
  │      ──► computeGrades ──► buildAdjacency                    │
  │  writes ─────────────────────────────────────────────┐      │
  └───────────────────────────────────────────────────────┼──────┘
                                                           ▼
                                            ┌─ ARTIFACT ──────────┐
                                            │ mobile/assets/      │
                                            │   graph.json        │ ← static, read-only
                                            └──────────┬──────────┘
                                                       │ bundled, loaded once
  ┌─ RUN TIME (Hermes JS thread, RN app) ───────────────▼─────────┐
  │  loadGraph() ──► baseGraph (in-memory, never evicted)         │
  │                                                               │
  │  event loop:                                                  │
  │    pan ─debounce 600ms─► queueViewport ─► pump() ─┐           │
  │    route ──────────────► ensureBbox ────► pump() ─┤ 1-at-a-   │
  │                                                   │ time      │
  │    pump(): fetchOverpass ──► buildGraph (on device)│          │
  │             (sequential I/O, no cancel)            │          │
  │                                                               │
  │    A* (directedAstar) runs SYNC in useMemo ◄── render thread  │
  └───────────────────────────────────────────────────────────────┘
        │ network hops (runtime)        │ persistent store
        ▼                               ▼
  Overpass API · Open-Meteo ·     AsyncStorage (elevCache)
  Nominatim (geocode)
```

## Ranked findings

| # | Finding | Where | Consequence |
|---|---------|-------|-------------|
| 1 | A\* runs synchronously on the JS/render thread | `MapScreen.tsx:151-162` | A large graph blocks the frame; UI stutters. Bounded today by city-sized graphs. |
| 2 | No cancellation anywhere (no `AbortController`) | grep: zero hits | Stale pan/route builds run to completion and write their result; wasted network + possible visual flicker. |
| 3 | Single-flight `pump()` relies on JS being single-threaded | `useTileGraph.ts:166-227` | Correct today; the `busyRef` "lock" is not a real lock. Breaks the instant work moves off-thread. |
| 4 | In-memory graph never evicted | `useTileGraph.ts:132-162` | Merged graph grows monotonically as you pan; unbounded memory over a long session. |
| 5 | Sequential network I/O with backoff, no concurrency cap needed | `elevation.ts:100-125`, `overpass.ts:32-47` | Slow but rate-limit-safe; serialization *is* the backpressure. |
| 6 | Persistent elevation cache, debounced writes, FIFO cap | `elevCache.ts` | Bounded disk; survives restarts; the one place with real lifecycle management. |

## Reading order

1. `01-runtime-map.md` — the as-built process/task/resource map (start here).
2. `02-processes-threads-and-tasks.md` — two runtimes, one JS thread each, where work runs.
3. `03-event-loop-and-async-io.md` — the event loop, debounce timers, async I/O, blocking hazards.
4. `04-shared-state-races-and-synchronization.md` — `busyRef`/refs, the single-flight "lock", why there are no real races.
5. `05-memory-stack-heap-gc-and-lifetimes.md` — heap growth, the un-evicted graph, A\*'s stack.
6. `06-filesystem-streams-and-resource-lifecycle.md` — `graph.json`, AsyncStorage, no streams, no descriptors.
7. `07-backpressure-bounded-work-and-cancellation.md` — the single-flight queue, debounce, missing cancellation.
8. `08-runtime-systems-red-flags-audit.md` — ranked execution-model risks with evidence.

## `not yet exercised` — and the trigger for each

These are real runtime mechanisms the repo does **not** contain. Named honestly so the
guide teaches them without pretending flattr uses them.

- **Real threads / worker pools** — no `Worker`, no `worklets`, no thread pool (grep: zero).
  *Trigger:* moving A\* or on-device graph builds off the JS thread to stop frame drops.
- **Locks / atomics / channels** — no `Mutex`, `Atomics`, `SharedArrayBuffer` (grep: zero).
  *Trigger:* the moment any shared state is touched from a second thread (see worker trigger).
- **Cancellation / `AbortController` / deadlines** — none anywhere (grep: zero).
  *Trigger:* superseding a stale pan/route build, or a per-request timeout budget.
- **Streaming / backpressure on streams** — no Node streams, no `ReadableStream` in the hot
  path; responses are buffered whole (`overpass.ts:41`, `elevation.ts:111`).
  *Trigger:* responses too large to hold in memory, or incremental render of partial results.
- **Graceful shutdown** — the pipeline process just exits (`run-build.ts:54-57`); the app
  has no teardown of in-flight builds. *Trigger:* a long-lived server, or unmount cleanup.
- **GC tuning / explicit lifetimes** — JS GC is implicit; nothing is tuned or pinned.
  *Trigger:* a measured memory-pressure problem (the un-evicted graph is the candidate).

## Partition note

This guide owns **how code executes inside one runtime**. *Where* components live and how
requests cross boundaries is `study-system-design`. *How* the network behaves (DNS, TLS,
retries as protocol) is `study-networking`. *How* this is verified deterministically is
`study-testing`. Cross-links point there rather than re-teaching.
