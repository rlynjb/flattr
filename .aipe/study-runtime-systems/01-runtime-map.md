# Runtime map

*The as-built process, task, and resource map.*
**Type:** Project-specific.

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. flattr runs in
**two completely separate runtimes** that never run at the same time and
never share memory. One is a Node process you invoke from a terminal
(`tsx pipeline/run-build.ts`); it talks to the internet, crunches OSM
data, and writes a file to disk. The other is the JavaScript engine
embedded in a phone app (Hermes, under React Native); it reads that file
and runs searches on it. The file — `data/graph.json`, copied to
`mobile/assets/graph.json` — is the *only* thing that crosses between
them.

```
  Zoom out — the two runtimes and the artifact between them

  ┌─ BUILD runtime: Node + tsx ──────────────────────────────┐
  │  process: `npm run build:graph`                           │
  │  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐   │
  │  │ Overpass   │  │ Open-Meteo   │  │ CPU: parse/split/ │   │
  │  │ fetch (I/O)│→ │ fetch (I/O)  │→ │ grade/adjacency   │   │
  │  └────────────┘  └──────────────┘  └────────┬─────────┘   │
  │                              writeFileSync   ▼            │
  │                              ★ THIS FILE ★  graph.json    │ ← we map both
  └──────────────────────────────────┬───────────────────────┘
                                      │  bundled into the app
  ┌─ RUN runtime: Hermes (RN) ───────▼───────────────────────┐
  │  process: the phone app                                  │
  │  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐   │
  │  │ loadGraph  │  │ useTileGraph │  │ directedAstar    │   │
  │  │ (JSON read)│  │ (more I/O)   │  │ (sync CPU)       │   │
  │  └────────────┘  └──────────────┘  └──────────────────┘   │
  │  one JS thread (Hermes) + native UI/render thread        │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this file is the **map**, not a mechanism. Its job is to name
every runtime resource flattr owns — processes, threads, the event loop,
heap memory, the one file on disk, the network sockets — and say which
runtime owns each. Every later concept file zooms into one box on this
map. Read this one to know where the boxes are.

## Structure pass

**Layers.** Three nested levels, outer to inner:

```
  Layered decomposition — "who owns the work?" held constant

  ┌───────────────────────────────────────────────┐
  │ outer: the OS process (Node OR the app)        │  → the OS owns it
  └───────────────────────────────────────────────┘
      ┌─────────────────────────────────────────┐
      │ middle: the JS event loop in that process│  → the runtime owns it
      └─────────────────────────────────────────┘
          ┌─────────────────────────────────────┐
          │ inner: one synchronous call (astar)  │  → the call stack owns it
          └─────────────────────────────────────┘

  the answer to "who owns the work" flips at each layer —
  that flip is the lesson
```

**Axis — lifecycle.** Trace one question across the map: *when does this
run?* The build pipeline runs **at build time**, on your machine, once,
manually. The artifact exists **at rest** as a file. The mobile runtime
runs **per interaction** — a pan, a tap, a search. Three lifecycle
phases, and the seam between them is the file.

**Seams.** Two load-bearing boundaries:
- **build ↔ artifact** (`writeFileSync` in `run-build.ts:11-13`): async,
  network-bound work on one side; an inert blob on the other. The
  lifecycle axis flips from "running" to "at rest."
- **artifact ↔ run** (`loadGraph.ts:9-11`): the blob becomes live heap
  objects, and from here on every touch is on the phone's JS thread.

## How it works

### Move 1 — the mental model

You already know the shape: it's **compile-time vs runtime**, the same
split as a webpack bundle. There's a step you run once that produces an
artifact, and a step that runs the artifact many times. The compiler
doesn't run in the browser; the bundle does. Here, the "compiler" is the
OSM-to-graph pipeline and the "bundle" is `graph.json`.

```
  Pattern — build-once / run-many, split by an artifact

   build runtime          artifact            run runtime
   ─────────────          ────────            ───────────
   fetch + crunch  ──────► graph.json ──────► load + search
   (runs once,             (inert,            (runs per
    manual, online)         ~544 KB)           interaction)

   no shared memory across the arrow — only bytes
```

### Move 2 — walk the resources

**The processes.** There are two, never alive together. The build process
is `tsx pipeline/run-build.ts` — `tsx` is a thin Node wrapper that runs
TypeScript directly. It exits when `main()` resolves. The run process is
the React Native app, a long-lived process the OS manages. Neither forks,
spawns, or pools children. (Detail: `02-`.)

**The threads.** One JS thread per process. Node gives `run-build.ts` a
single main thread plus libuv's hidden I/O threadpool for `fetch`/disk —
but flattr never touches that pool directly. Hermes gives the app one JS
thread; MapLibre's native rendering runs on a separate native thread the
app code never sees. No `worker_threads`, no RN worklets in this code.
(Detail: `02-`.)

**The event loop.** Each process has one. In the build it's mostly idle —
it parks on `await fetch(...)` and the `setTimeout` backoff sleeps. In the
app it's busy: every React render, every `setState`, every fetch
continuation is a task on it. (Detail: `03-`.)

```
  Layers-and-hops — one interaction crossing the run-time layers

  ┌─ UI (native) ─┐ hop1: pan gesture       ┌─ JS thread (Hermes) ─┐
  │  MapLibre     │ ──────────────────────► │  onRegionDidChange    │
  └───────────────┘                         └──────────┬────────────┘
        ▲                                     hop2: debounce 600ms
        │ hop5: new GeoJSON                              │ setTimeout
        │ (re-render)                                    ▼
        │                                    ┌─ JS thread ──────────┐
        │                                    │  pump() → fetch (I/O) │
        │                                    └──────────┬────────────┘
        │                              hop3: await network (off-thread)
        │                                               ▼
        │                                    ┌─ JS thread ──────────┐
        └──────────────────────────────────  │  buildGraph (sync CPU)│
                                    hop4: state update + render
                                             └───────────────────────┘
```

**The memory.** All JS heap. The graph is `Record<string, Node>` +
`Edge[]` + adjacency `Record` — parsed from JSON once, then mutated only
by merging in new tiles. No off-heap buffers, no memory-mapped files.
(Detail: `05-`.)

**The one file.** `data/graph.json`, written by `writeFileSync`, copied
into the app bundle as `mobile/assets/graph.json`. That's the entire
filesystem story — one write at build, one bundler-import read at run.
(Detail: `06-`.)

**The sockets.** Outbound HTTP only: Overpass, Open-Meteo, Nominatim. No
server, no listening socket, no inbound connections. flattr is a pure
client. (Protocol detail:
[`.aipe/study-networking/`](../study-networking/).)

### Move 3 — the principle

The cleanest runtime model is the one where the expensive, failure-prone
work (network, heavy CPU) happens **once, offline, in a process you can
restart** — and the live path only reads a finished artifact. flattr
mostly honors that. The interesting tension (and the audit's subject) is
that the *mobile* runtime quietly re-runs the build pipeline live in
`useTileGraph`, dragging network and CPU back onto the interactive
thread.

## Primary diagram

The full map — every runtime resource, which runtime owns it, and the one
seam between them.

```
  flattr runtime map — resources by owner

  BUILD PROCESS (Node, tsx)            │  RUN PROCESS (Hermes, RN)
  ─────────────────────────            │  ────────────────────────
  threads:  1 JS + libuv pool          │  threads: 1 JS + 1 native UI
  loop:     mostly parked on await     │  loop:    busy (render+I/O)
  I/O:      Overpass, Open-Meteo (out) │  I/O:     same + Nominatim (out)
  CPU:      parse/split/grade/adj      │  CPU:     astar, nearestNode,
                                       │           geojson (all sync)
  disk:     writeFileSync ──┐          │  disk:    import graph.json (read)
  memory:   transient heap  │          │  memory:  graph held in heap,
                            │          │           tiles accumulate
                            ▼          │
                    ┌──────────────┐   │
                    │ graph.json   │───┼──► loadGraph() → live objects
                    │ ~544 KB      │   │
                    └──────────────┘   │
                    the ONLY shared    │
                    state — bytes,     │
                    not memory         │
```

## Implementation in codebase

**Use cases.** You reach for this map whenever you ask "where does *this*
run?" — debugging a frozen screen (run process, JS thread, `02-`/`07-`),
a slow build (build process, sequential I/O, `03-`), or growing memory
(run process heap, `05-`).

The build entrypoint wires the whole build process in one function:

```
  pipeline/run-build.ts  (lines 40-52)

  async function main(): Promise<void> {
    const { provider, sampleOpts, maxSegM } = pickElevation();  ← choose I/O source
    const osm = await fetchOverpass(BBOX);          ← network hop 1 (blocking await)
    const graph = await buildGraph(..., provider, ...); ← network hop 2 + all CPU
    mkdirSync("data", { recursive: true });          ← the only dir create
    writeGraph(graph, "data/graph.json");            ← the only disk write
  }
        │
        └─ this single async function IS the build process's whole lifetime;
           when its promise resolves, the event loop empties and Node exits
```

The run-process entry to the graph is one import and one cast:

```
  mobile/src/loadGraph.ts  (lines 7-11)

  import graph from "../assets/graph.json";   ← bundler inlines the 544KB blob
  export function loadGraph(): Graph {
    return graph as unknown as Graph;          ← no parse call: the bundler
  }                                            ║   already turned JSON into a
                                               ║   live JS object at build time
        └─ this is the artifact→run seam: bytes become heap objects here,
           and from this line on, every touch is on the phone's JS thread
```

## Elaborate

This build-once/run-many split is the oldest runtime pattern there is —
it's the C compiler and the executable, the asset pipeline and the CDN,
the database migration and the running query. The reason it keeps winning
is **failure isolation by lifecycle**: anything that can fail slowly or
flakily (the network, a 90m DEM lookup, a rate limit) is pushed to a
phase you can retry by hand, leaving the live path deterministic. The
spec's choice to ship a prebuilt static `graph.json` rather than a live
backend (context.md, "No live backend / DB") *is* this principle applied.

What to read next: `02-` zooms into the single-thread story, `03-` into
the event loop that drives both processes.

## Interview defense

**Q: "Walk me through the runtime topology of this system."**

Two processes, never concurrent, one artifact between them. Build process
is Node-via-tsx: sequential network I/O then synchronous CPU, writes one
JSON file, exits. Run process is the RN app on Hermes: reads that file
into the heap, runs synchronous searches on the JS thread. The file is
the only shared state — bytes, not memory, so there's no cross-process
synchronization to reason about.

```
  build proc ──► graph.json ──► run proc
   (online,       (inert)        (interactive,
    transient)                    single JS thread)
```

Anchor: *"The only thing that crosses the process boundary is ~544 KB of
JSON — so the two runtimes share zero mutable state."*

**Q: "Where would a performance problem most likely live, given this
map?"**

The run process, JS thread, during `directedAstar` — because it's
synchronous CPU on the same thread that paints. The build process can be
slow without anyone caring; it's offline. The map tells you where to
look before you profile.

```
  build slow?  → nobody waiting, offline
  run slow?    → UI freezes — JS thread is shared  ← look here
```

Anchor: *"Lifecycle is the axis — build-time slowness is free, run-time
slowness is a frozen frame."*

## Validate

**Reconstruct.** Draw the two-process map from memory: name each
process's runtime, its threads, its I/O, and the one artifact between
them. Check against the Primary diagram.

**Explain.** Why does flattr have *no* cross-process synchronization?
(Because the processes never run together and share only an inert file —
`run-build.ts:11-13` writes, `loadGraph.ts:7` reads, never concurrently.)

**Apply.** A teammate wants the build pipeline to run *inside* the app on
first launch instead of shipping `graph.json`. Which seam does that erase,
and what runtime property do you lose? (Erases the build↔artifact seam;
you lose offline determinism and drag network failure onto the
interactive process — exactly what `useTileGraph` already does for tiles,
`useTileGraph.ts:106-128`.)

**Defend.** Argue for keeping the prebuilt artifact over a live build.
(Lifecycle isolation: `run-build.ts` can fail and be re-run by hand;
the live path stays deterministic. Cite context.md "No live backend.")

## See also

- `02-processes-threads-and-tasks.md` — the single-thread story
- `03-event-loop-and-async-io.md` — the loop driving both processes
- `06-filesystem-streams-and-resource-lifecycle.md` — the one file
- [`.aipe/study-system-design/`](../study-system-design/) — boundaries view
