# Project context — flatr (flattr)

> Placeholder scaffolded by `/aipe:study`. Edit this, then re-run `/aipe:study`.
> Everything below is inferred from the repo on 2026-06-19; correct anything wrong
> and delete the hedges once verified.

## One-liner

Grade-aware routing for self-powered travel ("optimized for flat, not fast"):
a hand-rolled A* router over a grade-annotated street graph, plus a grade
heatmap. Everything keys off one user knob, `userMax` (max comfortable uphill
grade). See `docs/flattr-spec.md` for the full product/design spec.

## Stack (as built — diverges from the spec)

The spec (`docs/flattr-spec.md` §8) proposes **Next.js + MapLibre GL JS on
Netlify**. The repo as it actually stands is:

- **Core engine** — TypeScript (strict, ESM), no framework. Pure modules under
  `features/`, `pipeline/`, `lib/`.
- **Tests** — Vitest (`vitest.config.ts`); test files co-located as `*.test.ts`.
- **Build/run tooling** — `tsx` for scripts; `tsc --noEmit` for typecheck.
- **Frontend** — `mobile/` is an **Expo / React Native** app (Expo ~56, RN
  0.85, React 19), rendering with `@maplibre/maplibre-react-native`. NOT the
  Next.js web app the spec describes. Treat `mobile/AGENTS.md` as binding: read
  the versioned Expo v56 docs before touching mobile code.
- **No live backend / DB.** Graph is a prebuilt static artifact
  (`mobile/assets/graph.json`); the app only reads it.

## Layout

- `features/routing/` — `[GRAPH]` the centerpiece: `graph.ts` (adjacency +
  directed traversal), `astar.ts`, `bidirectional.ts`, `pqueue.ts` (hand-rolled
  binary heap), `cost.ts` (signed directed-grade penalty), `nearest.ts`,
  `summary.ts`, `fixtures.ts`, `types.ts`.
- `features/grade/` — `classify.ts` (signed grade → band → color),
  `zones.ts` (per-edge grade → grid cells).
- `features/map/` — `geojson.ts`, `tiles.ts` (tiling / GeoJSON shaping).
- `pipeline/` — BUILD-TIME ONLY: `osm.ts`, `overpass.ts`, `elevation.ts`,
  `geocode.ts`, `split.ts`, `grade.ts`, `build-graph.ts`, `run-build.ts`,
  `config.ts`, `types.ts`. Turns OSM + elevation into `graph.json`.
- `lib/geo.ts` — haversine, bbox, polyline math.
- `bench/` — benchmark harness (`run.ts`, `report.ts`) for the algorithm
  progression (Dijkstra → A* → directional → bidirectional).
- `mobile/src/` — Expo app: `MapScreen.tsx`, `AddressBar.tsx`, `GradeSlider.tsx`,
  `Legend.tsx`, `RouteSummaryCard.tsx`, `loadGraph.ts`, `useTileGraph.ts`.
  `mobile/scripts/sync-engine.mjs` appears to sync the core engine into mobile.

## Data model (canonical)

Grade-annotated graph: `Node {id, lat, lng, elevationM}` and
`Edge {id, fromNode, toNode, geometry, lengthM, riseM, gradePct (signed
from→to), absGradePct, kind?}`, with `adjacency: nodeId -> edgeIds`. Grade is
signed by travel direction (`directedGrade`); routing/route-coloring use the
signed grade, the overview heatmap uses `absGradePct`. Full schema in
`docs/flattr-spec.md` §4.

## Commands

- `npm test` → `vitest run`
- `npm run typecheck` → `tsc --noEmit`
- `npm run bench` → `tsx bench/run.ts`
- `npm run build:graph` → `tsx pipeline/run-build.ts`
- mobile: `cd mobile && npm start` (Expo)

## Must-not-change constraints

- **Hand-rolled graph + router only** — no Valhalla/OSRM/GraphHopper. The graph
  work is the point of the project (`docs/flattr-spec.md` §14).
- **Commit directly to `main`** — no feature branches/worktrees (user memory).
- **A\* heuristic must stay admissible** — haversine lower bound; penalty ≥ 0.
- **`BLOCKED` is large-finite, not Infinity** — so "no flat route" (steep
  flagged) stays distinct from "no route" (disconnected). See spec §14.4.
- Mobile: honor `mobile/AGENTS.md` (versioned Expo v56 docs before coding).

## External-data caveat

Open-Meteo free elevation API 429s when quota is exhausted by heavy testing —
check `curl` before debugging the pipeline (user memory).
