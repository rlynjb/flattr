# Runtime Map — the as-built execution model

**Industry name:** runtime / process / resource topology — *Project-specific*.

## Zoom out, then zoom in

Before any mechanism, here's the whole machine. flattr isn't one program — it's two,
joined by a file. One runs on your laptop at build time and dies. The other runs on a
phone and lives for the session. Neither uses a thread you didn't already have.

```
  Zoom out — the two runtimes and the seam between them

  ┌─ BUILD-TIME runtime ── Node (via tsx) ───────────────────────┐
  │  pipeline/run-build.ts  — one process, runs once, exits      │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ writes
                  ┌─ ARTIFACT SEAM ▼──────────────┐
                  │ mobile/assets/graph.json      │ ★ THIS FILE'S SUBJECT:
                  │   static, read-only JSON       │   the whole map, including
                  └───────────────┬───────────────┘   this seam
                                  │ bundled + loaded once
  ┌─ RUN-TIME runtime ── Hermes JS thread (RN) ───▼──────────────┐
  │  mobile/src/MapScreen.tsx  — event loop, lives for session   │ ← we are here
  │    + on-device tile builds, A* on the JS thread              │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: this file is the **map itself** — the inventory. What processes exist, what
threads each owns (spoiler: one each), what tasks run on them, and what resources
(memory, files, network sockets) they hold. The other seven files zoom into one region
of this map. Read this one to know where everything sits before you walk any mechanism.

## Structure pass — layers, one axis, the seams

**The layers.** Three nested altitudes:

```
  Three altitudes of "where does work run?"

  ┌─ outer: PROCESS ─────────────────────────────┐
  │  Node pipeline process │ Hermes app process   │  → two separate OS processes,
  └───────────────────────────────────────────────┘    never co-resident
      ┌─ middle: THREAD ─────────────────────────┐
      │  one JS thread per process               │  → no worker threads at all
      └───────────────────────────────────────────┘
          ┌─ inner: TASK ────────────────────────┐
          │  async functions, timers, useMemos   │  → cooperatively scheduled
          └───────────────────────────────────────┘   on the one thread
```

**The axis to trace: "who owns the thread of control?"** Hold that question constant
and walk down:

- **Process layer** → the OS owns it. Two processes, scheduled independently, sharing
  nothing but the `graph.json` file. The pipeline can't see the app's memory; the app
  can't see the pipeline's. The artifact is the *only* channel between them.
- **Thread layer** → each process owns exactly one JS thread. No second thread to hand
  work to. Hermes has native threads underneath (GC, MapLibre rendering) but *your* code
  never runs on them.
- **Task layer** → the **event loop** owns control. Async functions yield at every
  `await`; the loop picks the next ready task. No task can preempt another mid-statement —
  that's the property everything else in flattr leans on (see `04`).

**The seams — where the axis-answer flips:**

```
  Two load-bearing seams in the runtime map

  seam 1: the ARTIFACT (build ═╪═► run)
    control flips: Node code STOPS, phone code STARTS
    nothing shared but a JSON file — strongest isolation in the system

  seam 2: JS thread ═╪═► native side (MapLibre / AsyncStorage)
    control flips: your synchronous code STOPS at an await,
    native does the I/O, resolves a promise back onto the JS thread
```

Seam 1 is why a build-time bug can't corrupt runtime memory and vice versa. Seam 2 is the
*only* place flattr touches concurrency — and it's the cooperative, single-threaded kind.
Hand off to How it works.

## How it works

### Move 1 — the mental model

You already know this shape from any frontend app you've shipped: a build step
(`vite build`, `next build`) produces a static bundle, then a runtime loads it. flattr is
that, with the bundle being a *graph* instead of HTML/JS. The strategy: **precompute the
expensive thing at build time, ship it as data, do only cheap reads at runtime** — except
flattr cheats a little and *also* builds more graph on-device when you pan past the bundled
area.

```
  The runtime-map kernel: precompute → ship → read (+ patch)

   build time          artifact            run time
   ──────────          ────────            ────────
   [OSM + DEM] ──────► graph.json ───────► [base graph]
   heavy, once         static, bundled     │
                                           ├─ pan past edge?
                                           │    fetch + build MORE on device
                                           │    (pump → buildGraph)
                                           └─ route? A* over merged graph (sync)
```

### Move 2 — walking the map, one region at a time

**The build-time process.** One Node process, launched by `tsx pipeline/run-build.ts`
(`package.json` script `build:graph`). It runs `main()` top to bottom and exits.

```
  Build-time process — strictly sequential, single thread

  main()  pipeline/run-build.ts:40-52
    pickElevation()           ← choose provider from env vars
    fetchOverpass(BBOX)       ── await (network) ──►  Overpass API
    buildGraph(...)           ── await ──► parse → split → sampleElevations → grades
    writeGraph(graph, path)   ── sync fs write ──►  data/graph.json
    exit
```

The whole thing is `await`-chained. There's no parallelism because there's no reason for
it: the elevation API is rate-limited, so serializing requests *is* the design (see `03`).
Code anchor — the exit path is bare:

```ts
// pipeline/run-build.ts:54-57 — no graceful shutdown, just a process exit
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;   // ← set exit code; in-flight nothing to clean up
});
```

What breaks if you remove the `.catch`? An unhandled rejection crashes the process with a
non-zero code anyway — but you'd lose the clean error log. There are no open handles to
leak because every resource (network socket) is owned by an `await` that has already
resolved by the time `main()` returns.

**The artifact seam.** `mobile/assets/graph.json` is the entire contract between the two
runtimes. The app reads it exactly once:

```ts
// mobile/src/loadGraph.ts:9-11 — a single synchronous cast, no parsing logic
export function loadGraph(): Graph {
  return graph as unknown as Graph;   // ← bundled JSON, already parsed by the bundler
}
```

This is load-bearing: because the import is static, Metro inlines the JSON into the bundle
at build time. There's no runtime file read, no async, no failure path beyond the
try/catch in `MapScreen.tsx:28-34`. The graph is just *there* in memory the moment the
component mounts.

**The run-time process.** One Hermes JS thread runs the React tree. Three kinds of task
live on it, and this map is the place to name all three before later files go deep:

```
  Run-time tasks on the single JS thread

  ┌─ Region tasks ───────────────────────────────────────────┐
  │  onRegionDidChange → debounce 600ms → queueViewport       │  useTileGraph.ts:245
  │  → pump(): fetchOverpass + buildGraph (async, 1-at-a-time)│
  └───────────────────────────────────────────────────────────┘
  ┌─ Route tasks ────────────────────────────────────────────┐
  │  ensureBbox → pump() (corridor, priority over view)       │  useTileGraph.ts:269
  │  directedAstar in useMemo (SYNCHRONOUS, blocks the thread)│  MapScreen.tsx:155
  └───────────────────────────────────────────────────────────┘
  ┌─ Geocode tasks ──────────────────────────────────────────┐
  │  scheduleSuggest → debounce 400ms → geocodeSuggest (async)│  MapScreen.tsx:73
  └───────────────────────────────────────────────────────────┘
```

The one that doesn't belong with the others is `directedAstar` — it's **synchronous**
while everything around it is async. That asymmetry is the whole story of file `03` and
`05`; this map just plants the flag.

**The resources each runtime holds.** Trace the resource axis across the map:

| Resource | Build-time process | Run-time process |
|----------|-------------------|------------------|
| Memory | OSM + graph, freed on exit | base graph + merged tiles, **never evicted** (`05`) |
| Files | reads none, writes `graph.json` | reads bundled graph; writes AsyncStorage (`06`) |
| Network | Overpass + elevation, then done | Overpass, Open-Meteo, Nominatim, on demand (`03`) |
| Threads | 1 JS thread | 1 JS thread + native (GC, MapLibre) you don't control |

### Move 3 — the principle

A runtime map is the first thing to draw for *any* system, before you reason about a
single mechanism: **name the processes, then the threads each owns, then the tasks on each
thread, then the resources each holds.** flattr's map is unusually clean — two
single-threaded processes joined by one read-only file — which is exactly why the few
interesting runtime behaviors (sync A\*, the single-flight pump, no cancellation) stand out
so sharply against it. A messy map hides its hot spots; a clean one spotlights them.

## Primary diagram

The full map, every layer and seam labeled — the frame to return to.

```
  flattr runtime map — processes, threads, tasks, resources, seams

  ┌─ PROCESS: Node (tsx) ─ THREAD: 1 JS ─────────────────────────┐
  │  TASKS (sequential await chain):                             │
  │    fetchOverpass → buildGraph → writeGraph → exit            │
  │  RESOURCES: transient OSM/graph mem; network; fs write       │
  └──────────────────────────────┬───────────────────────────────┘
                  seam 1: ARTIFACT │ graph.json (read-only, isolating)
  ┌─ PROCESS: Hermes (RN) ─ THREAD: 1 JS ─────────▼──────────────┐
  │  TASKS on the event loop:                                    │
  │    region (debounce→pump)  route (ensureBbox→pump; A* sync)  │
  │    geocode (debounce→fetch)                                  │
  │  RESOURCES: base graph + merged tiles (never evicted);       │
  │             network (Overpass/Open-Meteo/Nominatim);         │
  │             AsyncStorage (elevCache)                         │
  └──────────────────────────────┬───────────────────────────────┘
                  seam 2: JS ═╪═► NATIVE │ MapLibre render · AsyncStorage I/O
```

## Elaborate

The two-runtime-joined-by-an-artifact shape is the classic **static site generator**
pattern (Jekyll, Next.js SSG, Astro) applied to graph data instead of HTML. The insight
it buys is the same: push expensive work to a moment when latency doesn't matter (build),
so the latency-sensitive moment (a user routing) only does cheap work. flattr stretches it
by also building on-device — which is where the runtime gets interesting, because now the
"cheap runtime" is doing pipeline work too (see `02` and `07`). For the artifact's shape
and schema, see `study-data-modeling`; for why the build/run split is also a *system*
boundary, see `study-system-design`.

## Interview defense

**Q: "Walk me through the runtime topology of this app."**

Two single-threaded processes joined by a read-only artifact. Build-time Node pipeline
produces `graph.json`; the Hermes app loads it once and routes over it, building more graph
on-device when you pan past the bundled area. No backend, no DB, no second thread.

```
  Node pipeline ──writes──► graph.json ──loaded once──► Hermes app
   (sequential)              (static)                    (event loop + sync A*)
```

*Anchor:* "The artifact seam is the strongest isolation in the system — the two runtimes
share nothing but a JSON file."

**Q: "Where's the one thing that doesn't fit the pattern?"**

A\* runs synchronously on the JS thread (`MapScreen.tsx:155`) while everything around it is
async. It's the only CPU-bound task on the render thread.

*Anchor:* "Everything is async except the search — that asymmetry is where frame drops
would come from if the graph grew."

## See also

- `02-processes-threads-and-tasks.md` — the threads this map names, walked in depth.
- `03-event-loop-and-async-io.md` — how the tasks on the JS thread are scheduled.
- `05-memory-stack-heap-gc-and-lifetimes.md` — the "never evicted" resource line.
- `study-system-design` (sibling guide) — the same boundary as an architectural seam.
