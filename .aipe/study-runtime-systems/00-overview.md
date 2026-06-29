# Runtime Systems — flattr

> Where does work execute, what resources does it own, and what breaks under
> concurrency or overload? This guide audits flattr's execution model: the two
> single-threaded JS runtimes it runs on, the work each one schedules, and the
> places that work is unbounded, uncancellable, or run on the wrong thread.

flattr has **no servers, no database engine, no threads, no worker pools, no
LLM**. That sounds like it removes runtime concerns. It doesn't — it concentrates
them. Everything runs on a single JS thread in one of two runtimes, and the most
interesting decisions in this repo are about *what not to run on that thread* and
*how to serialize the work that crosses the network*.

## The two runtimes — one diagram

flattr is two programs sharing one TypeScript core. They never run at the same
time, and they have completely different execution models.

```
  flattr's two runtimes — same code, two execution models

  ┌─ BUILD TIME · Node (tsx) ───────────────────────────────┐
  │  process: `npm run build:graph` → pipeline/run-build.ts  │
  │  one process, runs once, exits                           │
  │  fetch OSM → sample elevation → compute grades →         │
  │  write data/graph.json (the artifact)                    │
  │  lifetime: seconds-to-minutes, then process dies         │
  └────────────────────────┬────────────────────────────────┘
                           │ produces a static file
                           ▼  mobile/assets/graph.json (544 KB)
  ┌─ RUN TIME · Hermes / React Native ──────────────────────┐
  │  process: the Expo app on the phone                      │
  │  long-lived, one UI thread (the JS thread)               │
  │  reads graph.json → A* on the render thread →            │
  │  pan loads more tiles (network) → merge → re-route       │
  │  lifetime: as long as the app is open                    │
  └──────────────────────────────────────────────────────────┘
```

The seam between them is `graph.json` — a file. The build-time process owns all
the network I/O and elevation math; the run-time process owns the interactive
A* and the on-device tile builds. The same `pipeline/build-graph.ts` runs in
*both* (Node at build time, Hermes when the phone fetches a new viewport), which
is why it carefully avoids `node:fs` (see its header comment, line 2).

## Ranked findings — what's most consequential

**1. A\* runs synchronously on the render thread (`MapScreen.tsx:151-162`).**
`directedAstar` is called inside a `useMemo` in the component body. There is no
worker, no `InteractionManager`, no yielding. On the bundled Capitol Hill graph
(544 KB, thousands of nodes) it's fast enough; the heuristic keeps expansions
low. But the cost is unbounded by design — a wide corridor merged from many
tiles grows the graph, and the search blocks the JS thread for its full
duration. There is no frame budget and no cancellation. This is the single most
load-bearing runtime decision in the app.
→ see `03-event-loop-and-async-io.md` and `07-backpressure-bounded-work-and-cancellation.md`.

**2. The single-flight `pump()` is the app's entire scheduler
(`useTileGraph.ts:166-227`).** One graph build runs at a time. A `busyRef`
boolean is the lock; corridor requests preempt viewport requests; the `finally`
block drains the next pending request. This is a hand-rolled, single-slot work
queue — the closest thing flattr has to a task scheduler, and it exists entirely
to stay under free-tier rate limits.
→ see `02-processes-threads-and-tasks.md`.

**3. Stale work is never cancelled — it's superseded
(`useTileGraph.ts`, `MapScreen.tsx`).** Pan three times quickly and the debounce
collapses it to one queued request, but a build already *in flight* runs to
completion even though its result is about to be irrelevant. `fetch` is never
aborted. A* from an old `startId` runs to completion before React re-renders with
the new one. flattr leans on debounce + single-flight + React's
recompute-on-change to make stale work cheap, not to cancel it.
→ see `07-backpressure-bounded-work-and-cancellation.md`.

## not yet exercised

These runtime lenses don't appear in the repo. Named honestly so the audit is
complete, with the trigger that would make each relevant:

- **Real threads / worker pools / parallelism** — `not yet exercised`. Both
  runtimes are single-threaded JS. No `Worker`, no `worklet`, no
  `InteractionManager`. Becomes relevant the moment A* is moved off the render
  thread (the obvious next move).
- **Shared mutable state across threads / locks / atomics** —
  `not yet exercised`. With one thread there are no data races. The only
  "synchronization" is a `busyRef` boolean, which is cooperative, not a lock.
  → `04-shared-state-races-and-synchronization.md`.
- **Manual memory management / explicit lifetimes** — `not yet exercised`. JS is
  GC'd. The interesting memory story is *retention* (the merged graph never
  evicts), not allocation.
- **Streaming I/O / backpressure on a stream** — `not yet exercised`. All I/O is
  request/response `fetch` with whole-body `await res.json()`. No streams, no
  `ReadableStream`, no chunked processing.
- **Graceful shutdown / signal handling** — `not yet exercised` in the app
  (the OS kills it). The build process exits via `process.exitCode = 1` on error
  (`run-build.ts:56`) — that's the extent of it.

## Reading order

1. `01-runtime-map.md` — the process/task/resource map as-built (start here).
2. `02-processes-threads-and-tasks.md` — where work runs; the `pump()` scheduler.
3. `03-event-loop-and-async-io.md` — the event loop, microtasks, and the
   blocking A* hazard.
4. `04-shared-state-races-and-synchronization.md` — the ref/state split and why
   there are no races (yet).
5. `05-memory-stack-heap-gc-and-lifetimes.md` — the no-eviction merged graph and
   the persistent elev cache.
6. `06-filesystem-streams-and-resource-lifecycle.md` — `graph.json`, AsyncStorage,
   timers as resources.
7. `07-backpressure-bounded-work-and-cancellation.md` — the bounded-work and
   no-cancellation story.
8. `08-runtime-systems-red-flags-audit.md` — ranked execution-model risks.

## Cross-links to sibling guides

- **Where requests cross boundaries** (Overpass, Open-Meteo, Nominatim) →
  `.aipe/study-networking/` and `.aipe/study-system-design/`.
- **The A\* algorithm itself** (heap, frontier, admissible heuristic) →
  `.aipe/study-dsa-foundations/`.
- **Frame budget, profiling, the cost of the synchronous A\*** →
  `.aipe/study-performance-engineering/`.
- **The static-artifact storage model** (`graph.json`, AsyncStorage as a KV
  store) → `.aipe/study-database-systems/`.
- **How runtime behavior is verified deterministically** (injected `fetch`,
  fixture providers) → `.aipe/study-testing/`.
