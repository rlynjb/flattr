# Study — System Design (applied): flattr

A per-repo system-design guide for **flattr** — a hand-rolled, grade-aware A\*
routing engine in TypeScript. No framework on the core, no live backend, no DB.
The architecture's defining move is a **build-time vs runtime split**: a heavy
offline pipeline turns OSM + elevation into a static `graph.json`, and a thin
Expo/React Native runtime reads it and runs A\* locally.

This guide is **audit-style** (two passes):

- **Pass 1 — `audit.md`** walks the 8 system-design lenses against the real
  code, with `file:line` grounding and honest `not yet exercised` calls.
- **Pass 2 — the numbered pattern files** each teach one load-bearing
  architectural pattern this repo actually exercises.

## Reading order

1. **`00-overview.md`** — the whole system in one diagram. Read this first; if
   you read nothing else, read this.
2. **`audit.md`** — the 8-lens audit. The map of what's here and what isn't.
3. **`01-build-time-runtime-split.md`** — the defining architectural move, and
   the most important finding in the repo: the split is real *as designed* but
   **leaks at runtime** as built. Read this before the others.
4. **`02-bundled-graph-artifact.md`** — the immutable static artifact as the
   single source of truth.
5. **`03-on-device-pipeline.md`** — the runtime *runs the build pipeline* to
   cover the viewport and route corridor. This is where the clean split breaks.
6. **`04-tile-merge-stitch.md`** — prefix / merge / stitch: how independently
   built graph regions get composed into one routable graph.
7. **`05-honest-fallback-routing.md`** — `BLOCKED`-as-finite: the three graph
   states (flat / steep-but-routable / disconnected) surfaced honestly.
8. **`06-elevation-provider-fallback.md`** — the provider abstraction and
   best-effort degradation to flat (0 m) elevation.

## Cross-links to neighboring foundation guides

This guide owns **architectural boundaries and tradeoffs only**. Mechanism-level
depth lives in its sibling guides:

- **`.aipe/study-dsa-foundations/`** — the A\* / Dijkstra / bidirectional search
  internals, the binary-heap priority queue, graph adjacency representation. The
  algorithm *is* this project; this guide treats the router as one component and
  points there for the search mechanics.
- **`.aipe/study-data-modeling/`** — the `Node` / `Edge` / `Graph` schema shape,
  signed-vs-absolute grade, why edges are stored once and direction derived.
- **`.aipe/study-performance-engineering/`** — the bench harness
  (`bench/run.ts`), nodes-expanded metrics, graph download size, on-device build
  latency.
- **`.aipe/study-networking/`** — Overpass / Open-Meteo / Nominatim HTTP
  behavior: retries, rate-limit backoff, the `fetchImpl` injection seam.
- **`.aipe/study-frontend-engineering/`** — the MapLibre render layer, the
  React state in `MapScreen.tsx`, debounced effects, the GeoJSON source/layer
  remount-on-toggle quirk.

## The honest framing

The spec (`docs/flattr-spec.md` §5, §8) describes a **Next.js + MapLibre GL JS
on Netlify** target with the graph served from **Netlify Blobs** and optional
**server-side A\***. None of that is built. The built system is **Expo RN with a
bundled `graph.json`** and **client-side A\***. Wherever the spec proposes
infrastructure the repo doesn't have, the audit says `not yet exercised` and
names the as-designed-vs-as-built gap precisely. That gap is itself a teaching
artifact — see `01-build-time-runtime-split.md` Move 2.5.
