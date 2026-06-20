# Chapter 2 — The architecture

When the interviewer says "walk me through the system," they hand you a marker. This is the chapter where you earn the rest of the interview, because a clean architecture walk tells them you understand your own code at the level of *boundaries*, not just files. The goal is to redraw flattr's diagram from a blank whiteboard, in about 90 seconds, and narrate the one request flow that matters: what happens from "I type a destination" to "a colored route appears."

The spine of flattr's architecture is one line: **build-time produces a static graph artifact; runtime reads it.** Almost everything interesting falls out of that split — why there's no backend, why it works offline, why "scaling" means something unusual here. Draw that split first. Everything else hangs off it.

```
  flattr ARCHITECTURE — draw this from memory, top to bottom

  ┌══ BUILD TIME — your laptop, run once (offline) ══════════════════┐
  ║                                                                  ║
  ║  Overpass API ──► osm.ts ──► split.ts ──► elevation.ts           ║
  ║  (OSM streets)   parse      densify to    (Open-Meteo, ~90m DEM) ║
  ║                             ~90m segs           │                ║
  ║                                                 ▼                ║
  ║                          grade.ts ──► build-graph.ts             ║
  ║                       (signed grade)   assemble + index          ║
  ║                                                 │                ║
  ║                                                 ▼                ║
  ║                                ┌──────────────────────────┐      ║
  ║                                │  graph.json (~1621 nodes) │      ║
  ║                                │  nodes · edges · adjacency │      ║
  ║                                └──────────────────────────┘      ║
  └════════════════════════════════════┬═════════════════════════════┘
                                        │ bundled into the APK/app
  ┌══ RUNTIME — on device ══════════════▼════════════════════════════┐
  ║  ┌─ UI LAYER (Expo RN + MapLibre) ──────────────────────────┐    ║
  ║  │  MapScreen.tsx — orchestrates everything                  │    ║
  ║  │   AddressBar (type→geocode)  GradeSlider (userMax)        │    ║
  ║  │   MapLibre layers (heatmap / route / markers)             │    ║
  ║  └───────────────┬───────────────────────┬──────────────────┘    ║
  ║                  │ start/end coords        │ pan/zoom bounds       ║
  ║  ┌─ DATA HOOK ───▼───────────────────────▼──────────────────┐    ║
  ║  │  useTileGraph — single-flight pump()                      │    ║
  ║  │   merges: base graph + route corridor + viewport tiles    │    ║
  ║  │   elevation cache ──► AsyncStorage (persists)             │    ║
  ║  └───────────────┬──────────────────────────────────────────┘    ║
  ║  ┌─ ENGINE (pure TS) ──▼─────────────────────────────────────┐   ║
  ║  │  nearest.ts → astar.ts search() → cost.ts penalty()        │   ║
  ║  │  pqueue.ts (heap) · graph.ts (directedGrade) · summary.ts  │   ║
  ║  └────────────────────────────────────────────────────────────┘  ║
  ║   NETWORK boundary: only for tiles beyond the bundled graph →     ║
  ║   re-runs the SAME pipeline on-device (Overpass + Open-Meteo)     ║
  └══════════════════════════════════════════════════════════════════┘
```

That diagram is the chapter. If you can reproduce it and talk through the two bands, you can survive any architecture question they throw.

## "Walk me through the architecture."

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Walk me through how this is put together."     │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you think in boundaries and data flow, or    │
│   just files? Can you name what crosses each      │
│   boundary and why? Senior signal is talking      │
│   about the SEAMS, not listing the modules.       │
└─────────────────────────────────────────────────┘

Draw the two bands, then narrate top-down:

> "It splits into build-time and runtime. At build time — on my machine, run once — I pull the street network from OpenStreetMap through Overpass, densify long segments down to about 90 meters so they match the elevation resolution, sample elevation from Open-Meteo, and compute a signed grade per edge. That assembles into `graph.json` — nodes, edges, and an adjacency index — which ships bundled in the app.
>
> At runtime there's no server. The UI layer is Expo/React Native with MapLibre. When you set a start and end, a hook called `useTileGraph` hands the engine a merged graph — the bundled base plus any tiles it's loaded — and the engine runs the search: snap the endpoints to the nearest nodes, run `search()`, summarize the path. The only time it touches the network at runtime is when you pan or route *beyond* the bundled area — then it re-runs that same pipeline on-device to fetch and build the missing tiles, and caches the elevation so it doesn't re-fetch."

The move that lands: you named **what crosses each boundary** — `graph.json` crosses build→runtime, coordinates cross UI→engine, a bbox crosses runtime→network. That's the seam-level thinking they're listening for.

┃ "Build-time produces a static artifact; runtime reads it." — the one sentence that explains why there's no backend.

## "Trace one request: I type a destination, what happens?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Take one user action and trace it end to end." │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you actually know the call path, or only the │
│   boxes? This is where vague architecture answers │
│   fall apart — they can't trace a real request.   │
└─────────────────────────────────────────────────┘

> "I type 'Belltown' into the To field. `AddressBar` debounces the keystrokes and calls the geocoder — Nominatim — which returns coordinates and a label. I pick a suggestion; that sets the destination coordinate in `MapScreen`. An effect fires: it asks `useTileGraph` to make sure the graph covers the corridor between my location and the destination, which kicks off a single-flight fetch of that bounding box if it's not already loaded. Once the merged graph is ready, the engine snaps both endpoints to the nearest graph node with `nearestNode`, runs `directedAstar` — A\* with the directional grade cost — and `summarizePath` produces the distance, the climb, and which segments are steep. MapLibre draws the path as a line colored by grade, and the summary card shows '2.1 km, +9 m climb.'"

That trace touches every layer in order: UI → geocode → state → data hook → engine → render. Walking it in order *is* the proof you understand it.

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "The frontend calls the backend API, which runs the routing algorithm and returns the path, and then it gets rendered on the map." | "There's no backend. `MapScreen` sets the destination, `useTileGraph` ensures the graph covers the corridor, the on-device engine snaps endpoints with `nearestNode` and runs `directedAstar`, `summarizePath` computes the climb, MapLibre draws it." |
| **Why it's weak:** it describes a *generic* client-server app — and worse, one that isn't yours. flattr has no backend. This answer proves you're reciting a template, not your system. | **Why it works:** it's specific to flattr's actual shape (on-device, no server), names real functions, and the order is the call path. No template could produce it. |

## Where they'll interrupt, and what to say

```
  THE LIKELY INTERRUPTS DURING THE WALK

  mid-walk interrupt
        │
        ├─► "Wait — no backend? Where does routing run?"
        │     "On the device. The engine is pure TypeScript with no
        │      framework deps; it runs in the JS runtime. The graph is
        │      bundled, so a route needs zero network."
        │
        ├─► "What happens off the edge of the bundled graph?"
        │     "useTileGraph re-runs the build pipeline on-device for
        │      that bbox — Overpass + Open-Meteo + grade — merges and
        │      stitches it into the graph. Same code as build time."
        │
        ├─► "How big is the graph? Does it fit on a phone?"
        │     "The bundled base is ~1621 nodes — tiny, kilobytes of
        │      JSON. It's a neighborhood, not a city. That's a scope
        │      choice; Chapter 4 is the scaling story."
        │
        └─► "Why does the search run on the render thread?"
              "It runs inside a useMemo. For this graph size it's
               single-digit milliseconds. Debounced so it can't fire
               on every keystroke. At city scale I'd move it off-thread."
```

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They ask how the React Native bridge / Hermes   ║
║   runtime actually executes your engine, or about  ║
║   MapLibre's internal render pipeline. You use     ║
║   these but you didn't build them, and you         ║
║   haven't gone deep on the runtime internals.     ║
║                                                   ║
║   Say:                                            ║
║   "I treat the engine as plain TypeScript running  ║
║    in the JS runtime — I haven't profiled how      ║
║    Hermes executes it specifically. What I do      ║
║    know is the work is small and debounced, so it  ║
║    hasn't been the bottleneck. If it became one I'd ║
║    measure first, then move it to a worker."       ║
║                                                   ║
║   What this signals: you know the boundary of      ║
║   your knowledge and you reach for measurement,    ║
║   not a guess.                                     ║
║                                                   ║
║   Do NOT say:                                      ║
║   "Hermes JITs it so it's basically native         ║
║    speed…" — Hermes doesn't JIT by default, and a  ║
║    confident wrong claim about a runtime you        ║
║    didn't study is exactly what sinks senior        ║
║    interviews.                                     ║
╚═══════════════════════════════════════════════════╝

▸ "There's no backend" is not an apology. It's a design consequence of the build/runtime split — say it like the deliberate choice it was.

## What you'd change

The architecture I'd reconsider is where the search runs. Today it executes synchronously inside a `useMemo` on the JS thread, and it's fine — the graph is small and the work is milliseconds. But it's fine *because the graph is small*, and that's a coupling I'd rather not have baked into the UI layer. If I were starting over I'd put the engine behind an explicit async boundary from day one — a worker, or at least a clearly-cancelable async call — so that growing the graph later doesn't mean refactoring the render path under pressure. The current design trades future flexibility for present simplicity, and at MVP size that's the right trade — but it's the first thing I'd revisit before scaling the graph.

## One-page summary

**Core claim:** The architecture is one idea — build-time produces a static graph artifact, runtime reads it — and everything (no backend, offline, on-device search) falls out of that split. Draw the two bands; name what crosses each boundary.

- **"Walk me through it":** build-time pipeline → `graph.json` (bundled) → runtime UI/hook/engine, no server; network only for tiles beyond the base, which re-run the same pipeline on-device.
- **"Trace one request":** AddressBar debounce → geocode → MapScreen state → useTileGraph ensures coverage → nearestNode → directedAstar → summarizePath → MapLibre draws.
- **"No backend?":** correct, and deliberate — the graph is a read-only artifact; routing is pure on-device TS.
- **Where they interrupt:** off-graph tiles (re-run pipeline), graph size (~1621 nodes, a neighborhood), search-on-render-thread (small + debounced; move off-thread at scale).

┃ "Build-time produces a static artifact; runtime reads it."
┃ Name what crosses each boundary: graph.json (build→run), coords (UI→engine), a bbox (run→network).

**What you'd change:** Put the engine behind an explicit async/worker boundary from the start, so growing the graph doesn't force a render-path refactor.
