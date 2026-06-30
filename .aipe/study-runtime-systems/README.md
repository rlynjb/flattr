# Study — Runtime Systems (flattr)

The execution model inside flattr: processes, threads, tasks, the event loop, memory, I/O,
synchronization, bounded work, and cancellation. Every claim is grounded in `file:line`;
inferences are labeled; mechanisms the repo doesn't have are marked `not yet exercised` with
the trigger that would introduce them.

**The one-line verdict:** flattr is single-threaded JavaScript top to bottom — Node for the
build pipeline, Hermes for the app — joined by a static `graph.json`. The interesting runtime
behaviors stand out sharply against that clean map: a synchronous A\* on the render thread, a
hand-rolled single-flight `pump()`, serialized network I/O with backoff, a capped persistent
cache, and **no cancellation anywhere.**

## Reading order

```
  00-overview          ← start here: the map, ranked findings, not-yet-exercised list
   │
  01-runtime-map       the as-built process/thread/task/resource topology
   │
  02-processes-threads-and-tasks    two runtimes, one JS thread each
   │
  03-event-loop-and-async-io        scheduling, debounce timers, async I/O, the sync hazard
   │
  04-shared-state-races-and-synchronization   the single-flight "lock", why no real races
   │
  05-memory-stack-heap-gc-and-lifetimes        heap growth, A*'s stack, the capped cache
   │
  06-filesystem-streams-and-resource-lifecycle graph.json, AsyncStorage, no streams/fds
   │
  07-backpressure-bounded-work-and-cancellation  three throttles + the missing stop button
   │
  08-runtime-systems-red-flags-audit   ranked execution-model risks with evidence
```

## The files

| File | What it covers | Load-bearing anchor |
|------|----------------|---------------------|
| `00-overview.md` | Map, ranked findings, reading order, `not yet exercised` | — |
| `01-runtime-map.md` | Process/thread/task/resource topology | `run-build.ts`, `loadGraph.ts:7-11` |
| `02-processes-threads-and-tasks.md` | Two runtimes, one JS thread each | `MapScreen.tsx:151-162` |
| `03-event-loop-and-async-io.md` | Event loop, debounce, async I/O, backoff | `useTileGraph.ts:245-258`, `elevation.ts:108-119` |
| `04-shared-state-races-and-synchronization.md` | Single-flight `pump()`, the boolean "lock" | `useTileGraph.ts:166-227` |
| `05-memory-stack-heap-gc-and-lifetimes.md` | Heap lifetimes, A* stack, the 50k cache cap | `astar.ts:30-37`, `elevCache.ts:48-52` |
| `06-filesystem-streams-and-resource-lifecycle.md` | graph.json, AsyncStorage write-back cache | `elevCache.ts:17-57`, `run-build.ts:11-13` |
| `07-backpressure-bounded-work-and-cancellation.md` | Debounce + single-flight + coalesce; no cancel | `useTileGraph.ts:269-272`, grep: no `AbortController` |
| `08-runtime-systems-red-flags-audit.md` | Ranked risks by blast radius | all of the above |

## Top three findings

1. **A\* runs synchronously on the JS/render thread** (`MapScreen.tsx:151-162`,
   `astar.ts:48-77`). The one CPU task among the async ones — fine at city scale, the first
   thing to freeze the whole single thread if the graph grows.
2. **No cancellation anywhere** (grep: zero `AbortController`/`AbortSignal`). Superseded
   pan/route builds run to completion and commit their result — wasted fetch, latency, stale
   flicker. Bounded only because the 600ms debounce makes supersession rare.
3. **The single-flight `pump()` is a boolean, not a real lock** (`useTileGraph.ts:166-227`).
   Correct *only* because JS is single-threaded — it stops being atomic the day work moves
   off-thread. Coupled to finding #1: the fix for the freeze is the trigger for this.

## Sibling guides (cross-links)

This guide owns **how code executes inside one runtime**. Neighboring guides own adjacent
questions:

- `study-system-design` — *where* the build/run split and components live as architecture.
- `study-networking` — the Overpass/Open-Meteo/Nominatim calls as protocol behavior (DNS,
  TLS, retries, the 429/backoff).
- `study-testing` — how this runtime behavior is verified deterministically.
- `study-dsa-foundations` — the `PQueue`/`Map`/A\* structures the runtime allocates.
- `study-data-modeling` / `study-database-systems` — the `graph.json` artifact's schema and
  the AsyncStorage cache as a (degenerate) store.
- `study-performance-engineering` — measuring the A\* frame budget and cache hit rate.
- `study-debugging-observability` — surfacing the stale-flicker and freeze symptoms.

Other siblings in the family: `software-design`, `frontend-engineering`, `security`,
`distributed-systems`, `ai-engineering`, `prompt-engineering`, `agent-architecture` — flattr
has no LLM/agent surface, so those last three are largely `not yet exercised` for this repo.
