# flatr — build order (don't drift)

> Single source of truth for *what gets built in what order*. Each plan produces
> working, tested software on its own. Source specs: `docs/flattr-spec.md`,
> `docs/flattr-pqueue-spec.md`. Last set: 2026-06-16.

## Why this order

The spec spans three independent subsystems. We build them in dependency order,
de-risking the hardest *original* work first and the riskiest *external* work
second:

1. **Routing graph core** — the point of the project (spec §14/§15). Zero
   external dependencies; runs on hand-built fixtures. Everything downstream
   reads or calls it, so building it first makes the graph data format
   router-driven rather than pipeline-driven.
2. **Data pipeline** — where the make-or-break accuracy risk lives (§11.A,
   §12). De-risked *second*, once the router can consume and validate output.
3. **Runtime map app** — the visible product; depends on a real graph existing.

## The three plans

| # | Plan | File | Depends on | Status |
|---|---|---|---|---|
| 1 | Routing graph core | `2026-06-16-routing-graph-core.md` | — | written |
| 2 | Data pipeline (OSM → elevation → grade graph) | _(to write)_ | Plan 1 (graph types) | not started |
| 3 | Runtime map app (heatmap → router → honesty/zones) | _(to write)_ | Plans 1 & 2 | not started |

### Plan 1 — routing graph core (scope locked)

Through **stage 5** of the §15.2 progression:

```
pqueue → graph/adjacency → cost → Dijkstra (stage 1) → A* haversine (stage 2)
       → grade A* (stage 3) → directional A* (stage 4) → bidirectional A* (stage 5)
       → benchmark harness
```

Out of scope for Plan 1 (documented stretch, §14.5): contraction hierarchies /
ALT (stage 6), k-alternative routes, zone aggregation. Any real OSM/elevation
data, MapLibre, Netlify — those are Plans 2 and 3.

### Plan 2 — data pipeline (scope sketch)

`osm.ts → split.ts → elevation.ts → grade.ts → build-graph.ts → graph.json`.
Validate grades against AccessMap / clinometer on a known-steep block (Phase 0).

### Plan 3 — runtime map app (scope sketch)

Phase 1 heatmap (`absGradePct`) → Phase 2 router + `userMax` slider → Phase 3
honesty messaging + zone choropleth.

## Decisions (locked for now — change here, not ad hoc)

| Ref | Decision | Choice | Affects |
|---|---|---|---|
| §14 | Build router yourself, no Valhalla/OSRM | **locked** | Plan 1 |
| §11.D | Routing location | Client-side A* over bbox graph (MVP) | Plan 3 |
| §11.E | MVP scope | Single small bbox (commute area) | Plan 2 |
| §11.F | Directed edges | Derive `directedGrade` at traversal (DRY), no materialized reverse edges | Plan 1 |
| §11.G | Steep-descent penalty | Off — downhill always free | Plan 1 |
| §11.A | Elevation source | **Google Elevation API to bootstrap, USGS 3DEP/LIDAR as accuracy target** — build a swap-in seam | Plan 2 |
| §11.B | Map renderer | MapLibre GL (open, no token) | Plan 3 |
| §8 | Target platform | **Web (Next.js) per spec — but REVISIT for a native Android app before Plan 3.** Undecided. Plan 1's routing core is platform-agnostic TS and unaffected either way. | Plan 3 |
| §11.C | Edge-split granularity | 10–15 m in hilly areas | Plan 2 |
| — | Testing | Strict TDD (test-first, bite-sized commits) | all plans |

## Carry-forward to Plan 2 (from Plan 1 final review, 2026-06-16) — RESOLVED

Plan 1 shipped APPROVED (48 tests). Two parked items were fixed before Plan 2
(commit on `main`, 50 tests):

- ~~`edgeById` O(E) linear scan~~ → `search`/`bidirectional` build an
  `indexEdges` `Map<string, Edge>` once; expansion is O(1) per edge.
- ~~`summarizePath`/`edgeBetween` re-resolve by shortest length~~ → reconstruction
  now uses the exact edges the search relaxed (from the `came` maps); `edgeBetween`
  removed. Parallel-edge regression test added.

Net for Plan 2: the engine is safe to feed real, possibly multi-edge graphs.
Remaining nits (non-blocking, do opportunistically): pqueue "matches sorted array"
test asserts priorities not items; a cost test title overstates ("blocks ... finite").

## Drift guardrails

- A change to build order or any locked decision is edited **here first**, with
  a one-line reason, before touching a plan or code.
- A plan is "done" only when its own tests pass on their own (no stubs from a
  later plan). Plan 1 must not depend on real data; Plan 2 must not depend on the
  app.
- Stretch goals (CH/ALT, k-routes, zones) stay parked until all three core plans
  ship — note them, don't sneak them in.
