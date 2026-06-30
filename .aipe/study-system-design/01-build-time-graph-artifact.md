# Build-time graph artifact

**Industry names:** static site generation (SSG) / build-time precomputation /
"bake the data" / asset-as-database. **Type:** Industry standard.

---

## Zoom out, then zoom in

flattr has no database and no API server. The thing every other app would put in
Postgres — the routable street graph — flattr computes once on your laptop and
ships as a JSON file inside the app bundle. The runtime never builds the base
graph; it reads it.

```
  Zoom out — where the artifact sits in the system

  ┌─ BUILD TIME (your machine, npm run build:graph) ───────────┐
  │  overpass → osm → split → elevation → grade → build-graph   │
  │                                          │                  │
  │                              run-build.ts │ JSON.stringify   │
  └──────────────────────────────────────────┼─────────────────┘
                                              ▼
                      ★ data/graph.json ★  ← THE ARTIFACT (we are here)
                              │  copied into the bundle
  ════════════════ ARTIFACT BOUNDARY (static file) ═════════════
                              ▼
  ┌─ RUNTIME (the phone) ──────────────────────────────────────┐
  │  loadGraph.ts → baseGraph → directedAstar → map            │
  └────────────────────────────────────────────────────────────┘
```

The pattern: you know how a static-site generator runs your React at build time
and ships plain HTML, so the browser does zero rendering work? Same shape. flattr
runs the expensive graph-building pipeline at build time and ships plain JSON, so
the phone does zero graph-building work for the base area. The question it answers:
*where does the cost of turning the world into a routable graph live — at request
time, or once, ahead of time?*

---

## The structure pass

**Layers** (one axis traced down each): build pipeline → artifact → runtime reader.

**Axis = lifecycle (when does the work happen?).** Hold that one question constant:

```
  One question down the layers: "when does the graph get built?"

  ┌───────────────────────────────────┐
  │ build pipeline (pipeline/*)        │  → BUILD TIME (once, offline)
  └───────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ artifact (graph.json)           │  → never; it's frozen
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ runtime reader (loadGraph)  │  → RUNTIME, but only a JSON.parse
          └─────────────────────────────┘

  the answer flips at the artifact: above it = compute; below it = read
```

**Seam = the artifact.** This is the load-bearing boundary. Trace the *cost* axis
across it: above, building one graph means an Overpass fetch + thousands of
elevation samples + grade math (seconds, network-bound). Below, getting the graph
means `JSON.parse` of a bundled file (milliseconds, no network). The axis flips
hard — that's what makes the file a real architectural seam and not just an output.

The other thing the seam carries: a **trust** flip. Above it, the build holds an
API key (`GOOGLE_ELEVATION_KEY`) and hits rate-limited services. Below it, the app
ships no keys and makes no calls to serve the base area.

---

## How it works

#### Move 1 — the mental model

The shape is "precompute and freeze." A pipeline of pure stages takes a bbox and
produces a `Graph` object; the last stage serializes it to disk; the app imports
that file. Nothing in the runtime path can rebuild the base graph — that capability
lives entirely on the build side of the seam.

```
  Pattern — fan-in pipeline to a frozen artifact

  bbox ─► [overpass] ─► [osm] ─► [split] ─► [elevation] ─► [grade] ─► [build-graph]
                                                                          │
                                                                   Graph object
                                                                          │
                                                              JSON.stringify (freeze)
                                                                          ▼
                                                                  data/graph.json
                                                                  (read-only forever
                                                                   until next build)
```

#### Move 2 — the walkthrough

**The build is a linear orchestration of pure stages.** You've chained `.map()` /
`.filter()` transforms where each step's output feeds the next — same idea, but each
"step" is a module. `buildGraph` is the orchestrator and it reads like a pipeline:

```ts
// pipeline/build-graph.ts:12 — each line is one stage; output feeds the next
const ways = parseOsm(osm);                                   // raw OSM → ways
const { nodes, edges } = splitWays(ways, maxSegM);            // densify ≤12m segments
const nodesWithElev = await sampleElevations(nodes, elevation, sampleOpts); // + DEM
const gradedEdges = computeGrades(nodesWithElev, edges);      // + signed grade %
return { city, bbox, nodes: nodesWithElev,
         edges: gradedEdges, adjacency: buildAdjacency(gradedEdges) };
```

The boundary condition that makes this whole pattern possible is one line of
*absence*: `pipeline/build-graph.ts:2` — *"No node:fs here so this module bundles
for the app."* `buildGraph` does I/O-free pure assembly. The filesystem write lives
one layer up, in `run-build.ts`, which the app never imports. That separation is
exactly what lets the *same* `buildGraph` run on-device later
(→ `02-on-device-pipeline-rerun.md`).

**The freeze is one `writeFileSync` of `JSON.stringify`.** No schema migration, no
serialization library:

```ts
// pipeline/run-build.ts:11
function writeGraph(graph: Graph, path: string): void {
  writeFileSync(path, JSON.stringify(graph));   // the entire persistence layer
}
```

The honest cost: this is **not atomic** — a crash mid-write corrupts `graph.json`.
That's accepted because the file is regenerable from `npm run build:graph`; the
durability bar is deliberately low (audit lens 5). A temp-file-then-rename would
close it for free, and that's the one cheap hardening worth adding.

**The read is a typed cast of a bundled import.** Crossing the artifact boundary on
the runtime side is trivial:

```ts
// mobile/src/loadGraph.ts:7
import graph from "../assets/graph.json";        // Metro bundles it into the app
export function loadGraph(): Graph {
  return graph as unknown as Graph;              // no parse cost beyond Metro's
}
```

The hop across the seam, drawn:

```
  Layers-and-hops — crossing the artifact boundary

  ┌─ Build machine ─────────┐  hop 1: JSON.stringify(graph)   ┌─ Disk ─────────┐
  │  run-build.ts           │ ──────────────────────────────► │ data/graph.json│
  └─────────────────────────┘                                 └───────┬────────┘
                                                  hop 2: copy into     │
                                                  mobile/assets/       ▼
  ┌─ Phone (bundle) ────────┐  hop 3: import + cast            ┌─ Bundle ───────┐
  │  loadGraph.ts → Graph   │ ◄────────────────────────────── │ graph.json     │
  └─────────────────────────┘                                 └────────────────┘

  hop 1 = seconds, network-bound  |  hop 3 = milliseconds, no network
```

**What the artifact costs you, named.** It's 544 KB on disk (`mobile/assets/graph.json`)
for a single Capitol Hill slice. `config.ts:4` keeps the bbox small *on purpose* —
"so the bundled graph.json stays phone-friendly." That's the tradeoff stated
plainly: a frozen artifact means bundle size scales with covered area, and the base
coverage is intentionally tiny because the on-device rerun (`02-`) backfills the rest.

#### Move 3 — the principle

Precompute anything that's expensive to derive and cheap to store, **as long as it
doesn't change between builds.** The street graph qualifies: streets and 90m DEM
elevation are effectively static, so paying the cost once at build time and freezing
the result removes an entire server, an entire query layer, and an entire
availability dependency from the runtime. The discipline that makes it work is
keeping the producer pure (no `fs`, no globals) so the *same* code can run on either
side of the freeze.

---

## Primary diagram

```
  Build-time graph artifact — the whole pattern

  ┌─ BUILD (Node) ──────────────────────────────────────────────┐
  │  config.BBOX                                                 │
  │      ▼                                                       │
  │  fetchOverpass → parseOsm → splitWays → sampleElevations     │
  │      → computeGrades → buildAdjacency ──► Graph (pure, no fs) │
  │                                              │               │
  │                                  run-build.ts│ writeFileSync  │
  └──────────────────────────────────────────────┼──────────────┘
                                                  ▼
                          data/graph.json  (544 KB, frozen)
                                                  │ copy → mobile/assets/
   ═══════════════════ ARTIFACT BOUNDARY ═════════╪═══════════════════════
                                                  ▼
  ┌─ RUNTIME (phone) ──────────────────────────────────────────┐
  │  import graph.json → loadGraph(): Graph → baseGraph         │
  │      (no network, no DB, no build — just a typed read)      │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the same idea as a static-site generator (Next.js `getStaticProps`,
Jekyll, Hugo): move work from request time to build time when the inputs are known
ahead of time. It's also the "data as an asset" pattern — shipping a SQLite file or
a prebuilt index inside an app instead of querying a server.

flattr's variant is unusual in that the *producer of the artifact is also importable
by the consumer* (`build-graph.ts` has no `fs`), which sets up the next pattern: the
runtime can re-run the build for areas the artifact doesn't cover. Most SSG setups
can't do that — the build toolchain doesn't ship to the client. Here it does, on
purpose. Read `02-on-device-pipeline-rerun.md` next; it's the direct consequence of
keeping `buildGraph` pure.

Adjacent guides: the on-disk serialization/durability mechanics →
`study-database-systems`; the `Graph`/`Node`/`Edge` schema →
`study-data-modeling`.

---

## Interview defense

**Q: Why no database? Isn't a file a step backward?**
A street graph is read-only at runtime and rebuilt offline. A database buys you
mutation, queries, and concurrency — flattr needs none of those for the base graph.
A file buys zero cold-start network, zero server, zero query layer. For
*immutable-between-builds, read-only* data, the file is the correct choice, not a
compromise.

```
  the decision, drawn

  data is immutable between builds? ──yes──► freeze it (file)
                                  └──no───► need a datastore
```
Anchor: *"No live backend / DB. Graph is a prebuilt static artifact."*

**Q: What's the load-bearing line in this whole pattern?**
`pipeline/build-graph.ts:2` — the *absence* of `node:fs`. Keeping the producer
pure is what lets the same builder run on the phone later. Drop that and you'd have
two diverging graph builders. Naming the thing that *isn't* there is the signal you
understood why it's structured this way.
Anchor: pure producer = reusable across the artifact seam.

**Q: First thing that breaks at 10× area?**
Bundle size and cold-start parse — the artifact grows with coverage. The code
already anticipates this (`config.ts:4` keeps the bbox small); the escape hatch is
the on-device rerun, so you ship a small base and backfill.
Anchor: artifact size scales with area; coverage is intentionally tiny.

---

## See also

- `02-on-device-pipeline-rerun.md` — the same pipeline running on the phone.
- `03-tile-merge-stitch.md` — how runtime regions glue onto the base artifact.
- `05-elevation-provider-fallback.md` — the elevation stage's failure model.
- `audit.md` lenses 1, 5, 7 — boundaries, storage choice, scale.
</content>
