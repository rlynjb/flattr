# RFC 01 — Build-time graph artifact, no database

**Decision:** the routing graph is a prebuilt static `graph.json` that the app loads
once and only reads. There is no backend service and no spatial database — the build
pipeline turns OSM + elevation into a frozen artifact, and runtime traversal never writes
anything.

> Coach: lead with the verdict. "We ship a baked graph file, not a routing server." Say
> it first; the reviewer's first question — "where's the database?" — is answered before
> they ask. The suspense version ("so we considered a few options…") invites them to
> design it for you.

═════════════════════════════════════════════════
2. CONTEXT / PROBLEM
═════════════════════════════════════════════════

flattr routes over a *grade-annotated street graph* for one neighborhood (Capitol Hill,
Seattle — `mobile/src/loadGraph.ts:2`). The data it routes over is:

- **Bounded.** One bbox, thousands of nodes/edges — not a continent.
- **Static.** A street's length, geometry, and grade don't change between requests. The
  DEM elevation behind the grade *never* changes (`mobile/src/elevCache.ts:3` — "DEM
  samples never change, so cached values are valid forever").
- **Read in one shape.** Every query is the same: load the whole graph, run a
  whole-graph traversal from start to goal. There is no "fetch one street," no partial
  query, no per-user write.

The spec proposed Next.js on Netlify (`docs/flattr-spec.md` §8), but the constraint that
actually shaped the data layer is `docs/flattr-spec.md` §14: the graph work is the *point*
of the project, hand-rolled, no Valhalla/OSRM/GraphHopper. A routing engine or a spatial
DB would have *hidden* the graph behind someone else's index — exactly the thing this
project exists to build by hand.

═════════════════════════════════════════════════
3. GOALS & NON-GOALS
═════════════════════════════════════════════════

**Goals**
- Runtime has zero infrastructure: no server to deploy, no DB to provision, no connection
  to fail. The app opens `graph.json` and routes.
- Traversal reads adjacency in O(1) per neighbor lookup — adjacency *is* the index.
- The expensive work (OSM fetch, elevation sampling, grade computation) happens once at
  build time, not per request.

**Non-goals**
- *Not* a live, continuously-updated map. The data is frozen at build time, on purpose.
- *Not* multi-city at runtime. One bundled graph; a second city is a second build.
- *Not* a query API. There is no "give me edges in this box" endpoint — the only
  operation is "load the whole graph."

> Coach: the non-goals are where you win the scope fight. When someone says "but what
> about live traffic / construction closures / a second city," you point at the non-goal:
> "out of scope by design — v1 is one frozen neighborhood." A non-goal stated up front is
> a closed door; a non-goal you forgot is an open argument.

═════════════════════════════════════════════════
4. THE DECISION
═════════════════════════════════════════════════

Split the system at build time. The pipeline produces an artifact; the app consumes it.
The seam between them is a JSON file on disk — nothing crosses it at runtime.

```
  flattr data layer — build time produces, runtime only reads

  ┌─ BUILD TIME (pipeline/, Node + tsx) ─────────────────────────┐
  │                                                              │
  │  Overpass ──► parseOsm ──► splitWays ──► sampleElevations    │
  │  (OSM)        osm.ts       split.ts      elevation.ts        │
  │                                              │               │
  │                                              ▼               │
  │                                        computeGrades         │
  │                                        grade.ts              │
  │                                              │               │
  │                                              ▼               │
  │                                   buildAdjacency + assemble   │
  │                                   build-graph.ts:29           │
  │                                              │               │
  └──────────────────────────────────────────────┼──────────────┘
                                                  │  writes
                                                  ▼
                                  ┌────────────────────────────┐
                                  │  graph.json  (the artifact) │ ← the seam:
                                  │  nodes · edges · adjacency  │   a frozen file
                                  └────────────────────────────┘
                                                  │  bundled into the app,
                                                  │  loaded ONCE
  ┌─ RUNTIME (mobile/, Expo RN) ─────────────────▼──────────────┐
  │                                                              │
  │  loadGraph() ──► search(graph, …) ──► Path                   │
  │  loadGraph.ts:9   astar.ts:22         (read-only traversal)  │
  │                                                              │
  │  NO write. NO server hop. NO DB query.                       │
  └──────────────────────────────────────────────────────────────┘
```

The artifact's shape is the routing data model itself (`features/routing/types.ts:22`):

```ts
  type Graph = {
    city: string;
    bbox: [number, number, number, number];
    nodes: Record<string, Node>;       // id -> {lat,lng,elevationM} — O(1) lookup
    edges: Edge[];                      // the full edge list
    adjacency: Record<string, string[]>;// nodeId -> incident edgeIds — THE INDEX
  };
```

`adjacency` is the load-bearing field. It's the *only* index the router needs, and it's
precomputed at build time by `buildAdjacency` (`features/routing/graph.ts:22`):

```ts
  // features/routing/graph.ts:22 — runs once at build, baked into graph.json
  export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const e of edges) {
      (adj[e.fromNode] ??= []).push(e.id);   // each edge listed under BOTH endpoints
      (adj[e.toNode] ??= []).push(e.id);     // so neighbor lookup is a map read
    }
    return adj;
  }
```

At runtime the router reads it directly — `graph.adjacency[current]` is the expansion
step (`features/routing/astar.ts:64`). No query planner, no B-tree, no `WHERE` clause.
The data structure a spatial DB would build *for* you is sitting in the JSON, already
built.

> Coach: the sentence that gets the yes is "adjacency is the index." A reviewer who hears
> "no database" worries you'll do linear scans. You don't — the precomputed adjacency map
> gives you the same O(1) neighbor lookup a DB index would, with none of the DB. Say that
> and the worry evaporates.

═════════════════════════════════════════════════
5. ALTERNATIVES CONSIDERED
═════════════════════════════════════════════════

```
  Three ways to hold a routing graph — what each costs

  ┌─ A. routing engine (OSRM / Valhalla) ───────────────────────┐
  │  upload OSM → engine builds contraction hierarchies →        │
  │  query a /route HTTP endpoint                                │
  │  WHY IT LOST: hides the graph behind someone else's index —  │
  │  the exact work §14 says is the point. And it's a server to  │
  │  run. No directional grade cost without forking it.          │
  └──────────────────────────────────────────────────────────────┘
  ┌─ B. spatial DB (PostGIS / pgRouting) ───────────────────────┐
  │  load edges into Postgres, query with SQL + pgRouting        │
  │  WHY IT LOST: a DB indexes for partial queries (find edges   │
  │  in a box, nearest road). flattr never does a partial query  │
  │  — it loads the WHOLE graph and traverses. Paying for an     │
  │  index nobody reads. Plus a DB to provision and a network    │
  │  hop on every route.                                         │
  └──────────────────────────────────────────────────────────────┘
  ┌─ C. build-time JSON artifact (CHOSEN) ──────────────────────┐
  │  pipeline bakes graph.json; app bundles + reads it           │
  │  WHY IT WON: matches the access pattern (read-only whole-    │
  │  graph). Zero runtime infra. Adjacency IS the index. The     │
  │  hand-rolled graph stays visible — the project's whole point.│
  └──────────────────────────────────────────────────────────────┘
```

The deciding factor is the **access pattern**. A database earns its keep when you query
*subsets* — give me rows where X, nearest neighbor to Y. flattr has exactly one query
shape: load everything, traverse. When you always read the whole dataset, an index over
it is dead weight, and a server in front of it is a hop you don't need.

> Coach: don't argue "databases are slow" — they're not, and a reviewer who's run PostGIS
> will eat you alive. Argue access pattern. "A DB indexes for partial queries; we never
> do a partial query." That's a fact about *flattr*, not a claim about databases. It
> can't be countered because it's true of this system specifically.

═════════════════════════════════════════════════
6. TRADEOFFS ACCEPTED
═════════════════════════════════════════════════

We chose the baked artifact, accepting:

- **Frozen data.** The graph reflects the world as of the last `npm run build:graph`. A
  new street, a closed road, a re-paved hill — none of it shows up until you rebuild and
  reship. For a grade map of a stable residential neighborhood, that's fine: hills don't
  move. For live traffic it would be wrong — which is why live traffic is a non-goal.
- **No schema version on the artifact.** `graph.json` carries `city` and `bbox` but no
  format version. If the `Graph` type changes shape, an old bundled file and new code
  drift silently. Today they can't drift — the artifact and the reader ship in the same
  build — but the moment a graph is fetched at runtime instead of bundled, this becomes a
  real hazard. (See Open questions.)
- **Whole-graph in memory.** The app holds the entire graph at once. Fine at neighborhood
  scale; it would not survive a city-sized graph without tiling — which is exactly why
  the on-device viewport/corridor tiling exists (`mobile/src/useTileGraph.ts`).

> Coach: name the frozen-data cost in the same breath as the benefit — "we trade
> freshness for zero infra, and for a grade map that's the right trade because hills are
> stable." Stated together, it's a deliberate engineering call. Stated apart — benefit in
> the pitch, cost dragged out under questioning — it looks like you got caught.

═════════════════════════════════════════════════
7. RISKS & MITIGATIONS
═════════════════════════════════════════════════

```
  Risk                          Mitigation
  ────                          ──────────
  stale graph (world changed)   rebuild + reship; acceptable for a grade
                                map of stable terrain
  graph too big for one bundle  on-device tiling fetches viewport/corridor
                                on demand (useTileGraph.ts) — base graph
                                stays small, the rest streams in
  artifact/reader schema drift  today impossible (same build); add a
                                version field BEFORE any runtime fetch
  build pipeline breaks         pipeline is pure modules with co-located
                                *.test.ts; build is reproducible from OSM
```

═════════════════════════════════════════════════
8. ROLLOUT / MIGRATION
═════════════════════════════════════════════════

This is the current shipped state, so "rollout" is really "how does data move":

- **Producing a graph:** `npm run build:graph` (`pipeline/run-build.ts`) → writes
  `data/graph.json` → copy to `mobile/assets/graph.json` → it bundles into the app
  (`mobile/src/loadGraph.ts:2-3`).
- **What changes for callers:** nothing at runtime. The router (`astar.ts`) takes a
  `Graph` object and doesn't care where it came from — bundled file, on-device tile build,
  or test fixture. That indifference is what lets tiling (`useTileGraph.ts`) merge live
  builds into the base graph without touching the router.
- **Offline fallback:** `graph.sample.json` is a synthetic graph for offline dev
  (`mobile/src/loadGraph.ts:4-5`), not bundled unless imported.

═════════════════════════════════════════════════
9. OPEN QUESTIONS
═════════════════════════════════════════════════

- **When does the artifact need a schema version?** The moment a graph is fetched at
  runtime rather than bundled in the same build, artifact and reader can drift. Adding a
  `version` field to `Graph` is cheap now and impossible to retrofit cleanly later. Worth
  doing before the next storage change.
- **What's the rebuild trigger?** There's no automated "the neighborhood changed, rebuild"
  signal. Today it's manual. At what staleness does that stop being acceptable?
- **Does multi-city change the answer?** One bundled graph is fine. Ten cities the user
  might pick between starts to argue for fetching graphs on demand — which reopens
  versioning and pulls a thin "graph CDN" into scope.

> Coach: open questions are a *strength* in a design doc, not a confession. Listing the
> schema-version hazard before anyone asks signals you see two moves ahead. The reviewer
> who was about to ask "what about versioning?" instead thinks "they've already thought
> about this." That's the staff signal.

─────────────────────────────────────────────────
**See also**
- `study-system-design/01-build-time-graph-artifact.md` — the comprehension walkthrough
- `study-system-design/03-tile-merge-stitch.md` — how tiling extends the base artifact
- RFC 02 — the router that consumes this artifact
- `docs/flattr-spec.md` §4 (data model), §8 (stack), §14 (hand-rolled mandate)
