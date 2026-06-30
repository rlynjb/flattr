# Study — System Design · flattr

Grade-aware routing for self-powered travel ("optimized for flat, not fast").
This guide reads flattr as a **system**: where data, state, and work live; how
they move; what happens when a boundary fails; and what changes at scale.

The defining architecture is a **build-time / runtime split**. A pipeline
(`overpass → split → elevation → grade → build-graph → run-build`) turns OSM +
elevation into a static `graph.json`, which is bundled into the app. At runtime
the app reads that graph, re-runs the *same pipeline* on-device for areas beyond
the bundled base, and routes over a hand-rolled A* engine. There is **no backend
and no database** — the graph artifact is the whole storage story.

## Reading order

1. `00-overview.md` — one diagram of the whole system + a legend. Skim this and
   you have the map.
2. `audit.md` — the 8-lens system-design audit. Every lens walked, grounded in
   `file:line`, with `not yet exercised` named honestly where the repo doesn't
   reach a topic.
3. The discovered-pattern files (below) — the architecture worth learning,
   one file per load-bearing pattern, each in the full concept format.

## Discovered patterns (Pass 2)

| File | Pattern | What it buys |
| --- | --- | --- |
| `01-build-time-graph-artifact.md` | build-time graph artifact | the whole storage layer collapses into one prebuilt JSON; no server, no DB, instant cold start |
| `02-on-device-pipeline-rerun.md` | on-device pipeline rerun | coverage beyond the bundled base — the same pipeline that built the artifact runs on the phone |
| `03-tile-merge-stitch.md` | tile merge + stitch | independently-built regions become one connected routable graph (prefix ids → merge → stitch coincident nodes) |
| `04-honest-fallback-routing.md` | honest fallback routing | "no flat route" stays distinct from "no route at all"; the UI never lies about grade quality |
| `05-elevation-provider-fallback.md` | elevation provider fallback + cache | the build survives a throttled/down elevation API; revisited areas cost zero requests and self-heal |
| `06-parametric-search-engine.md` | parametric search engine | one `search()` is Dijkstra, A*, grade-A*, and directional-A* by swapping `(costFn, heuristicFn)` |

## Cross-links to neighboring guides

System-design owns architectural boundaries and tradeoffs. Mechanism-level
teaching lives in the owning foundation guide:

- **`study-database-systems`** — durability/serialization of the artifact; flattr
  has no storage engine, so most of that guide's lenses don't apply here.
- **`study-data-modeling`** — the `Node`/`Edge`/`Graph` schema shape
  (`features/routing/types.ts`).
- **`study-dsa-foundations`** — the A* search, the binary-heap `PQueue`, BFS/graph
  traversal mechanics. This guide treats `search()` as an *architectural seam*; the
  algorithm internals belong there.
- **`study-distributed-systems`** — coordination correctness. flattr has no
  multi-node coordination (single device + stateless third-party APIs), so this is
  mostly `not yet exercised`; see `audit.md` lens 6.
- **`study-runtime-systems`** — the on-device async pump, debounce, single-flight
  build queue in `useTileGraph.ts`.
- **`study-networking`** — Overpass/Open-Meteo/Nominatim HTTP, retry/backoff, rate
  limits on the wire.
- **`study-performance-engineering`** — the 90m-DEM dedup, the `MAX_LOAD_SPAN_DEG`
  gates, the elevation cache as a latency/cost optimization.

## Anchoring

Every claim ties to a real `file:line`. Inferred production/scale behavior is
labeled **[inference]**. No invented services, no invented scale.
</content>
</invoke>
