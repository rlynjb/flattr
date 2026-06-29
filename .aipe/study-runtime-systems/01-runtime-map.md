# Runtime Map — what runs where

**Industry name(s):** runtime / execution-environment topology · process &
resource map. **Type:** Language-agnostic (applied to this repo).

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. flattr is two processes
that never overlap in time, joined by one file. Everything in this guide hangs
off this map.

```
  Zoom out — the two runtimes and the resources each owns

  ┌─ Build-time runtime · Node 18+ via tsx ───────────────────┐
  │  process owns:                                            │
  │   • network sockets → Overpass, Open-Meteo               │
  │   • node:fs handle  → writes data/graph.json             │ ← ★ runtime A
  │   • the CPU for grade math (splitWays, computeGrades)    │
  │  scheduler: none — top-level await, sequential           │
  └───────────────────────────┬───────────────────────────────┘
                              │  graph.json (544 KB, static)
                              ▼
  ┌─ Run-time runtime · Hermes (RN) on the phone ─────────────┐
  │  one JS thread owns:                                      │ ← ★ runtime B
  │   • the React render loop + A* (same thread!)            │   we live here
  │   • the pump() single-flight work slot                  │     most of
  │   • timers (debounce, retry, persist)                   │     the guide
  │   • in-memory: baseGraph + merged graph + elevCache Map │
  │  native side (other threads, not JS): MapLibre, GPS     │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this file answers *one* question for every box above — **where does the
work execute and what does that box own?** Get this map straight and the next
seven files are just zooming into individual boxes. The trap to avoid: thinking
"no backend" means "no runtime concerns." It means the concerns all collapse
onto the two single threads above.

## Structure pass

**Layers.** Three nested levels: (1) the OS process boundary — two separate
processes, never co-resident; (2) within the run-time process, the JS thread vs
the native threads MapLibre and GPS run on; (3) within the JS thread, the React
render work vs the async I/O the `pump()` schedules.

**Axis traced — "who decides what runs next (control)?"** Hold that one question
across the layers and watch the answer flip:

```
  One axis — "who decides what runs next?" — down the layers

  ┌─ OS / process ─────────────────────────┐
  │  the user / OS  (launch app, run CLI)   │  → HUMAN decides
  └───────────────────┬─────────────────────┘
        ┌─────────────▼──────────────────────┐
        │  build-time pipeline (run-build.ts) │  → CODE decides
        │  fixed sequence, top-level await    │    (linear order)
        └─────────────┬──────────────────────┘
              ┌────────▼───────────────────────┐
              │  run-time event loop (Hermes)   │  → EVENTS decide
              │  pan / tap / timer fire → queue │    (callbacks)
              └────────┬───────────────────────┘
                ┌───────▼──────────────────────┐
                │  pump() work slot             │  → THE LOCK decides
                │  busyRef gates one build      │    (busy? defer)
                └───────────────────────────────┘
```

The control answer flips four times: human → linear code → event callbacks →
a boolean lock. Each flip is a seam.

**Seams — where the axis flips, and what crosses each:**
- `graph.json` (build → run) — the static artifact. Control flips from "linear
  pipeline" to "nothing; it's a file now." → `06-filesystem-streams-and-resource-lifecycle.md`.
- The JS-thread / native-thread boundary (`MapScreen.tsx` ↔ MapLibre/GPS) — the
  only real parallelism in the app, and it's outside the code you write.
- `onRegionDidChange` → debounce timer → `pump()` — event control becomes
  queued work. → `02-processes-threads-and-tasks.md`.

## How it works

### Move 1 — the mental model

You already know the shape: it's a **build step that emits an asset, plus a
client that consumes it** — the same shape as a webpack bundle feeding a browser,
or a compiled binary feeding a runtime. The build runs once, ahead of time, and
hands the client a frozen artifact. What's unusual here is that the *build code
also runs inside the client* (on-demand tile fetching reuses `buildGraph`), so
the two runtimes share more than just the file.

```
  Pattern — build-once artifact + client that can also build

           build time                 run time
        ┌──────────────┐           ┌──────────────┐
        │ run-build.ts │──graph────►│ loadGraph()  │
        │ (Node, once) │  .json     │ baseGraph    │
        └──────┬───────┘           └──────┬───────┘
               │                          │ pan/route
               │ both call                ▼
               │            ┌──────────────────────────┐
               └───────────►│ buildGraph() (shared)     │
                            │ runs in Node AND in Hermes│
                            └──────────────────────────┘
```

### Move 2 — walking the boxes

**Box 1 — the build-time process (Node via tsx).** This is `pipeline/run-build.ts`.
One `main()`, awaited top to bottom, then the process exits. There is no loop, no
server, no listener. Look at the entry point:

```ts
// pipeline/run-build.ts:40-57
async function main(): Promise<void> {
  const { provider, sampleOpts, maxSegM } = pickElevation(); // env → provider
  const osm = await fetchOverpass(BBOX);          // ① one network call, awaited
  const graph = await buildGraph("seattle-mvp", BBOX, osm, provider, ...);  // ② CPU + more network
  mkdirSync("data", { recursive: true });         // ③ fs handle
  writeGraph(graph, "data/graph.json");           // ④ write artifact, then return
}
main().catch((err) => { process.exitCode = 1; }); // ⑤ the only "shutdown" logic
```

Line by line: ① and ② are the only places this process touches the network — and
they're strictly sequential, no concurrency. ③–④ are the only filesystem work.
⑤ is the entire error/shutdown story: print and set a non-zero exit code. This
process owns network sockets and one file handle and nothing else.

**Box 2 — the run-time JS thread (Hermes).** This is where it gets interesting.
The phone runs one JS thread, and `MapScreen.tsx` puts *three different kinds of
work* on it: React rendering, the synchronous A* search, and the async
orchestration in `useTileGraph`. Here's the load-bearing surprise — A* is not
offloaded anywhere:

```ts
// mobile/src/MapScreen.tsx:151-162
const routed = useMemo(() => {
  if (!graph || !startId || !endId) return { fc: null, summary: null, found: true };
  const r = directedAstar(graph, startId, endId, userMax); // ← runs HERE, on the JS thread
  ...
}, [graph, startId, endId, userMax]);
```

`useMemo` runs during render. So `directedAstar` executes synchronously as part
of React's render pass, on the same thread that's about to paint the next frame.
The boundary condition: if the graph is large enough that A* takes longer than a
frame (~16 ms), the UI janks for the whole search. There's no yielding point
inside `search` (`astar.ts:48-76` is a tight `while` loop).

**Box 3 — the native threads.** MapLibre rendering and GPS (`expo-location`) run
on native threads the JS code never touches directly — it only sends them
messages (camera moves, GeoJSON sources) and receives callbacks
(`onRegionDidChange`, location fixes). This is the app's only true parallelism,
and it's provided by the platform, not written here.

```
  Layers-and-hops — run-time process, JS thread vs native threads

  ┌─ JS thread (Hermes) ────────────┐
  │  React render → A* → setState   │
  └───┬───────────────────────▲──────┘
      │ hop: camera/source cmd │ hop: onRegionDidChange / GPS fix
      ▼                        │     (callback marshalled to JS)
  ┌─ Native threads (platform) ─────┐
  │  MapLibre GL render · GPS       │  ← real parallelism, not your code
  └──────────────────────────────────┘
```

### Move 3 — the principle

"No backend" doesn't delete the runtime; it relocates every concern onto the
client's single thread. The map above is the thing to internalize: once you know
which of the four control-owners (human / linear code / events / the lock) is
driving a given piece of work, every later question — is it cancellable? does it
block the frame? can it race? — has an obvious answer.

## Primary diagram

The full machine, every box and hop labelled, is the Zoom-out diagram at the top
combined with the JS-vs-native layers-and-hops diagram in Move 2. Those two
together are the recap visual — return to them when any later file references "the
build runtime" or "the JS thread."

## Elaborate

This split is the classic **static-site-generator runtime model** (Gatsby, Hugo,
Next's SSG) applied to graph data instead of HTML: do the expensive,
network-bound work once at build time, ship a frozen artifact, keep the client
cheap. flattr's twist is that the client can *also* run the build pipeline for
regions the artifact doesn't cover — so `buildGraph` had to be written to run in
two runtimes, which is why it has no `node:fs` import (`build-graph.ts:2`). That
single constraint — "this module must bundle for Hermes" — shapes the whole
pipeline layer.

## Interview defense

**Q: This app has no backend and no database. So there are no runtime-systems
concerns, right?**

Wrong, and that's the interesting part. Removing the server doesn't remove the
work — it moves all of it onto one client thread. The map is two single-threaded
runtimes joined by a static file.

```
  no server ≠ no runtime — it concentrates the runtime

  server model:  client ──► [N server threads] ──► DB
  flattr model:  one JS thread does: render + A* + I/O orchestration
                 → the thread IS the bottleneck and the scheduler
```

Anchor: *"The most consequential runtime decision in flattr is that A* runs
synchronously in a `useMemo` on the render thread — `MapScreen.tsx:151`. No
backend means that search can't be offloaded to a server; it competes with the
next frame."*

**Q: The same `buildGraph` runs at build time and on the phone. How is that
possible across two runtimes?**

Because it was deliberately written runtime-agnostic — no `node:fs`, all I/O
injected through the `ElevationProvider` interface and an injectable `fetch`.
Node supplies real `fetch` and writes the file; Hermes supplies its `fetch` and
keeps the result in memory. Anchor: *"`build-graph.ts` line 2 is a comment
explaining exactly this — no `node:fs` so it bundles for the app."*

## See also

- `02-processes-threads-and-tasks.md` — zooms into Box 2's `pump()` scheduler.
- `03-event-loop-and-async-io.md` — the JS thread's event loop and the A* block.
- `06-filesystem-streams-and-resource-lifecycle.md` — the `graph.json` seam.
- `.aipe/study-system-design/` — the same boundaries from the where-do-components-live angle.
