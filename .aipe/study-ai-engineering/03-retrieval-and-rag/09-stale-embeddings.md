# Stale embeddings — N/A, but flattr DOES have a staleness analog: graph.json

**Industry name(s):** stale embeddings / index freshness drift.
**Type:** Industry standard.

## Zoom out — no embeddings to go stale, but graph.json can absolutely go stale

Stale embeddings are when the source text changes but its vector doesn't,
so retrieval returns the old meaning. flattr has no embeddings — but it
has the *same failure shape* one layer over: `graph.json` is built once
from OSM geometry plus elevation samples, and both sources change over
time. A street gets repaved, a building goes up, the DEM improves — and
flattr's static graph still reflects the world as of the last build. The
mechanism differs (no vectors), but the staleness story is real and
honest.

```
  Zoom out — flattr's real staleness lives in the build artifact

  ┌─ sources (external) ────────────────────────────────────┐
  │  OSM ways  +  elevation DEM   ← these CHANGE over time   │
  └────────────────────────────┬─────────────────────────────┘
                  built ONCE by run-build.ts
  ┌─ artifact (data/graph.json) ▼ ───────────────────────────┐
  │  static graph — frozen at last build  [run-build.ts:48]  │
  │  ★ goes stale exactly like an embedding does (vs source) │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ app (mobile/) ────────────▼─────────────────────────────┐
  │  routes over possibly-stale graph                        │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** external sources (OSM, DEM) → build → `graph.json` → app.
- **Axis — when was the served data last synced to its source?** For an
  embedding: at last embed; if the text changed after, it's stale. For
  flattr: at last `run-build`; if OSM or elevation changed after, the
  graph is stale. Same axis, different artifact.
- **Seam:** the build boundary (`run-build.ts:48`, `writeGraph`). Above
  it, live-ish sources; below it, a frozen snapshot. Freshness is
  decoupled from the world the moment the file is written.

## How it works

### Move 1 — the mental model

You know a cache-invalidation bug: the underlying row changes but the
cached copy doesn't, so reads return stale data until something
invalidates it. Stale embeddings are that bug for vectors — source text
edits, vector doesn't re-embed. flattr's version is that bug for a
*build artifact* — OSM/elevation change, `graph.json` doesn't rebuild.
The artifact is a cache of the world, and like any cache it can drift.

```
  Pattern — served data drifts from its source (same shape, two artifacts)

  embedding:   text "Sequelize" → edited "Drizzle"
               vector still maps to "Sequelize"      ← stale
  flattr:      OSM/DEM updated (new road, repave)
               graph.json still has the old geometry  ← stale
               (no embeddings — but the same drift)
```

### Move 2 — the walkthrough

**Where flattr's snapshot freezes.** `run-build.ts:48`:

```ts
mkdirSync("data", { recursive: true });
writeGraph(graph, "data/graph.json");   // snapshot of OSM+elevation, frozen here
```

After this line, the graph is a static file. The app reads it directly;
nothing re-checks OSM or the DEM at runtime. So the freshness of every
route is the freshness of the last build. That's a genuine staleness
surface — just not an embedding one.

**The honest boundary — don't overclaim.** This is *not* stale
embeddings. There's no vector, no re-embed pass, no `embedding_stale_at`
column. It's stale *graph data*: a frozen geometry+elevation snapshot.
The fix shape rhymes (track when the source changed, rebuild), but the
mechanism is a build-pipeline rerun, not a re-embedding. Calling it "stale
embeddings" would be inventing a vector layer flattr doesn't have.

```
  Layers-and-hops — staleness enters at the build snapshot

  ┌─ sources ─┐ hop1: OSM + DEM    ┌─ run-build.ts ────────┐
  │OSM / DEM  │ ──────────────────►│ build → freeze graph  │ run-build.ts:48
  └───────────┘                    └──────────┬─────────────┘
                  hop2: graph.json (frozen)    │
  ┌─ app ─────┐ ◄────────────────────────────────┘
  │MapScreen  │  routes over the snapshot — stale if sources moved
  └───────────┘
```

### Move 3 — the principle

Any system that *materializes* a view of a changing source can serve stale
data — embeddings of edited text, a cache of an updated row, or flattr's
graph snapshot of updated OSM. The defense is always the same: know when
the source last changed and have a path to refresh the materialized copy.
flattr's refresh path is a full rebuild (see
[incremental indexing](10-incremental-indexing.md)). The principle:
materialized views need a freshness story, whatever the artifact —
embeddings are just the most famous case.

## Primary diagram

```
  flattr's staleness analog — frozen graph vs live sources

  ┌─ external sources (CHANGE) ──────────────────────────────┐
  │ OSM ways  ·  elevation DEM                                │
  └────────────────────────────┬─────────────────────────────┘
              snapshot at build (run-build.ts:48)
  ┌─ data/graph.json (FROZEN) ─▼─────────────────────────────┐
  │ static graph — drifts from sources after build           │
  │ NOT an embedding · same freshness failure shape          │
  └────────────────────────────┬─────────────────────────────┘
              served as-is
  ┌─ app ──────────────────────▼─────────────────────────────┐
  │ routes over the (possibly stale) snapshot                │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Stale embeddings are a top RAG production bug — the retrieval "succeeds"
but returns the old meaning, which is worse than failing loudly. You'd
guard against it in **AdvntrCue** with staleness tracking on the corpus.
flattr has the same *class* of problem (a materialized view drifting from
its source) in a non-AI form: `graph.json` vs live OSM/elevation. The
transferable instinct is recognizing the freshness failure shape across
artifacts — and being precise that flattr's is stale *graph data*, not
stale embeddings.

## Project exercises

### B-STALE.1 — record build provenance on graph.json

- **Exercise ID:** B-STALE.1
- **What to build:** stamp `graph.json` with `builtAt` and the OSM/DEM
  source versions at build time, so the app can surface "map data as of
  <date>" and a rebuild can be triggered on drift.
- **Why it earns its place:** it makes the (real) staleness surface
  observable — the freshness-tracking discipline, applied to flattr's
  actual artifact.
- **Files to touch:** `pipeline/run-build.ts:48` (write provenance);
  `features/routing/types.ts` (add the field to `Graph`).
- **Done when:** the graph carries a build timestamp and the app can read
  it.
- **Estimated effort:** an hour.

## Interview defense

**Q: Does flattr have a stale-embeddings problem?** Answer: not embeddings
— it has no vectors. But it has the same *freshness failure shape* in its
build artifact: `graph.json` is frozen at `run-build` (`run-build.ts:48`),
while its sources (OSM, the elevation DEM) keep changing. So routes can be
served over stale *graph data*. The fix rhymes — track when sources
changed, rebuild — but it's a pipeline rerun, not a re-embed.
Load-bearing precision: it's stale graph data, not stale embeddings.

```
  OSM/DEM change → graph.json unchanged = stale data (not stale vectors)
```

Anchor: *"flattr's staleness is a frozen graph snapshot drifting from live
OSM — same freshness shape as stale embeddings, no vectors involved."*

## See also

- [10-incremental-indexing.md](10-incremental-indexing.md) — the rebuild strategy that refreshes the snapshot.
- [01-embeddings.md](01-embeddings.md) — why this isn't literally stale embeddings.
- [04-vector-databases.md](04-vector-databases.md) — the static graph store that goes stale.
