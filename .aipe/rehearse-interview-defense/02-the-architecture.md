# Chapter 2 — The architecture

Right after the pitch, someone hands you a marker and says "walk me through the
system." This is the chapter where you draw flattr at a whiteboard, in ninety
seconds, without backtracking. The goal isn't to show every module — it's to
show that you understand the *shape* of the system: where the work happens, what
crosses which boundary, and the one decision that defines the whole thing.

That decision is the build-time / runtime split. flattr has no backend not
because you ran out of time, but because the expensive work — turning streets +
elevation into a grade-annotated graph — happens *once*, at build time, and gets
frozen into a static file. Runtime just reads it. If you can draw that split and
explain why it's deliberate, you've answered most of this chapter before the
follow-ups even start.

---

## The chapter-opening diagram — the architecture, full page

This is the diagram you redraw at the whiteboard. Two halves joined by one
artifact (`graph.json`), with the runtime hot path having zero network in it.
Practice drawing it top to bottom until it's muscle memory.

```
  flattr architecture — build-time bakes, runtime reads

  ══════════════════ BUILD TIME (pipeline/, run once) ══════════════════

  ┌─ Provider layer (free APIs, build-time only) ─────────────────────┐
  │   Overpass API              Open-Meteo Elevation API              │
  │   (OSM street ways)         (Copernicus 90m DEM, free, no key)    │
  └──────────┬──────────────────────────┬──────────────────────────────┘
             │ hop 1: ways               │ hop 2: elevation per node
             ▼                           ▼
  ┌─ Pipeline layer (pure TS modules) ────────────────────────────────┐
  │  parseOsm → splitWays → sampleElevations → computeGrades          │
  │  osm.ts     split.ts     elevation.ts       grade.ts             │
  │                              │                                     │
  │                              ▼   buildGraph (build-graph.ts:12)    │
  │              Node{id,lat,lng,elevationM} + Edge{...gradePct...}    │
  │              + adjacency: nodeId → edgeIds  (graph.ts:22)          │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │ hop 3: serialize
                                  ▼
                    ┌────────────────────────────┐
                    │  graph.json  (STATIC SEAM)  │  1,621 nodes
                    │  bundled into the app       │  1,879 edges
                    └──────────────┬──────────────┘
                                  │ hop 4: bundle import
  ══════════════════ RUNTIME (mobile/, Expo + RN) ═════════════════════
                                  ▼
  ┌─ UI layer (React Native + MapLibre) ──────────────────────────────┐
  │  MapScreen.tsx — tap two points / type addresses / grade slider   │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │ hop 5: tapped coord
                                  ▼
  ┌─ Routing layer (the engine, pure TS, NO NETWORK) ─────────────────┐
  │  loadGraph()  →  nearestNode(coord)  →  directedAstar(g,s,e,max)  │
  │  loadGraph.ts    nearest.ts (O(N))      astar.ts:22 → search()    │
  │                                              │                     │
  │                                              ▼  hop 6: route line  │
  │                                       routeToGeoJSON → MapLibre    │
  └────────────────────────────────────────────────────────────────────┘
```

The single most important thing on that diagram is the box labeled STATIC SEAM.
Everything above it costs an API quota and runs once; everything below it is
free and runs on every tap.

---

## "Walk me through the system"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Walk me through the architecture / how does it work?"          │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Can you pick an altitude and hold it? Do you know what the      │
│   load-bearing boundary is — or do you list modules flatly?       │
│   Can you trace ONE request end to end without getting lost?      │
│   The "no backend" choice: deliberate, or did you just not get   │
│   around to it?                                                    │
└─────────────────────────────────────────────────────────────────┘
```

Here's the walkthrough, in your voice. Trace one tap, top to bottom.

> "The system splits in two: build time and runtime, joined by one static file.
>
> At build time — this is the `pipeline/` directory — I pull OSM street geometry
> from Overpass, split the long ways into short edges (`splitWays`), sample
> elevation for every node from Open-Meteo's free DEM (`sampleElevations`), then
> compute the signed grade of each edge from the elevation difference
> (`computeGrades`). `buildGraph` (build-graph.ts:12) stitches that into a
> `Graph` — nodes, edges, and an adjacency map from node id to incident edge ids
> — and serializes it to `graph.json`. That file is 1,621 nodes and 1,879 edges
> of Seattle. It's the only thing that crosses into the app.
>
> At runtime — the `mobile/` Expo app — `loadGraph()` just imports that JSON.
> When you tap two points on the map, I snap each tapped coordinate to the
> nearest graph node with `nearestNode` (nearest.ts), then call `directedAstar`
> (astar.ts:156). That's one A* search with the directional grade cost. It
> returns a path, I turn it into GeoJSON, MapLibre draws it colored by grade.
>
> The key thing: there's no server. Routing has no network in the hot path.
> The expensive work — elevation sampling, grade computation — happened once at
> build time and got frozen into the file. Runtime just reads and searches."

That's ~75 seconds. You held one altitude (modules, not lines), you named the
seam, and you traced one tap from screen to route line.

```
┃ "The expensive work happened once at build time and
┃  got frozen into a file. Runtime just reads and searches."
```

### The single axis to trace — where does the work happen?

If the interviewer wants you to go deeper, don't list more modules. Trace one
axis across the seam: **cost / lifecycle.** Same system, one question, the
answer flips at the seam.

```
  One question across the seam: "when does the work happen?"

  ┌─ build time ─────────────┐   seam    ┌─ runtime ────────────────┐
  │ elevation sampling       │ ═══╪═════► │ load JSON (cheap)         │
  │ grade computation        │  (flips)  │ nearestNode scan          │
  │ edge splitting           │           │ A* search                 │
  │ costs an API quota       │           │ costs nothing, no network │
  │ runs ONCE                │           │ runs on EVERY tap         │
  └──────────────────────────┘           └──────────────────────────┘
       expensive, rare                         cheap, frequent
```

That contrast *is* the architecture. The whole "no backend" decision falls out
of it: if the per-tap work is cheap and network-free, you don't need a server.

---

## Weak vs strong — the architecture walkthrough

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK WALKTHROUGH              │ STRONG WALKTHROUGH            │
├──────────────────────────────┼──────────────────────────────┤
│ "So there's a pipeline folder │ "It splits in two halves      │
│ with osm.ts, overpass.ts,     │ joined by graph.json. Build   │
│ elevation.ts, geocode.ts,     │ time bakes the grade-annotated │
│ split.ts, grade.ts,           │ graph from OSM + elevation;   │
│ build-graph.ts... and then    │ runtime loads it and routes   │
│ features/routing has graph.ts,│ on-device with no network. Let │
│ astar.ts, cost.ts, pqueue.ts, │ me trace one tap: snap to      │
│ nearest.ts, summary.ts, and   │ nearest node, run directedAstar,│
│ the mobile folder has the      │ draw the route. The seam is    │
│ Expo app with MapScreen..."    │ the static file — that's why   │
│                                │ there's no backend."           │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:                │ Why it works:                  │
│ A flat file tour. The         │ Picks the altitude (halves +   │
│ interviewer can't tell what's │ seam), names the load-bearing  │
│ load-bearing from what's      │ boundary, traces ONE request,  │
│ plumbing. No request traced.  │ and explains the "no backend"  │
│ No seam named. You sound like │ as a consequence of the shape. │
│ you're reading the directory. │ One coherent picture.          │
└──────────────────────────────┴──────────────────────────────┘
```

```
        ▸ Don't tour the directory. Name the seam,
          trace one request, and let the rest hang
          off the picture.
```

---

## Where they'll interrupt — and what to say

Architecture walkthroughs get interrupted constantly. Here's the tree.

```
  You're mid-walkthrough.
        │
        ├─► "Wait, why no backend? Isn't that a limitation?"
        │     "It's deliberate. The expensive work is build-time
        │      (elevation, grades). Per-tap work is a graph search
        │      over data already in memory — no network needed. A
        │      server would add latency and a failure surface for
        │      zero benefit at this scope. See Chapter 3."
        │
        ├─► "How does a tapped pixel become a graph node?"
        │     "nearestNode (nearest.ts) — linear scan over every
        │      node, haversine distance, keep the closest. It's
        │      O(N). At 1,621 nodes that's nothing; at 100x it's
        │      the first bottleneck — Chapter 4 covers the k-d
        │      tree fix."
        │
        ├─► "What's actually IN the graph file?"
        │     "Node{id,lat,lng,elevationM} and Edge{id, fromNode,
        │      toNode, geometry, lengthM, riseM, gradePct (signed),
        │      absGradePct} plus adjacency: nodeId → edgeIds.
        │      types.ts:1. Grade is signed from→to; that's what
        │      makes routing directional."
        │
        └─► "Where does the elevation come from?"
              "Open-Meteo's free elevation API — Copernicus 90m
               DEM, no key. Build-time only. It's coarse (90m
               smooths short steep pitches) which I'd upgrade to
               a paid provider behind the ElevationProvider
               interface. Chapter 3 + 7."
```

Every branch lands on a real file. That's the difference between sounding like
you built it and sounding like you read about it.

---

## When they push on the data layer — the "I don't know" box

The interviewer who's done backend work will probe the static-file choice as if
it were a database. Here's where you hold the line honestly.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "If this were a real product with live data       ║
║   updates, how would you handle graph versioning, partial     ║
║   updates, replication across regions, cache invalidation     ║
║   when a street closes?"                                       ║
║                                                               ║
║   That's distributed-data-systems territory — multi-region    ║
║   replication and cache invalidation under load. You have     ║
║   NOT built that.                                              ║
║                                                               ║
║   Say:                                                         ║
║   "Right now the graph is a single static artifact — there's  ║
║    no versioning or replication story, because there's no     ║
║    server to replicate from. If I had to make this a live     ║
║    product, the honest answer is I'd be designing something    ║
║    I haven't built: regional graph shards, an invalidation    ║
║    path when streets change, a build pipeline that            ║
║    re-bakes affected tiles. I can reason about the shape —     ║
║    re-bake-the-tile is the natural unit since I already       ║
║    build per-bbox at runtime (useTileGraph.ts) — but          ║
║    multi-region replication under load is not something I've   ║
║    shipped, so I'd flag that."                                 ║
║                                                               ║
║   What this signals: you connected the question to something  ║
║   real in your code (per-tile builds) AND drew the line at    ║
║   what you haven't done. Both are senior moves.               ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "I'd use a CDN and eventual consistency and..." strung      ║
║   together from blog posts. The follow-up ("what              ║
║   consistency model?") will expose it instantly.              ║
╚═══════════════════════════════════════════════════════════════╝
```

Deeper on the build/runtime boundary and state ownership →
`.aipe/study-system-design/`.

---

## What you'd change about the architecture

If I were rebuilding flattr today, I'd design the data-loading seam up front as
a real interface instead of letting it emerge. Right now `loadGraph()`
(loadGraph.ts:9) does a bare `graph as unknown as Graph` cast — it trusts the
file completely. The runtime tile-loading in `useTileGraph.ts` grew *around*
that static base rather than through a shared seam. If the static file and the
dynamic tiles both went through one `GraphSource` interface, the architecture
would be cleaner and the validation gap (Chapter 5) would have an obvious home.
The split is right; the seam between the two data sources should have been a
designed interface, not an emergent one.

---

## One-page summary — Chapter 2

**Core claim:** flattr is build-time-bakes / runtime-reads, joined by one static
file. Name that seam, trace one tap, and the "no backend" choice explains
itself.

**The walkthrough:** build time (Overpass + Open-Meteo → split → sample → grade
→ `buildGraph` → graph.json) | runtime (loadGraph → nearestNode → directedAstar
→ GeoJSON → MapLibre). No network in the routing hot path.

**Questions covered:**
- "Walk me through it" → two halves + seam + one traced tap (~75s).
- "Why no backend?" → expensive work is build-time; per-tap work is cheap and network-free.
- "Pixel → node?" → `nearestNode`, O(N) linear scan, fine at 1,621 nodes.
- "What's in the graph?" → Node/Edge schema, signed `gradePct`, adjacency map (types.ts:1).
- "Live data / replication?" → name the gap; connect to per-tile builds; don't fake distributed data.

**Pull quotes:**
- ┃ "The expensive work happened once at build time and got frozen into a file. Runtime just reads and searches."
- ▸ Don't tour the directory. Name the seam, trace one request.

**What you'd change:** Make the data-loading seam a real `GraphSource` interface up front, so the static base and the runtime tiles share one boundary (and one validation point) instead of one growing around the other.
