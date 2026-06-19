# 01 — Build-Time vs Runtime Split

*Industry names: precompute / serve split · offline batch pipeline → static
artifact · "bake then read." Type: Industry standard.*

---

## Zoom out, then zoom in

You already know this shape from the frontend world: a static site generator
runs at build time, hits your CMS, and emits HTML the CDN just serves. Nobody
queries the CMS on every request. flattr is the same move applied to a routing
graph — do the expensive graph construction once, offline, and ship a static
file the app only reads.

Here's where the split sits in the whole system. The seam is the artifact in the
middle; everything above it is "compute the graph," everything below is "use the
graph."

```
  Zoom out — the build/runtime seam in the whole system

  ┌─ BUILD TIME · offline `tsx` · run rarely ────────────────────┐
  │  Overpass → osm → split → elevation → grade → adjacency       │
  │  pipeline/run-build.ts  ──writes──►  data/graph.json          │
  └───────────────────────────────┬───────────────────────────────┘
                                   │
                  ★ THE SEAM ★  graph.json (the Graph type)
                  the entire contract between the two phases
                                   │
  ┌─ RUN TIME · Expo RN · on the phone ─▼────────────────────────┐
  │  loadGraph → useTileGraph → MapScreen → directedAstar         │
  │  reads the artifact · runs A* locally · no backend            │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **precompute-then-serve**. The question it answers is
*"where does the expensive work live, and what crosses the boundary between
where it's produced and where it's consumed?"* For flattr the answer is: the
work lives offline, and exactly one thing crosses — a `Graph` object serialized
to JSON. No DB, no server, no per-request compute. That single artifact *is* the
API between the two halves of the system.

---

## Structure pass

**Layers.** Three, stacked by lifecycle:

```
  outer:  BUILD TIME   — pipeline/* run by `npm run build:graph`
  seam:   THE ARTIFACT — data/graph.json → mobile/assets/graph.json
  inner:  RUN TIME     — mobile/src/* + features/routing/* on-device
```

**Axis — lifecycle (when does this run?).** Hold that one question across the
layers and watch the answer flip:

| Layer | When does it run? | How often? |
|---|---|---|
| Build time | offline, developer machine | rarely (per data change) |
| The artifact | never runs — it's data | written once, read forever |
| Run time | every app session | constantly, on the phone |

That flip — *rarely, offline* above the seam vs *constantly, on-device* below
it — is the whole value of the pattern. Expensive work moves to the cheap
(rare, offline) side; the hot (per-session) side does as little as possible.

**Seams.** The load-bearing one is the artifact. An axis flips across it:
*control* (the pipeline DAG decides everything above; the user/React decides
below), *state* (immutable data on the seam itself), and *cost* (heavy compute
above, light read below). That's three axes flipping at one boundary — textbook
load-bearing seam, and it's why the `Graph` type is worth studying before either
side's internals.

**The twist this guide exists to surface:** as *built*, the inner layer reaches
back up and runs the outer layer's pipeline on the phone. The seam isn't as
clean as the diagram. Hold that thought — Move 2.5 below, and
`03-on-device-pipeline.md` in full.

---

## How it works

### Move 1 — the mental model

The shape is a one-way data pipeline that terminates in a frozen artifact, which
a separate consumer then reads. Think of it like compiling: source code
(OSM + elevation) goes through stages (parse → split → sample → grade) and out
the other end comes a binary (`graph.json`) that the runtime loads and executes
against. You don't recompile to run the program; you don't rebuild the graph to
route on it.

```
  Pattern — bake then read

   raw inputs        stages (run once)            artifact      consumer
   ──────────        ─────────────────            ────────      ────────
   OSM streets ─┐
                ├──► parse → split → sample ──►  graph.json ──► A* router
   elevation  ──┘    → grade → adjacency         (frozen)       (reads only)

        heavy, offline, rare              │        the seam      light, hot,
        ─────────────────────────────────►│◄──────────────────  per-session
                                     one-way: data never flows back up
```

The defining property: **the arrow is one-way.** The runtime never writes back
to the artifact. That's what kills the need for a database — there's no mutable
shared state to coordinate, just a read-only file.

### Move 2 — the walkthrough

#### The build stage DAG (above the seam)

This is the "compiler." You know how a build tool chains transforms — lint →
transpile → bundle? Same here, except each stage enriches a graph. Each stage's
output is the next stage's input; the order is fixed and the code reads as a
linear DAG.

```
  Pattern — the build DAG (each stage enriches the graph)

  parseOsm        splitWays         sampleElevations    computeGrades
  ────────        ─────────         ────────────────    ─────────────
  raw ways   ──►  nodes + edges ──► nodes + elevationM  ──► edges +
  (filtered       (densified,       (DEM lookups,           gradePct,
   walkable)       snapped ids)      cell-deduped)           riseM, length
                                                            │
                                                            ▼
                                                     buildAdjacency
                                                     nodeId → edgeIds
                                                            │
                                                            ▼
                                                      Graph { ... }
```

Walk it one stage at a time:

- **Parse.** Overpass JSON → walkable ways with resolved coordinates. The
  boundary case: a way tagged with a `highway` value not in the walkable set is
  dropped — you only graph what you can travel.
- **Split.** Long ways get densified so no segment exceeds `maxSegM`, and
  coincident vertices snap to one shared node id. This is the load-bearing
  graph-construction step: snap wrong and "the same corner" becomes two
  unconnected nodes — a silently disconnected graph.
- **Sample.** Each node gets an elevation from a DEM provider, with same-cell
  nodes coalesced into one query (don't sample finer than the data resolution).
- **Grade.** Each edge gets `lengthM`, signed `riseM`, and signed `gradePct`,
  clamped to filter coarse-DEM noise.
- **Adjacency.** `nodeId → [edgeIds]`. This is what lets A\* expand.

Pseudocode for the whole DAG:

```
  build_graph(city, bbox, osm, elevation):
    ways   = parse_osm(osm)                 // filter to walkable, resolve coords
    skel   = split_ways(ways, maxSegM)      // densify + snap → nodes, edges
    nodes  = sample_elevations(skel.nodes)  // DEM lookups, cell-deduped
    edges  = compute_grades(nodes, skel.edges)  // length, rise, signed grade
    adj    = build_adjacency(edges)         // nodeId → incident edgeIds
    return { city, bbox, nodes, edges, adjacency: adj }   // ← the artifact
```

#### The artifact (the seam itself)

The output of the DAG is serialized to one JSON file. That file is the *only*
thing that crosses into runtime. Its shape — `{ city, bbox, nodes, edges,
adjacency }` — is the contract. The runtime trusts it completely: no validation,
no schema check, no version negotiation. Whatever the pipeline emits is gospel.

```
  Layers-and-hops — what crosses the seam

  ┌─ BUILD TIME ─────────────┐   hop: writeFileSync(JSON)   ┌─ DISK ────────┐
  │  Graph object in memory  │ ──────────────────────────► │ data/graph.json│
  └──────────────────────────┘                             └───────┬────────┘
                                          hop: manual copy          │
                                  ┌───────────────────────────────◄─┘
                                  ▼
  ┌─ APP BUNDLE ─────────────┐   hop: import + cast to Graph  ┌─ RUN TIME ───┐
  │ mobile/assets/graph.json │ ────────────────────────────► │ loadGraph()  │
  └──────────────────────────┘                               └──────────────┘
```

The boundary condition that bites: the copy from `data/` to `mobile/assets/` is
**manual** and the file carries **no version stamp**. If the engine that reads
it changes shape but the bundled graph is stale, nothing catches it. → audit §8.2.

#### The runtime read path (below the seam)

The consumer side is deliberately thin. `loadGraph` imports the JSON and casts
it to `Graph` — that's the whole loader. Everything else is derived: color the
edges (heatmap), snap endpoints to nodes, run A\*. No write path exists.

```
  Pattern — runtime is read + derive, never write

  graph.json ──► loadGraph ──► Graph ──┬──► graphToGeoJSON  (heatmap)
                                       ├──► nearestNode     (snap endpoints)
                                       └──► directedAstar   (the route)
                          (all pure reads; nothing mutates the graph)
```

### Move 2.5 — current state vs future state

This is the part to internalize, because it's where the as-designed and as-built
architectures diverge — and a reviewer *will* ask.

**Phase A — as designed (spec §5, §8).** Build → store in **Netlify Blobs** →
serve tiles to a **Next.js** client over an API route → client runs A\* (or,
fork D, the server does). The seam is a network boundary; the artifact lives on
infrastructure.

**Phase B — as built (this repo).** Build → write JSON → **manually copy into
the Expo app bundle** → the phone imports it → the phone runs A\*. The seam is a
file copy; the artifact ships inside the binary.

```
  Comparison — as designed vs as built

  AS DESIGNED (spec)                    AS BUILT (repo)
  ─────────────────                     ───────────────
  build → Netlify Blobs                 build → data/graph.json
       │  served over HTTP                   │  copied by hand
       ▼                                      ▼
  Next.js client fetches tiles          Expo RN imports bundled JSON
       │                                      │
       ▼                                      ▼
  client A* (or server A*, fork D)      on-device A*
       │                                      │
  seam = network boundary               seam = file copy + bundle
  scales to multi-city                  scoped to one small bbox

  WHAT DOESN'T CHANGE between them: the Graph contract and the entire
  router (astar.ts, cost.ts, pqueue.ts). Those survive the migration intact.
```

The takeaway is the one that reads as senior: **the migration from B to A
doesn't touch the router.** A\* runs the same against a bundled graph or a
fetched one. What changes is only the *delivery* layer — `loadGraph` +
`useTileGraph` get replaced by a fetch-from-Blobs loader. The expensive,
hard-to-get-right part (the graph engine) is already on the right side of the
seam. That's the payoff of organizing the whole system around the artifact.

### Move 3 — the principle

Move expensive, rarely-changing work to a build step and freeze its output into
an immutable artifact; the runtime then does the least work that still answers
the user's question. The artifact's *type* becomes the system's real API — get
that contract right and you can swap how it's produced and how it's delivered
without touching what consumes it.

---

## Primary diagram

The whole pattern in one frame — the DAG, the seam, the consumer, and the leak
that breaks the clean version.

```
  Build/runtime split — full recap

  ┌─ BUILD TIME (offline, rare) ─────────────────────────────────────────┐
  │  Overpass ─► parseOsm ─► splitWays ─► sampleElevations ─► computeGrades│
  │                                                              │         │
  │                                                   buildAdjacency       │
  │                                                              │         │
  │                                         run-build.ts writes  ▼         │
  └──────────────────────────────────────────────  data/graph.json ───────┘
                                                          │
                    ★ THE SEAM — the Graph contract ★     │  manual copy
                                                          ▼
  ┌─ RUN TIME (on-device, per-session) ──────────────────────────────────┐
  │  mobile/assets/graph.json ─► loadGraph ─► baseGraph                    │
  │       │                                                               │
  │       ▼                                                               │
  │  useTileGraph ─► stitch(merge[base, corridor?, view?]) ─► graph       │
  │       ▲                                                               │
  │       └── ✗ LEAK: re-runs the BUILD pipeline on-device for viewport/  │
  │              corridor (see 03-on-device-pipeline.md)                  │
  │       │                                                               │
  │       ▼                                                               │
  │  MapScreen ─► graphToGeoJSON (heatmap) · directedAstar (route)        │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every session uses this split: the app opens, imports the bundled
graph, and the bundled Capitol Hill bbox is immediately routable and rendered —
all offline, because the expensive work already happened. You re-run the build
side only when the underlying data changes (`npm run build:graph`).

**The build entry — `pipeline/run-build.ts` (lines 40-52).**

```
  async function main():
    const { provider, sampleOpts, maxSegM } = pickElevation();   ← choose DEM source
    const osm = await fetchOverpass(BBOX);                        ← fetch streets for the bbox
    const graph = await buildGraph("seattle-mvp", BBOX, osm, ...) ← run the whole DAG
    mkdirSync("data", { recursive: true });
    writeGraph(graph, "data/graph.json");                        ← freeze the artifact
         │
         └─ writeGraph (lines 11-13) is `writeFileSync(path, JSON.stringify(graph))` —
            the ONLY durable write in the entire system. Everything else reads.
```

`BBOX` (`pipeline/config.ts:10`) is the small Capitol Hill slice; it's what
keeps the artifact at 544 KB and the free-tier build under rate limits.

**The DAG orchestrator — `pipeline/build-graph.ts` (lines 12-30).**

```
  export async function buildGraph(city, bbox, osm, elevation, maxSegM, ...):
    const ways = parseOsm(osm);                               ← stage 1
    const { nodes, edges } = splitWays(ways, maxSegM);        ← stage 2 (densify+snap)
    const nodesE = await sampleElevations(nodes, elevation);  ← stage 3 (DEM)
    const edgesG = computeGrades(nodesE, edges);              ← stage 4 (grade)
    return { city, bbox, nodes: nodesE, edges: edgesG,
             adjacency: buildAdjacency(edgesG) };             ← stage 5 (adjacency)
       │
       └─ line 2: "No node:fs here so this module bundles for the app." This is the
          deliberate hook that LETS the runtime re-run the pipeline — the same
          buildGraph runs offline (run-build) and on-device (useTileGraph). The
          comment is the design decision that makes the leak in file 03 possible.
```

**The runtime loader — `mobile/src/loadGraph.ts` (lines 9-11).**

```
  import graph from "../assets/graph.json";
  export function loadGraph(): Graph {
    return graph as unknown as Graph;          ← cast, no validation
  }
       │
       └─ the entire consumer-side read. The graph is trusted as-is; no schema
          check means a stale bundled artifact (lines 2-3 say copy it by hand)
          fails silently, not loudly. That's the cost of the manual-copy seam.
```

**The artifact contract — `features/routing/types.ts` (lines 22-28).**

```
  export type Graph = {
    city: string;
    bbox: [number, number, number, number];   ← minLng,minLat,maxLng,maxLat
    nodes: Record<string, Node>;               ← id → node
    edges: Edge[];
    adjacency: Record<string, string[]>;       ← nodeId → incident edgeIds
  };
       │
       └─ THIS is the API between build and runtime. Both phases import it. Get
          it stable and the delivery mechanism (bundle vs Blobs) is swappable.
```

---

## Elaborate

This pattern is the static-site-generator idea (Jekyll, Next.js SSG, Astro)
generalized past HTML to any precomputable artifact: search indices (a built
Lucene index served read-only), ML model weights (trained offline, loaded for
inference), compiled query plans. The common thread is a **read-heavy,
write-rare** workload where the write side is expensive and the read side must
be cheap — exactly flattr's situation, since OSM streets and terrain don't
change on a session timescale.

The reason it kills the database here is worth stating plainly: a DB exists to
coordinate *mutable shared state*. flattr has no mutable shared state — the graph
is immutable and per-device, user state isn't persisted at all (spec §13). Remove
the need to mutate and you remove the need for the DB. That's not a shortcut;
it's the correct architecture for this data.

Where it bites is scale and freshness (audit §7): a single bundled artifact
doesn't tile, doesn't update without an app release, and doesn't cover a city.
The spec's Blobs + tiles + (optional) server-A\* design is the answer to all
three, and the migration is cheap *because* the router sits below the seam.

Read next: `02-bundled-graph-artifact.md` (the immutability story in depth),
`03-on-device-pipeline.md` (how and why the seam leaks). For the router that
sits below the seam, see `.aipe/study-dsa-foundations/`.

---

## Interview defense

**Q: Why no database?**
> Because there's no mutable shared state to coordinate. The graph is built
> offline from OSM and elevation — data that doesn't change on a session
> timescale — frozen into an immutable JSON artifact, and the app only reads it.
> User state isn't persisted at all. A DB exists to manage concurrent writes;
> with no writes, it's pure overhead. Lose the artifact and I regenerate it with
> `npm run build:graph`.

```
  build (rare) ──► graph.json (immutable) ──► app (reads only)
                          no writes ⇒ no DB
```

**Q: What's the contract between build and runtime, and what happens if it
breaks?**
> The `Graph` type — `{ city, bbox, nodes, edges, adjacency }` in
> `features/routing/types.ts`. Both phases import it. The weak spot is that the
> artifact is copied into the app bundle by hand with no version stamp and the
> loader casts without validating (`loadGraph.ts`), so a stale bundle fails
> silently. The fix is a content hash or schema version checked at load — I
> haven't built it because at one bbox the copy is a single deliberate step.

```
  build engine  ──┐
                  ├─ both import Graph type ─► if they drift, silent failure
  runtime reader ─┘     (no version check at the seam — known gap)
```

**Q: How does this scale to all of Seattle?**
> The artifact and the loader break first, not the router. A city-scale graph is
> too big to bundle and `nearestNode` is a linear scan. The migration is to
> serve tiled graphs from storage (the spec's Netlify Blobs design) and fetch by
> bbox instead of bundling — but the A\* engine doesn't change at all. It runs
> the same against a fetched graph as a bundled one. That's the payoff of putting
> the router below the artifact seam: I can change delivery without touching the
> hard part.

```
  TODAY: bundle one bbox        FUTURE: fetch tiles from Blobs
         │                              │
         └── router unchanged ──────────┘   ← migration touches only delivery
```

---

## Validate

1. **Reconstruct.** Draw the three layers (build / artifact / runtime) and the
   one-way arrow. Name the five build stages in order
   (`pipeline/build-graph.ts:21-29`) and the single write
   (`run-build.ts:11-13`).
2. **Explain.** Why is `build-graph.ts` deliberately free of `node:fs`
   (`build-graph.ts:2`)? What does that enable downstream?
3. **Apply.** A teammate adds a `surface` field to `Edge`. Walk every file that
   must change and explain why the bundled `mobile/assets/graph.json`
   (`loadGraph.ts:7`) won't reflect it until a manual step runs.
4. **Defend.** A reviewer says "you should've used Postgres + PostGIS." Defend
   the no-DB choice using the immutability of the data and the absence of any
   write path (`audit.md` §5), then name the exact point at which you'd revisit
   it (`audit.md` §7).

---

## See also

- `00-overview.md` — the full system map.
- `02-bundled-graph-artifact.md` — the immutable artifact in depth.
- `03-on-device-pipeline.md` — where this clean split leaks.
- `audit.md` §1 (boundaries), §5 (storage), §7 (scale).
- `.aipe/study-dsa-foundations/` — the A\* router that lives below the seam.
- `.aipe/study-data-modeling/` — the `Graph` schema shape.
