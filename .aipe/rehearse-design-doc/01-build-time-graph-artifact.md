# 01 — Build-time graph artifact, no database

> **Decision:** the routing graph is a single static JSON artifact built offline by
> the pipeline and bundled into the app; the app only ever *reads* it. No routing
> server, no spatial database, no query layer. Adjacency is the index, and the
> whole graph is in memory before the first route.

---

## Context / problem

flattr routes over a grade-annotated street graph: nodes are street intersections
with elevation, edges carry a signed grade. The access pattern is the thing to
notice before you pick storage. Routing is **whole-graph traversal** — A* pops a
node, reads its incident edges, relaxes neighbors, repeats. It never asks "give me
all edges in this bbox" or "edges where grade < 4%." It asks, thousands of times
per route, "what edges touch *this* node?"

That's a pointer-chase, not a query. And the data behind it doesn't change at
request time — a street's grade is a fact about the world, fixed once you've
sampled elevation. The schema is small and known:
`Node {id, lat, lng, elevationM}`, `Edge {id, fromNode, toNode, geometry, lengthM,
riseM, gradePct, absGradePct, kind?}`, plus `adjacency: nodeId -> edgeIds`
(`features/routing/types.ts:1`).

So the question forced on the design: where does the graph live, and what reads it?
The spec (`docs/flattr-spec.md` §8) originally proposed a Next.js web app on
Netlify. The repo answered differently — and the answer is "nowhere live; it's a
file."

---

## Goals & non-goals

**Goals**
- Routing reads the graph with zero network and zero query latency — adjacency is
  an O(1) lookup, not a `SELECT`.
- The graph is reproducible from source: `npm run build:graph` regenerates it from
  OSM + elevation (`pipeline/run-build.ts`).
- The engine bundles for both Node (bench/tests) and the device (Expo app) — no
  `node:fs`, no server runtime assumed (`pipeline/build-graph.ts:2`).

**Non-goals**
- Live data freshness. A new sidewalk in OSM does not appear until the next build.
- Spatial queries beyond adjacency (radius search, bbox filter as a DB operation).
  Nearest-node is done in-process (`features/routing/nearest.ts`), not by an index.
- Per-user or per-request graph mutation. The artifact is read-only and shared.

---

## The decision

Build the graph offline, freeze it to `graph.json`, bundle it, and have the app
`import` it as a typed `Graph`. Routing runs against the in-memory object;
`adjacency` *is* the index.

```
  Build-time vs runtime — the seam is the file

  ┌─ BUILD TIME (pipeline/, offline) ─────────────────────────────┐
  │  Overpass (OSM)  ──►  parse  ──►  split ways  ──►  sample      │
  │                                                   elevation    │
  │                                                      │         │
  │                                                      ▼         │
  │                                   compute grades  ──► buildAdjacency
  │                                                      │         │
  │                                                      ▼         │
  │                                            ┌──────────────┐    │
  │                                            │  graph.json  │    │  ← frozen artifact
  │                                            └──────┬───────┘    │
  └───────────────────────────────────────────────────┼──────────┘
                          bundled into the app │  (read-only)
  ┌─ RUNTIME (mobile/, on device) ──────────────▼─────────────────┐
  │  loadGraph()  ──►  Graph in memory                            │
  │                      │                                         │
  │                      ▼  search() pops node, reads...           │
  │              adjacency[nodeId]  ──►  [edgeId, edgeId, ...]      │  ← the index
  │                      │  O(1), no query, no network             │
  │                      ▼                                         │
  │              relax neighbors, repeat                          │
  └───────────────────────────────────────────────────────────────┘
```

The two halves never share a process. The contract between them is a file with a
fixed shape. That's the whole architecture.

**The build is a fixed pipeline** — `buildGraph` runs the stages in order and
returns a `Graph`, deliberately with no filesystem dependency so the same function
runs offline to make `graph.json` *and* on-device to build viewport tiles
(`pipeline/build-graph.ts:12`):

```ts
// pipeline/build-graph.ts:12 — the build, framework-free, fs-free
const ways = parseOsm(osm);                          // OSM → ways
const { nodes, edges } = splitWays(ways, maxSegM);   // long ways → short edges
const nodesWithElev = await sampleElevations(...);   // attach elevationM
const gradedEdges = computeGrades(nodesWithElev, edges);
return { city, bbox, nodes, edges: gradedEdges,
         adjacency: buildAdjacency(gradedEdges) };    // ← adjacency baked in
```

**Loading is one import.** No connection pool, no migration, no ORM
(`mobile/src/loadGraph.ts:9`):

```ts
// mobile/src/loadGraph.ts — graph.json is the REAL build artifact
import graph from "../assets/graph.json";
export function loadGraph(): Graph {
  return graph as unknown as Graph;
}
```

**Adjacency is the index** (`features/routing/graph.ts:22`). This is the part a
reviewer should feel in their gut: the structure that would be a `CREATE INDEX` in
a database is just a `Record<string, string[]>` built once at the end of the
pipeline.

```ts
// features/routing/graph.ts:22 — buildAdjacency: nodeId -> incident edgeIds
for (const e of edges) {
  (adj[e.fromNode] ??= []).push(e.id);   // every edge registers under both
  (adj[e.toNode] ??= []).push(e.id);     // of its endpoints
}
```

And the router consumes it as a hash lookup inside the hot loop — no query crosses
a boundary (`features/routing/astar.ts:64`):

```ts
// features/routing/astar.ts:64 — the read pattern that justifies the choice
for (const edgeId of graph.adjacency[current] ?? []) {   // O(1) neighbor fetch
  const edge = byId.get(edgeId)!;                        // O(1) edge resolve
  ...
}
```

---

## Alternatives considered

**1. Routing server + spatial database (PostGIS / pgRouting).** The textbook
answer: edges in a table, a GiST index on geometry, `pgr_dijkstra` for the route.
Lost because the access pattern doesn't want a query engine. Routing is one
connected traversal of a known small region, not ad-hoc spatial filtering. A DB
buys you bbox queries and live writes flattr doesn't need, and charges you a
network hop *per route request* plus an always-on server. For a read-only,
whole-graph traversal, the index you actually want is adjacency — and you can bake
that into a file.

**2. Tile server, fetch-on-demand (vector tiles + per-tile routing).** Fetch graph
tiles as the user pans, route across stitched tiles. Lost as the *base* layer
because it puts a network round-trip in the cold path of the first route and
couples routing to connectivity. (Note: flattr *does* use exactly this on top of
the base artifact for coverage beyond the bundled region — viewport and corridor
builds in `mobile/src/useTileGraph.ts`. The decision here is that the *base* is a
frozen artifact, with tiles as an additive layer, not the foundation.)

**3. SQLite on device (the local-first store from buffr/dryrun).** A real option
given the portfolio — buffr uses SQLite as the canonical store. Lost because there
are no writes and no relational queries to justify a query engine on device. The
graph is immutable reference data; an `import` of JSON is strictly less machinery
than a database for read-only data that ships with the app.

```
  Alternatives, scored on the access pattern

                       live writes  spatial query  network/route  always-on
  ────────────────────  ──────────  ─────────────  ────────────   ─────────
  PostGIS + pgRouting     yes ✓        yes ✓          yes ✗          yes ✗
  tile server             yes ✓        per-tile       yes ✗          yes ✗
  SQLite on device        yes ✓        SQL ✓          no ✓           no ✓
  ★ static graph.json     no  ✗        no   ✗         no ✓           no ✓
  ────────────────────  ──────────  ─────────────  ────────────   ─────────
  flattr needs:           NO           NO             NO             NO
```

The column flattr needs is "no" four times. The artifact is the only option that
charges nothing for capabilities the app doesn't use.

---

## Tradeoffs accepted

We chose a frozen artifact, accepting:

- **The data is stale by construction.** OSM edits and elevation corrections don't
  land until someone reruns `build:graph` and re-bundles. For a grade map of a
  city, the world changes slower than the release cycle — acceptable.
- **No schema version on the artifact.** `graph.json` carries `{city, bbox, nodes,
  edges, adjacency}` with no version field. If the `Edge` shape changes, an old
  bundled `graph.json` silently mismatches the new code. Today the build and the
  reader ship together in one app, so they can't skew — but the moment the artifact
  is delivered separately from the binary, this is the bug. (Open question below.)
- **Whole graph in memory.** The app holds every node and edge at once. Fine at
  neighborhood scale (Capitol Hill); not a continent.

None of these are regrets. They're the price of deleting an entire backend, and at
this scale the backend is the thing not worth its weight.

---

## Risks & mitigations

```
  Risk                              Mitigation                          where
  ────────────────────────────────  ──────────────────────────────────  ──────────────
  graph.json drifts from Edge type  build + reader ship in one bundle;  loadGraph.ts,
    (no version field)                typed cast at load                  types.ts
  bundled region too small for the  on-device viewport/corridor tile    useTileGraph.ts
    user's actual location            builds extend coverage at runtime
  in-memory graph too big to load   neighborhood scale only; tiles are  useTileGraph.ts
                                       per-region, not global
  stale grades after OSM changes    rebuild + re-bundle on release;     run-build.ts
                                       reproducible from source
```

The sharpest one is the version field. The mitigation today is "they can't skew
because they ship together" — which is true until it isn't. Name it; don't pretend
it's solved.

---

## Rollout / migration

There's nothing to roll out — this is the architecture as built, not a change in
flight. The migration story is forward-looking: **if** the graph ever needs to be
delivered out-of-band (downloaded, not bundled), the migration is to add a
`version` (or `schemaVersion`) field to the `Graph` type and gate `loadGraph()` on
it. Callers don't change; the load path gains a compatibility check. That's the
one seam where today's "ship together" assumption would have to become an explicit
contract.

For data already in flight: there is none. The artifact is regenerated wholesale by
`build:graph`; there's no incremental migration because there's no mutable store.

---

## Open questions

- **Should `graph.json` carry a schema version now, before it's needed?** Cheap to
  add, prevents a silent-mismatch class of bug the day the artifact decouples from
  the binary. Leaning yes, but it's currently unbuilt.
- **Where's the line where in-memory stops working?** No measured node/edge ceiling
  exists yet. The tile system papers over it for coverage, but there's no number on
  "graph too big to load."
- **Nearest-node is a linear scan** (`features/routing/nearest.ts`), not a spatial
  index. Fine at current scale; an open question whether it needs a grid/k-d tree
  if the bundled region grows.

---

## Coach notes

- **Lead with the access pattern, not the absence of a database.** "We don't have a
  backend" sounds like a gap. "The access pattern is read-only whole-graph
  traversal, so adjacency is the index and the index is a file" sounds like a
  decision. Same fact, opposite read.
- A reviewer's reflex is "no database? how do you query?" Beat it to the punch:
  *there are no queries* — there's one traversal, and it wants pointers, not SQL.
- If they push on staleness, don't get defensive. "Grades change slower than
  releases; rebuild is one command and reproducible from source" closes it.
- The honest weakness to volunteer is the missing version field. Naming the bug
  *they'd* find reads as someone who's thought past the happy path.

## See also

- `02-parametric-directional-router.md` — what reads this artifact
- `03-honest-degradation-elevation.md` — how the artifact gets built when the
  elevation API is down
- `.aipe/study-system-design/` — build-time vs runtime as a system boundary
- `.aipe/study-dsa-foundations/` — adjacency list as a graph representation
