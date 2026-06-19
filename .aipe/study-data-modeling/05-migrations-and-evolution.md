# Migrations and evolution

**Industry names:** schema versioning · artifact format version · forward/
backward compatibility · the missing migration path. **Type:** language-agnostic
principle; flattr's (absent) versioning is project-specific.

---

## Zoom out, then zoom in

Migrations are the question "what happens when the schema changes but the data
that's already out there was written in the old shape?" In a database you run a
migration script. flattr's "data that's already out there" is a `graph.json`
file bundled into shipped app binaries — and the finding is that there's no
mechanism to tell an old artifact from a new one. Here's where the artifact
flows and where a version would gate it.

```
  Zoom out — where an old artifact can outlive a schema change

  ┌─ Build (writes the artifact) ───────────────────────────────┐
  │  run-build.ts → writeGraph(graph) = JSON.stringify(graph)    │ ← no version
  │                 to data/graph.json                            │   written
  └───────────────────────────────┬─────────────────────────────┘
                                   │  copied into mobile/assets/, BUNDLED
                                   │  into the shipped app binary
  ┌─ Runtime (reads it, maybe months later) ───────▼────────────┐
  │  loadGraph(): graph as unknown as Graph   ← no version CHECK │ ← gap here
  │  a binary shipped in v1.0 still bundles the v1.0-shape JSON  │
  │  even after types.ts changed in v2.0                          │
  └──────────────────────────────────────────────────────────────┘
```

Verdict up front: **flattr has no schema version on its artifact and no
migration concept — `not yet exercised`, and it's a real latent gap.** The
artifact is `JSON.stringify(graph)` with no `schemaVersion` field; `loadGraph`
is a bare cast with no version check. Today that's harmless because there's one
producer and one consumer built from the same source. It becomes a bug the
moment a shipped app binary (bundling an old-shape JSON) runs against a
`types.ts` that changed — a field rename reads as `undefined`, silently.

---

## Structure pass

Two layers (the writer, the reader) separated by *time*, not just by
serialization. I'll trace the axis **"how does this side know which schema
version it's dealing with?"** — because that's the entire migration question,
and the answer is "it can't" on both sides.

```
  Axis — "how does each side know the schema version?" — by layer

  ┌─ Writer (build) ───────────────────────────────────────────┐
  │  knows the version: implicitly, it's whatever types.ts is   │
  │  TODAY. But it WRITES no version into the artifact.         │
  └────────────────────────────┬───────────────────────────────┘
              seam: serialize + SHIP (artifact frozen in a binary)
              the writer's "today" becomes the reader's "whenever"
  ┌─ Reader (runtime, possibly a stale binary) ────▼───────────┐
  │  knows the version: it ASSUMES it's current. No field to    │
  │  read, no check to run. A v1 artifact in a v1 binary reads  │
  │  fine; a v1 artifact whose TYPE changed reads garbage.      │
  └──────────────────────────────────────────────────────────────┘
```

**The seam is "serialize and ship into a binary."** Unlike a server reading a
live database (where producer and consumer move together), a mobile app *bundles*
the artifact — so a user's installed binary can carry a months-old `graph.json`
shape. The axis answer is "neither side records the version," which means a
schema change has no safe rollout: you can't detect, branch on, or migrate the
old shape because nothing labels it.

---

## How it works

### Move 1 — the mental model

You've shipped a `localStorage` schema before. v1 stores `{theme: "dark"}`. In
v2 you rename it to `{appearance: "dark"}`. A returning user still has the v1 key
in their browser — and if your code reads `appearance` with no fallback, it's
`undefined`, and the app silently behaves as if no preference was set. The fix
is always the same: write a version, read the version, and migrate forward when
they differ. flattr's `graph.json` is that `localStorage` blob, bundled into a
binary instead of a browser.

```
  The pattern — versioned data survives schema change

  WITH version (safe):              WITHOUT version (flattr today):
  data = {v: 1, theme: "dark"}      data = {nodes, edges, adjacency}
       │                                  │
       ▼  reader checks v                 ▼  reader assumes current shape
  if v < CURRENT: migrate()          (rename a field → reads undefined,
  else: read directly                 NO signal anything is wrong)
```

### Move 2 — the parts, one at a time

#### What's missing — the version field

The artifact has no `schemaVersion`. You can verify it from the raw file: it
opens `{"city":"seattle-mvp","bbox":[...],"nodes":{...` — straight into the data,
no metadata envelope. `writeGraph` is literally `JSON.stringify(graph)`, and
`Graph` has no version field for it to write.

```
  the missing field — artifact has no self-description

  graph.json:  { city, bbox, nodes, edges, adjacency }
               └─ no schemaVersion, no formatVersion, no producedBy ─┘
                  the reader gets data with no way to ask "what shape?"
```

The boundary condition: a version field is the *prerequisite* for every other
migration tool. Without it you can't branch ("if v1, do X"), can't validate
("expected v2, got v1"), can't even log a useful error. It's the one-line
addition that unlocks everything else — `Graph.schemaVersion: number`, written
in `writeGraph`, checked in `loadGraph`.

#### What's missing — the read-side check

`loadGraph` doesn't just skip the version check — it skips *all* checking, via
`graph as unknown as Graph`. The `as unknown as` double cast is TypeScript's
"I'm overriding the type system, trust me." It means a JSON of literally any
shape compiles and loads. So even if you added a version field, you'd still need
to *read* it here — the cast is the place a migration branch would live.

```
  the missing check — where a migration branch would go

  loadGraph():
    const raw = graph;                          // untyped JSON
    // MISSING: if (raw.schemaVersion !== CURRENT) migrate(raw)
    return raw as unknown as Graph;             // ← cast hides the absence
```

#### Why it's invisible today — single producer, single consumer

Right now `run-build.ts` writes the artifact and `loadGraph` reads it, both
compiled from the same `features/routing/types.ts`. They can't disagree about
the shape because they're built together. This is exactly why the gap hasn't
bitten: there's no *time skew* between writer and reader in development.

```
  why it's harmless now — and how that breaks

  NOW:   types.ts ──► build artifact ──► same-build app reads it    ✓ agree
  LATER: types.ts (v2) ──► new artifact
                 ▲
                 └─ but a USER on the v1 app binary still bundles the
                    v1-shaped artifact → reader (v2 code) meets writer
                    (v1 data) → field skew → silent undefined           ✗
```

#### The migration that doesn't exist — and the rebuild that substitutes

There's no migration script, and arguably there shouldn't be a *complex* one:
because the artifact is fully derived from OSM + elevation (files 01–02), the
"migration" for a schema change is **re-run the build** (`npm run build:graph`)
and re-bundle. You never have to transform old artifacts in place — you
regenerate them from source. That's a genuine strength of the derived-artifact
design.

```
  flattr's migration story — regenerate, don't transform

  schema change (add a field to Edge)
       │
       ▼
  update grade.ts/split.ts to populate it
       │
       ▼
  npm run build:graph  ──►  fresh graph.json in the new shape
       │
       ▼
  re-bundle into the app
       └─ no in-place data transform; source is the OSM/elevation,
          not the artifact. The artifact is always reproducible.
```

The catch the rebuild *doesn't* solve: already-shipped binaries. A user who
hasn't updated still runs old code with the old bundled artifact — fine, they
agree. But if you ever load a *remote* artifact into an old binary (which
`useTileGraph` already does — it fetches and builds graphs at runtime), version
skew between the fetching code and a cached/remote artifact becomes reachable.
That's where the missing version field stops being theoretical.

### Move 2.5 — current state vs versioned state

```
  Phase A (now): unversioned, single-source
    no version field, no check, no migration.
    safe because writer and reader are built together.
    schema change = rebuild + rebundle (regenerate from source).

  Phase B (the cheap hardening):
    + Graph.schemaVersion: number (one field)
    + writeGraph stamps it
    + loadGraph reads it: refuse/migrate on mismatch
    → schema changes become detectable, not silent.
    cost: ~5 lines. unlocks validation (file 04) on the same pass.
```

### Move 3 — the principle

The most expensive thing to get wrong in a system is the data shape, because
code is cheap to redeploy and data-already-written is not. A schema version is
the cheapest insurance against that: one field that lets every future reader
*know what it's looking at* and branch safely. flattr's derived-artifact design
sidesteps the hardest part of migrations (it can always regenerate from source
rather than transform in place) — but it skips the one-line version stamp that
would make even that regeneration *safe to roll out*. The lesson: "I can always
rebuild it" is a real strength, but it doesn't excuse the version field, because
rebuild doesn't reach binaries already in users' hands.

---

## Primary diagram

The evolution story — what exists, what's missing, what substitutes.

```
  flattr's schema evolution — versioning vs regeneration

  WRITER (run-build.ts)                READER (loadGraph.ts)
  ─────────────────────                ──────────────────────
  writeGraph = JSON.stringify(graph)   graph as unknown as Graph
       │                                    │
       ✗ no schemaVersion stamped           ✗ no version read, no check
       │                                    │
       └──────── graph.json ────────────────┘
                 { city, bbox, nodes, edges, adjacency }
                 (no metadata envelope — verified in the raw file)

  MIGRATION STORY:
    in-place transform of old artifacts ........ NOT NEEDED (regenerate)
    re-run build from OSM/elevation ............ ✓ the substitute (a strength)
    version stamp + read-side check ............ ✗ MISSING (the gap)
    safe rollout to stale binaries ............. ✗ blocked by the missing stamp
```

---

## Implementation in codebase

### Use cases

- **Any schema change to `Node`/`Edge`/`Graph`** → today, re-run
  `npm run build:graph` and re-bundle; no version gate.
- **Loading the bundled artifact** → `loadGraph` casts with no version check.
- **Runtime tile fetching** → `useTileGraph` builds graphs live, the path where
  version skew could actually become reachable.

### Code, line by line

The writer — no version stamped.

```
  pipeline/run-build.ts (lines 10–12)

  function writeGraph(graph: Graph, path: string): void {
    writeFileSync(path, JSON.stringify(graph));   ← whole object, as-is
  }                                                  no schemaVersion added,
       │                                             because Graph has none
       └─ the artifact is exactly the in-memory Graph, serialized. Nothing
          records which version of types.ts produced it.
```

The reader — no version read.

```
  mobile/src/loadGraph.ts (lines 9–11)

  export function loadGraph(): Graph {
    return graph as unknown as Graph;   ← would-be home of a version branch:
  }                                        if (raw.schemaVersion !== CURRENT)
       │                                       migrate(raw)
       └─ the double cast accepts any shape; a renamed field is undefined,
          silently, with no version to flag the mismatch
```

The schema — no field to version against.

```
  features/routing/types.ts (lines 22–28)

  export type Graph = {
    city: string;
    bbox: [number, number, number, number];
    nodes: Record<string, Node>;
    edges: Edge[];
    adjacency: Record<string, string[]>;
    // ← no `schemaVersion: number` — the one-line addition that would
    //   make every future loadGraph able to detect a stale artifact
  };
```

The regeneration substitute — why in-place migration isn't needed.

```
  pipeline/run-build.ts (lines ~50–55, main())

  const graph = await buildGraph("seattle-mvp", BBOX, osm, provider, ...);
  writeGraph(graph, "data/graph.json");
       │
       └─ the artifact is rebuilt from OSM + elevation every time. A schema
          change is "edit the pipeline, re-run this" — never "transform the
          old JSON." The hard part of migrations is genuinely absent here.
```

---

## Elaborate

Schema versioning is the boundary between "I can change my data shape" and "I'm
stuck with my first guess forever." Relational migrations (Rails, Flyway,
Drizzle's `migrations/0003_*.sql` in your AdvntrCue) version the *schema in the
database*; document stores and config blobs version the *document* with a field.
The pattern is identical: record the version, read the version, branch on
mismatch (migrate forward, refuse, or warn). The expand/contract (parallel-
change) discipline — add the new field, backfill, switch readers, then drop the
old — is how you do it with zero downtime under live data.

flattr sits in the easy corner of the migration space because its data is
*derived and reproducible*: it's the difference between a cache (regenerable, no
migration needed — just invalidate and rebuild) and a system of record (must be
migrated in place because it's the only copy). Derived artifacts get to treat
schema changes as cache invalidations. The one thing that corner *doesn't* buy
you is detection — a version field is still required so a reader holding a stale
copy (a not-yet-updated app binary, a cached remote tile) knows it's stale. That
detection is the missing piece, and it's the same pass where file 04's load-time
validation belongs: one `loadGraph` guard that checks both version and
referential integrity.

Read next: file 06 (is JSON-document the right *storage shape* for this access
pattern in the first place — the seam to system-design).

---

## Interview defense

**Q: How do you version your schema and handle migrations?**

Honestly — I don't, yet. The artifact has no `schemaVersion` field and
`loadGraph` is a bare cast with no version check. It's harmless today because the
producer and consumer are built from the same source, so they can't disagree
about the shape. But it's a real latent gap: a shipped app binary bundles an
old-shape `graph.json`, and if the type changes, a renamed field reads
`undefined` silently.

```
  the gap                          the fix (5 lines)
  ───────                          ────────────────
  no version stamped/read    ──►   Graph.schemaVersion + stamp + check
  silent field skew          ──►   loud "expected v2, got v1" at load
```

**Anchor:** "No version field — the cheapest insurance I'm missing; the
derived-artifact design lets me *regenerate* instead of transform, but rebuild
doesn't reach binaries already in users' hands."

**Q: But you can just rebuild the graph — isn't migration moot?**

For in-place transformation, yes — that's the genuine strength: the artifact is
derived from OSM + elevation, so a schema change is "edit the pipeline, re-run
`build:graph`," never "migrate old JSON." What rebuild *doesn't* solve is
detection across a time skew — a stale bundled or cached artifact meeting newer
code. That still needs the version stamp.

**Anchor:** "Regenerate beats migrate for derived data — but it doesn't replace
the version stamp, it just simplifies what you do *after* the stamp catches a
mismatch."

---

## Validate

1. **Reconstruct.** State what flattr writes for schema versioning and what it
   reads. (Nothing and nothing — `run-build.ts:10–12`, `loadGraph.ts:9–11`.)
2. **Explain.** Why is the missing version field harmless in dev but a bug for
   shipped binaries? (Same-build producer/consumer agree; a bundled stale
   artifact + changed `types.ts` skews silently.)
3. **Apply.** Add the version field end to end: name the type change, the
   writer line, and the reader branch. (`Graph.schemaVersion` in `types.ts`;
   stamp in `writeGraph`; check/migrate in `loadGraph`.)
4. **Defend.** A teammate says "we never need migrations, we just rebuild."
   Agree on in-place transform, push back on detection. (Rebuild handles
   regeneration; it doesn't reach already-shipped binaries or cached remote
   tiles — those still need the version stamp.)

---

## See also

- `04-transactions-and-integrity.md` — the load-time validation that shares the
  version-check pass.
- `02-normalization-and-duplication.md` — "rebuild is the only sync," the same
  derived-artifact property.
- `06-access-patterns-and-storage-choice.md` — whether JSON is the right shape
  to evolve at all.
- `.aipe/study-database-systems/` — migrations, expand/contract, durability.
