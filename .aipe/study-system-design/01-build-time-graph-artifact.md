# Build-Time Graph Artifact

**Industry names:** static site generation / ahead-of-time compilation /
prebuilt data artifact. **Type:** Industry standard (the SSG pattern, applied
to a graph instead of HTML).

---

## Zoom out, then zoom in

You've shipped a Next.js app (AdvntrCue) where the request hits a serverless
function that queries Postgres at *request time*. flattr does the opposite:
it does all the expensive work *once, offline*, bakes the result into a file,
and ships the file. The runtime never computes the graph — it reads it.

```
  Zoom out — where the artifact lives

  ┌─ BUILD TIME (Node / tsx, your laptop) ───────────────────┐
  │  Overpass + elevation + grade math                       │
  │            │                                             │
  │            ▼                                             │
  │     ★ data/graph.json ★   ← THIS CONCEPT (the artifact)  │ ← we are here
  └────────────┬─────────────────────────────────────────────┘
               │ hand-copied into the app bundle
               ▼
  ┌─ RUNTIME (Expo RN, device) ──────────────────────────────┐
  │  loadGraph.ts  →  import graph.json  →  route over it     │
  │  (no fetch, no DB, no compute of the graph)              │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **moving expensive, rarely-changing work out of the
request path and into a build step**, leaving a static artifact the runtime
just reads. The question it answers: *why does flattr need no backend?* Because
the only thing a backend would do here — turn streets + elevation into a routable
graph — already happened at build time.

## Structure pass

**Layers.** Two: the *build layer* (`pipeline/`) that produces the artifact,
and the *runtime layer* (`mobile/`) that consumes it. The artifact
(`graph.json`) is the seam between them.

**Axis — `lifecycle` (when does the work happen?).** Hold that one question
across the layers:

```
  One question: "when is the graph computed?" — traced across layers

  ┌──────────────────────────────────────────┐
  │ build layer: pipeline/run-build.ts        │  → BUILD TIME (once, offline)
  └──────────────────────────────────────────┘
        │  artifact crosses the seam (a file)
        ▼
  ┌──────────────────────────────────────────┐
  │ runtime layer: mobile/src/loadGraph.ts    │  → NEVER (just reads it)
  └──────────────────────────────────────────┘

  the answer flips at the file boundary — that flip IS the architecture
```

**Seam.** `data/graph.json` → `mobile/assets/graph.json`. The axis flips hard
across it: on the build side the graph is *computed* (network calls, math); on
the runtime side it is *given* (a synchronous import). That's a load-bearing
seam — everything about flattr's "no backend" claim sits on it.

## How it works

### Move 1 — the mental model

You already know this shape from frontend: it's static site generation. Next.js
`getStaticProps` runs at build time, hits your data source, and freezes the
result into HTML the CDN serves with zero per-request compute. flattr does the
same thing, except the frozen artifact is a *routable graph* instead of a page.

The strategy in one sentence: **compute once at build time, serialize, ship the
serialized blob, read it at runtime.**

```
  The pattern — compute-once, read-many

   BUILD TIME (runs once)              RUNTIME (runs every session)
   ───────────────────────            ────────────────────────────
   fetch ──► transform ──► serialize  read ──► use
     │          │             │         │       │
   Overpass   split+grade   JSON      import   route
     │          │             │         │       │
     └── slow, network-bound ─┘         └─ instant, local ─┘
            (minutes)                       (microseconds)
```

The expensive arrow (fetch + transform) runs in the build column. The runtime
column only ever does `import` + `route`. That asymmetry is the entire payoff.

### Move 2 — the walkthrough

**The build entrypoint produces exactly one file.** `pipeline/run-build.ts`
fetches, builds, and writes. Watch the last three lines — the whole pipeline
collapses into a single `JSON.stringify`:

```ts
// pipeline/run-build.ts:40-52 (main)
const osm = await fetchOverpass(BBOX);                              // 43: network
const graph = await buildGraph("seattle-mvp", BBOX, osm, provider, // 46: transform
                               maxSegM, sampleOpts);
mkdirSync("data", { recursive: true });                            // 47
writeGraph(graph, "data/graph.json");                              // 48: serialize → ONE file

// pipeline/run-build.ts:11-13 (writeGraph)
function writeGraph(graph: Graph, path: string): void {
  writeFileSync(path, JSON.stringify(graph));   // the artifact is just JSON
}
```

The artifact is plain JSON — no binary format, no index files. Everything the
runtime needs (`nodes`, `edges`, `adjacency`, `bbox`) is in
`pipeline/build-graph.ts:29`'s return object, stringified.

```
  Layers-and-hops — the artifact crossing from build to runtime

  ┌─ Build (Node) ─────────┐  hop 1: JSON.stringify(graph)   ┌─ Filesystem ─┐
  │  buildGraph() returns  │ ──────────────────────────────► │ data/graph.  │
  │  {nodes,edges,adj,bbox}│                                  │ json         │
  └────────────────────────┘                                 └──────┬───────┘
                                          hop 2: manual copy        │
                                          (npm run build:graph,     ▼
                                           then cp into assets)  ┌─ App bundle ─┐
                                                                 │ mobile/      │
                                                                 │ assets/      │
                                                                 │ graph.json   │
                                                                 └──────┬───────┘
  ┌─ Runtime (RN) ─────────┐  hop 3: import (synchronous)            │
  │  loadGraph() returns   │ ◄───────────────────────────────────────┘
  │  the Graph             │
  └────────────────────────┘
```

**The runtime side is a synchronous import — no async, no I/O.** This is the
tell that there's no backend:

```ts
// mobile/src/loadGraph.ts:7-11
import graph from "../assets/graph.json";   // 7: bundled at compile time
export function loadGraph(): Graph {
  return graph as unknown as Graph;          // 9-11: just a cast, no fetch
}
```

No `fetch`, no `await`, no loading state. The graph is present the instant the
module loads, because Metro bundled the JSON into the app binary.

**The same engine runs in both layers — that's why this scales to on-device.**
The build pipeline imports `buildAdjacency` from `features/routing/graph`
(`build-graph.ts:4,29`). That same `features/` code ships to the device. The
copy step makes it bundleable:

```js
// mobile/scripts/sync-engine.mjs:15-19
for (const dir of ["features", "lib", "pipeline"]) {
  cpSync(path.join(repoRoot, dir), path.join(dest, dir), {
    recursive: true,
    filter: (src) => !src.endsWith(".test.ts"),   // 18: skip tests
  });
}
```

Because `pipeline/` itself is copied in, the device can re-run the build for
new areas — which is the next pattern (`02-on-device-pipeline-rerun.md`). The
artifact is the base case; the on-device re-run is the same machine pointed at a
different bbox.

#### Move 2 variant — what breaks if you remove it

The irreducible kernel is three parts:

1. **The build step** (`run-build.ts:40-52`). Remove it and there's no graph —
   the runtime would have to compute it, which means shipping a backend or
   doing the full Overpass+elevation+grade work on first launch every time.
2. **The serialization** (`run-build.ts:11-13`). Remove the `JSON.stringify`
   and there's nothing to ship — the computed graph dies with the build
   process.
3. **The synchronous load** (`loadGraph.ts:7`). Remove the static import and
   the runtime is back to async fetch + loading states + a server to fetch
   *from*.

Optional hardening layered on top: the `sync-engine.mjs` copy (an artifact of
Metro's watch scope, not the pattern), and the on-device re-run (an *extension*
of the base artifact, not part of it).

### Move 3 — the principle

The principle is **push work to the cheapest lifecycle stage that can do it.**
Graph construction is expensive and rarely changes, so it belongs at build time,
not request time. The moment you accept that, the backend evaporates: there's
nothing left for a server to do. This is the same instinct behind SSG, behind
compiled-vs-interpreted, behind precomputed indexes — do the work once, where
it's cheap, and let the hot path just read.

## Primary diagram

```
  Build-time graph artifact — the full picture

  ┌─ BUILD LIFECYCLE (once, npm run build:graph) ─────────────────────────┐
  │                                                                       │
  │  Overpass ─► osm ─► split ─► elevation ─► grade ─► buildAdjacency     │
  │  (network)         (≤12m)   (3 providers) (signed)                    │
  │                                  │                                    │
  │                                  ▼                                    │
  │                   buildGraph() → {nodes,edges,adjacency,bbox}         │
  │                                  │                                    │
  │                       JSON.stringify (run-build.ts:12)                │
  │                                  ▼                                    │
  │                          ★ data/graph.json ★                         │
  └──────────────────────────────────┬────────────────────────────────── ┘
                                      │  hand-copied → mobile/assets/
  ════════════════════════ THE SEAM (a static file) ═══════════════════════
                                      │
  ┌─ RUNTIME LIFECYCLE (every session) ──────────────────────────────────┐
  │   loadGraph() ── import graph.json ──► Graph ──► directedAstar(...)    │
  │   (synchronous, no fetch, no DB, no backend)                          │
  └────────────────────────────────────────────────────────────────────── ┘
```

## Elaborate

This is static site generation generalized past HTML. The web learned it the
hard way: rendering every page per request doesn't scale, so Jamstack/SSG moved
rendering to build time and served static files from a CDN. flattr applies the
identical reasoning to graph data — the "render" is graph construction, the
"CDN file" is `graph.json`.

The interesting twist is that flattr doesn't *only* prebuild. Because the build
pipeline is just TypeScript that also runs on-device, it can fall back to
build-at-runtime for areas the artifact doesn't cover. That's a hybrid the web
SSG world also reached eventually — Incremental Static Regeneration is "prebuilt
by default, build-on-demand at the edges." flattr's `useTileGraph` is ISR for a
street graph. Read `02-on-device-pipeline-rerun.md` next.

What to read next: `03-tile-merge-stitch.md` for how on-demand pieces glue onto
the base artifact, and neighboring **study-data-modeling** for the `Node`/`Edge`
schema that the artifact serializes.

## Interview defense

**Q: Why no backend? Isn't that a limitation?**
It's a consequence of the data being read-mostly and computable ahead of time.
The only work a backend would do — turn OSM + elevation into a routable graph —
happens at build time and ships as `data/graph.json` (`run-build.ts:48`). The
runtime imports it synchronously (`loadGraph.ts:7`) and routes locally. No
per-request compute means no server to run it on.

```
  request-time compute        vs        build-time compute (flattr)
  ──────────────────────                ───────────────────────────
  client → server → DB → compute        client → import file → route
  (every request pays)                  (compute paid once, at build)
```
Anchor: *the backend evaporates because the graph is precomputed.*

**Q: What's the cost of the static-artifact approach?**
Staleness and manual invalidation. There's no freshness check —
`graph.json` is rebuilt and copied by hand (`loadGraph.ts:2-5` comment). The
base coverage drifts from OSM until someone re-runs `npm run build:graph`.
That's acceptable for an MVP slice and the right call to avoid running
infrastructure; at coverage scale you'd automate the rebuild.

**Q: The load-bearing part people forget?**
The serialization step. Computing the graph is the obvious part; the part that
makes it an *artifact* is `JSON.stringify` to a single file
(`run-build.ts:12`). Without it the computed graph dies with the build process
and you're back to needing a server.

## See also

- `00-overview.md` — the whole system in one frame
- `02-on-device-pipeline-rerun.md` — the same pipeline, run on the device
- `03-tile-merge-stitch.md` — how new pieces attach to the base artifact
- `audit.md` §1 (system-map), §5 (storage choice)
- neighboring: **study-data-modeling** (the serialized `Node`/`Edge` schema)
