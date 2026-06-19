# 02 — Bundled Graph Artifact

*Industry names: immutable build artifact · embedded read-only dataset · "ship
the data with the binary." Type: Industry standard.*

---

## Zoom out, then zoom in

You've shipped a `data.json` of seed content inside an app bundle before — copy
detected, imported at startup, never written back. flattr does that with its
*entire data layer*: a 544 KB `graph.json` that is the city, the streets, the
grades, all of it, frozen into the app package.

Here's where it sits — it's the seam between the two phases, and it's the *only*
persistent state in the system:

```
  Zoom out — the artifact is the whole data layer

  ┌─ BUILD TIME ─────────────────────────────────────────────┐
  │  pipeline DAG ──► writeFileSync ──► data/graph.json       │
  └────────────────────────────────────┬──────────────────────┘
                                        │  manual copy
  ┌─ APP BUNDLE ────────────────────────▼──────────────────────┐
  │  ★ mobile/assets/graph.json ★   (544 KB, immutable)        │ ← we are here
  └────────────────────────────────────┬──────────────────────┘
                                        │  import at startup
  ┌─ RUN TIME ──────────────────────────▼──────────────────────┐
  │  loadGraph() → Graph → heatmap · router · zones            │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is an **immutable, embedded, regenerable dataset**. The
question it answers is *"where does the data live and what guarantees does it
need?"* The answer is unusual: it lives *inside the app*, it's *never written*,
and its durability guarantee is "whatever the app package gives you" — because
if you lose it, you rebuild it from source. No backup, no migration, no
consistency protocol. → it's the seam introduced in `01-build-time-runtime-split.md`,
studied here as a thing in itself.

---

## Structure pass

**Layers.** Trace one file through three forms:

```
  data/graph.json            — the build output (on the dev machine)
  mobile/assets/graph.json   — the bundled copy (in the app package)
  the in-memory Graph        — what loadGraph returns (per session)
```

**Axis — state mutability (can this change, and who can change it?).**

| Form | Mutable at runtime? | Who writes it? |
|---|---|---|
| `data/graph.json` | n/a | the build pipeline, once |
| `mobile/assets/graph.json` | **no** | the developer (manual copy) |
| in-memory `Graph` | **no** (treated read-only) | nobody — pure reads downstream |

The answer is "no" all the way down at runtime. That uniformity *is* the
property: there is no write path anywhere below the build step, so there's
nothing to lock, version, or reconcile.

**Seams.** Two, and both are weak points worth naming:

- The **build→`data/`** seam is a `writeFileSync` — clean, single, the only
  durable write in the system (`run-build.ts:11-13`).
- The **`data/`→bundle** seam is a **manual file copy** with no version stamp
  (`loadGraph.ts:2-3` comment). The state axis doesn't flip here (immutable both
  sides), but *correctness* can: nothing guarantees the bundled copy matches the
  engine reading it. → audit §8.2.

---

## How it works

### Move 1 — the mental model

The shape is a value, not a service. You know the difference between calling an
API for data versus importing a constant — the constant is just *there*, no
round-trip, no failure mode, no staleness within the process. The bundled graph
is that constant, scaled up to 544 KB. The runtime treats it the way your code
treats an imported config object: read it, derive from it, never assign to it.

```
  Pattern — data as an embedded constant

   import graph from "graph.json"   ──►   Graph (read-only value)
                                              │
              ┌───────────────────────────────┼───────────────────────────┐
              ▼                                ▼                           ▼
        heatmap colors                  snapped node ids              A* route
        (derive)                        (derive)                      (derive)

        no fetch · no write-back · no cache invalidation · just a value
```

### Move 2 — the walkthrough

#### Where the artifact is born

The artifact is the terminal node of the build DAG. `buildGraph` returns a
`Graph` object in memory; `run-build.ts` serializes it with `JSON.stringify` and
writes it once. That write is special: it's the *only* place in the entire
codebase that persists durable state.

```
  Pattern — one write, then frozen

  buildGraph(...) ──► Graph (in memory) ──► JSON.stringify ──► writeFileSync
                                                                    │
                                                          data/graph.json
                                                          (never written again)
```

The boundary case: the write is unconditional and unversioned. Run the build
twice and you overwrite. There's no append, no history, no "graph_v2.json." For
immutable regenerable data that's correct — the file *is* a cache of the build,
and a cache you can always rebuild needs no history.

#### How it crosses into the bundle

This hop is the one to watch. `data/graph.json` doesn't automatically become
`mobile/assets/graph.json` — a human copies it. The two files are byte-identical
(both 544 KB) precisely because the copy is literal.

```
  Layers-and-hops — the manual crossing

  ┌─ DEV MACHINE ────────┐                       ┌─ APP BUNDLE ────────────┐
  │ data/graph.json      │  hop: manual cp (you) │ mobile/assets/graph.json│
  │ (build output)       │ ────────────────────► │ (shipped in the binary) │
  └──────────────────────┘                       └─────────────────────────┘
        │                                                    │
        └── no version stamp, no hash, no automation ────────┘
            ⇒ drift is possible and silent (audit §8.2)
```

Why is this a hop worth a diagram? Because it's the system's most fragile seam
and the most invisible. Everything else has a type checker or a test behind it;
this has a developer's memory.

#### How the runtime consumes it

The consumer side is two lines. Import the JSON, cast to `Graph`, return it.
Then `MapScreen` wraps it once with `prefixGraph(.., "base")` to namespace its
ids (so later merges don't collide — see `04-tile-merge-stitch.md`) and hands it
to `useTileGraph`. From there it's pure derivation.

```
  Pattern — read once, derive forever

  graph.json ─► loadGraph ─► prefixGraph("base") ─► baseGraph
                                                       │
                                          useTileGraph holds it; everything
                                          downstream is a useMemo over it
```

The boundary case worth stating: the cast `as unknown as Graph`
(`loadGraph.ts:10`) means there's **zero runtime validation**. If the bundled
JSON is malformed or stale-shaped, the failure surfaces deep in the router or
the renderer, not at load. The single guard is the `try/catch` in `MapScreen`
that falls back to `null` and shows "Failed to load graph."

### Move 3 — the principle

When your data is immutable and regenerable, ship it as a value, not behind a
service. The durability problem dissolves — you don't protect what you can
rebuild — and the runtime gets the cheapest possible read (an import, not a
fetch). The price you pay is a freshness/version boundary: an embedded artifact
only updates when you re-embed and re-ship it, so guard the embed step or it
drifts.

---

## Primary diagram

The artifact's whole life, one frame.

```
  Bundled graph artifact — full lifecycle

  ┌─ BUILD ──────────────────────────────────────────────────────┐
  │ buildGraph → Graph (memory) → JSON.stringify → writeFileSync  │
  │                                          │                    │
  │                                  data/graph.json (544 KB)     │
  └──────────────────────────────────────────┼───────────────────┘
                                              │ ✋ manual copy
                                              │    (no version stamp)
  ┌─ BUNDLE ───────────────────────────────────▼─────────────────┐
  │ mobile/assets/graph.json  ── shipped inside the app binary    │
  └──────────────────────────────────────────┼───────────────────┘
                                              │ import + cast (no validation)
  ┌─ RUNTIME ──────────────────────────────────▼─────────────────┐
  │ loadGraph → prefixGraph("base") → baseGraph                   │
  │      ├─ graphToGeoJSON  → heatmap                             │
  │      ├─ computeZones    → choropleth                          │
  │      └─ directedAstar   → route        (all pure reads)       │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The bundled artifact is what makes flattr work offline: open the
app on the subway with no signal and the Capitol Hill bbox still renders and
routes, because the data is in the binary, not behind a network call. It's also
what makes the demo bulletproof — no API to be down during a portfolio walkthrough
for the bundled area.

**The single write — `pipeline/run-build.ts` (lines 11-13, 47-51).**

```
  function writeGraph(graph: Graph, path: string): void {
    writeFileSync(path, JSON.stringify(graph));     ← the ONLY durable write
  }
  ...
  mkdirSync("data", { recursive: true });
  writeGraph(graph, "data/graph.json");
  console.log(`Wrote data/graph.json: ${nodes} nodes, ${edges} edges.`);
       │
       └─ no version field, no hash. The artifact is content-addressed only by
          "whatever the last build produced." Rebuild = overwrite.
```

**The manual-copy seam — `mobile/src/loadGraph.ts` (lines 1-11).**

```
  // graph.json is the REAL build artifact (Capitol Hill via Overpass + Open-Meteo);
  // regenerate with `npm run build:graph` then copy data/graph.json here.   ← the seam, in a comment
  import graph from "../assets/graph.json";
  export function loadGraph(): Graph {
    return graph as unknown as Graph;     ← cast, no validation
  }
       │
       └─ the contract that keeps the two files in sync is a code COMMENT and a
          developer's discipline. That's the fragility audit §8.2 names.
```

Confirmed identical on disk: `data/graph.json` and `mobile/assets/graph.json`
are both 544313 bytes.

**The one wrap before use — `mobile/src/MapScreen.tsx` (lines 28-34).**

```
  const baseGraph = useMemo(() => {
    try {
      return prefixGraph(loadGraph(), "base");   ← namespace ids for safe merges
    } catch {
      return null;                               ← the ONLY load-failure guard
    }
  }, []);
       │
       └─ prefixGraph here is what lets the immutable base graph coexist with
          the mutable viewport/corridor graphs without id collisions (file 04).
```

---

## Elaborate

Embedding a read-only dataset in the binary is the same instinct as a SQLite
database shipped inside a mobile app, or a model checkpoint bundled with an
inference app, or seed data baked into a Docker image. The trade is always the
same: you gain zero-latency, offline-capable, failure-free reads, and you pay in
update friction — the data only changes when you ship a new binary.

flattr leans hard into the gain side because its data genuinely is static (OSM +
terrain) and its scope is one small bbox. The friction side is exactly why the
spec wants Netlify Blobs for the multi-city future (§8): at city scale you can't
re-ship the binary every time you re-grade a neighborhood, so the data has to
move out of the bundle and behind a fetch. The router doesn't care either way —
see `01-build-time-runtime-split.md` Move 2.5.

The one thing this repo gets *slightly* wrong is the missing version stamp. A
one-line content hash written into the `Graph` (e.g. `buildHash`) and asserted
at load would turn the silent-drift failure into a loud one for the cost of a
few lines. It's the cheapest reliability win available and it isn't taken yet.

Read next: `03-on-device-pipeline.md` — the runtime doesn't *only* read this
artifact; it builds *more* graph on the fly and merges it in.

---

## Interview defense

**Q: 544 KB in the bundle — why is that OK, and when isn't it?**
> It's fine because it's one small bbox and it buys offline, zero-latency reads —
> the app works with no signal and the demo can't be broken by a flaky API. It
> stops being fine at city scale: a full-city graph is too big to bundle and
> can't be updated without an app release. That's the trigger to move the data
> out to fetched tiles, which the spec already designs for.

```
  small bbox: bundle it  ──►  offline + instant
  city scale: fetch it   ──►  no re-ship to update
              ▲
              └─ the size + freshness pressure is the migration trigger
```

**Q: There's no validation on load. What breaks?**
> `loadGraph` casts `as unknown as Graph` with no schema check, and the file is
> copied into the bundle by hand with no version stamp. If the bundled graph is
> stale-shaped relative to the engine, the failure surfaces deep in the router or
> renderer, not at load. The single guard is a try/catch in `MapScreen` that
> shows "Failed to load graph." The fix I'd take first is a build hash in the
> `Graph`, asserted at load — turns silent drift into a loud error.

```
  graph.json ─► cast (no check) ─► fails LATE, not at load
                       fix: embed buildHash, assert on load
```

---

## Validate

1. **Reconstruct.** Trace `graph.json` through its three forms (build output →
   bundled copy → in-memory) and mark which is mutable (none, at runtime).
2. **Explain.** Why is the cast in `loadGraph.ts:10` a risk, and what's the
   single load-time guard (`MapScreen.tsx:28-34`)?
3. **Apply.** You re-run `npm run build:graph` but forget to copy `data/` into
   `mobile/assets/`. What does the user see, and which line is responsible
   (`loadGraph.ts:7`)?
4. **Defend.** Justify shipping 544 KB of data in the binary instead of fetching
   it, then name the exact size/freshness pressure that flips the decision
   (`audit.md` §7).

---

## See also

- `01-build-time-runtime-split.md` — why the artifact exists at all.
- `03-on-device-pipeline.md` — the runtime builds *more* graph than this.
- `04-tile-merge-stitch.md` — `prefixGraph` namespacing this base graph.
- `audit.md` §5 (storage), §8.2 (the manual-copy red flag).
- `.aipe/study-data-modeling/` — the `Graph` / `Node` / `Edge` schema.
