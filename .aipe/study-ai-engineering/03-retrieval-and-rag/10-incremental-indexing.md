# Incremental indexing — flattr full-rebuilds graph.json; here's the tradeoff

**Industry name(s):** incremental indexing vs full rebuild.
**Type:** Industry standard.

## Zoom out — no index to incrementally update, but flattr's rebuild choice is the same fork

Incremental indexing is the choice between rebuilding an entire search
index from scratch versus embedding only the changed deltas and merging
them in. flattr has no embedding index — but it makes the exact same fork
for its graph artifact, and it picks **full rebuild**: `run-build.ts`
fetches all of OSM for the bounding box, re-samples elevation, and writes
a brand-new `graph.json` every time. The concept is N/A as embeddings,
but the rebuild-vs-incremental tradeoff is live and decided.

```
  Zoom out — flattr's rebuild is a full rebuild, every time

  ┌─ sources (external) ────────────────────────────────────┐
  │  OSM (whole bbox)  +  elevation (all samples)           │
  └────────────────────────────┬─────────────────────────────┘
                  full rebuild — never incremental
  ┌─ build (pipeline/) ────────▼─────────────────────────────┐
  │  fetchOverpass(BBOX) → buildGraph → graph.json           │ run-build.ts:43-48
  │  ★ rewrites the ENTIRE artifact; no delta merge          │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** sources → build → `graph.json` → app.
- **Axis — does a rebuild touch everything or just the deltas?** Full
  rebuild: recompute the whole artifact (simple, correct, expensive).
  Incremental: recompute only what changed (fast, complex, edge cases).
  flattr sits firmly on *full rebuild*. Trace that axis and the choice is
  unambiguous.
- **Seam:** `run-build.ts:43–48` — the whole build runs as one batch over
  the entire bbox. There is no change-tracking seam where deltas could
  enter.

## How it works

### Move 1 — the mental model

You know the two ways to keep a derived artifact current: blow it away and
regenerate it (a clean `npm run build`), or track what changed and patch
just those parts (a watch-mode incremental build). Full rebuild is dead
simple and always correct but does redundant work; incremental is fast but
has to get change-tracking and merge consistency right. flattr chose the
first — every build regenerates the whole graph.

```
  Pattern — full rebuild vs incremental (flattr picks full)

  full rebuild:   ALL sources → rebuild whole artifact → swap
                  simple · correct · expensive            ← flattr
  incremental:    track changes → process deltas → merge into artifact
                  fast · complex · consistency edge cases
```

### Move 2 — the walkthrough

**flattr's full rebuild, in three lines.** `run-build.ts:43–48`:

```ts
const osm = await fetchOverpass(BBOX);                 // ALL ways in the bbox
const graph = await buildGraph("seattle-mvp", BBOX, osm, provider, maxSegM, sampleOpts);
mkdirSync("data", { recursive: true });
writeGraph(graph, "data/graph.json");                  // whole artifact, fresh
```

Every run fetches the entire bounding box from Overpass, re-samples
elevation for every segment, and writes a complete new `graph.json`.
Nothing is reused from the previous build; there's no "which edges
changed since last time" bookkeeping. It's the full-rebuild branch,
exactly.

```
  Layers-and-hops — full rebuild batch (no delta path)

  ┌─ sources ─┐ hop1: whole bbox   ┌─ run-build.ts ────────┐
  │Overpass   │ ──────────────────►│ buildGraph (all)      │ run-build.ts:43
  │+ DEM      │                    │ → writeGraph (all)     │ run-build.ts:48
  └───────────┘                    └──────────┬─────────────┘
                  hop2: NEW graph.json ◄────────┘ (replaces old wholesale)
```

**Why full rebuild is the right call here — and its boundary.** The bbox
is one city (`seattle-mvp`), so the artifact is small and a full rebuild
is cheap and always consistent. Incremental indexing earns its place only
when the corpus is large *and* freshness must be near-real-time — neither
true for flattr. The boundary: full rebuild's cost scales with corpus
size, so if flattr expanded to many cities and needed frequent refresh,
*then* incremental (rebuild only changed tiles) would start paying off.
Until then, incremental's consistency edge cases would be complexity for
no benefit.

### Move 3 — the principle

Full rebuild and incremental are a simplicity-vs-freshness tradeoff: full
is always correct but does redundant work; incremental is fast but owns
hard merge-consistency problems. The right pick is set by corpus size and
freshness need, not by sophistication. flattr is small and batch-built, so
full rebuild wins decisively. The principle: don't pay incremental's
complexity tax until the corpus is big enough and the freshness need is
tight enough to justify it.

## Primary diagram

```
  flattr's rebuild fork — full rebuild, decided

  ┌─ build (pipeline/) ──────────────────────────────────────┐
  │ fetchOverpass(BBOX) → buildGraph → graph.json             │
  │ [run-build.ts:43–48]  ·  rewrites WHOLE artifact          │
  └────────────────────────────┬─────────────────────────────┘
       full rebuild: simple, correct, cheap at city scale
       incremental (NOT BUILT): would only pay off at many-city
                                scale with tight freshness needs
```

## Elaborate

The rebuild-vs-incremental fork shows up wherever you maintain a derived
artifact — search indexes, embedding stores, build outputs. You'd face it
in **AdvntrCue** deciding whether to re-embed the whole corpus nightly or
patch deltas. flattr makes the same decision for `graph.json` and lands on
full rebuild because it's small and batch-oriented. The transferable
judgment is the trigger for switching: incremental is earned by *scale ×
freshness*, and flattr clears neither threshold yet.

## Project exercises

### B-INC.1 — tile-scoped incremental rebuild (only if flattr scales)

- **Exercise ID:** B-INC.1
- **What to build:** split the bbox into tiles and rebuild only tiles
  whose OSM/elevation changed, merging into `graph.json` — the
  incremental branch, gated behind a multi-city expansion.
- **Why it earns its place:** it makes the rebuild-vs-incremental tradeoff
  concrete and forces the merge-consistency edge cases into view.
- **Files to touch:** `pipeline/run-build.ts:43–48`;
  `pipeline/build-graph.ts`; `pipeline/config.ts` (tile the `BBOX`).
- **Done when:** changing one tile's source rebuilds only that tile and
  merges it without recomputing the rest.
- **Estimated effort:** two to three days (the consistency edge cases are
  the work).

## Interview defense

**Q: Does flattr index incrementally or full-rebuild?** Answer: full
rebuild. `run-build.ts:43–48` fetches the whole bbox from Overpass,
re-samples all elevation, and writes a complete new `graph.json` every
run — no delta tracking, no merge. That's the right call at city scale:
the artifact is small, so full rebuild is cheap and always consistent.
Incremental is earned by *scale × freshness*, and flattr clears neither
threshold. Load-bearing point: incremental's complexity tax (merge
consistency) only pays off once the corpus is big and refresh is frequent.

```
  whole bbox → rebuild whole graph.json = full rebuild (correct, cheap here)
```

Anchor: *"flattr full-rebuilds graph.json because it's small — incremental
would buy nothing but merge-consistency bugs until it scales to many
cities."*

## See also

- [09-stale-embeddings.md](09-stale-embeddings.md) — the staleness the rebuild fixes.
- [04-vector-databases.md](04-vector-databases.md) — the static graph store being rebuilt.
- [03-chunking-strategies.md](03-chunking-strategies.md) — the edge-splitting step inside the build.
