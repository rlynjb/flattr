# Overview — the data model at a glance

flattr's persistent data is a single read-only file. There's no Postgres, no
SQLite, no Notion-as-DB here (the spec proposed Next.js; the repo shipped an Expo
app reading a bundled JSON graph). The whole "database" is `mobile/assets/graph.json`
— 544 KB, 1621 nodes, 1879 edges of Capitol Hill, Seattle. The schema is declared
in TypeScript at `features/routing/types.ts:1-28` and serialized to JSON.

That makes the audit verdict easy to state up front:

**The model fits the access pattern almost perfectly — and that fit is the whole
point.** The app does exactly one kind of read: load the whole graph once, then run
A\* / heatmap traversals over all of it in memory. For "read everything, traverse,
never write at runtime," a static file beats a database — no connection, no query
planner, no round-trip. The adjacency map is the access-pattern index baked into the
artifact. This is a good call, made deliberately.

The weak spots are all the things a database would have given you for free and a
hand-rolled JSON blob does not:

```
  Worst-first — what to fix, ranked

  1. No referential integrity on edges     ── a dangling fromNode/toNode
     (04-integrity)                            crashes deep inside A* with a
                                               cryptic null, not at load.

  2. No schema version on graph.json        ── a field rename in types.ts
     (04-integrity)                            silently mis-reads an old
                                               bundled artifact. No drift guard.

  3. nearestNode is an O(N) full scan       ── every tap snapping to a node
     (03-indexes)                              walks all 1621 nodes. No spatial
                                               index. Fine now, quadratic later.

  4. edgeById is O(E) find, called per-edge ── route summary + GeoJSON rebuild
     (03-indexes)                              scan all 1879 edges per path edge.
                                               astar.ts already fixed this with
                                               a Map; summary.ts/geojson.ts didn't.

  5. absGradePct stored, not derived        ── |gradePct| copied onto every edge.
     (02-denormalization)                      Cheap, justified for the heatmap
                                               hot path — but it's duplication.
```

None of 1–5 is on fire. The graph is small, single-region, rebuilt by hand. But
each is the kind of thing that's invisible at 1.6k nodes and a wall at 160k —
exactly the seam between "works in the demo" and "works in the city."

## What's genuinely good

- **adjacency as a denormalized index** (`02`) — duplicating each edge's endpoints
  into `adjacency[nodeId]` is the right denormalization: it turns A\* expansion from
  O(E) into O(degree). Named and justified in `02`.
- **the build pipeline is a clean stage chain** (`05`) — parse → split → sample
  elevation → grade → adjacency. Each stage has one job; the schema fills in left to
  right (`split.ts` leaves grade at 0; `grade.ts` fills it).
- **signed grade as the source field, abs as the derived one** — `gradePct` is the
  primary fact (signed, direction-dependent); `absGradePct` is its derivation. The
  model knows which is canonical.

## What's not exercised (honestly)

- **No transactions** — there are no runtime writes, so there's nothing to make
  atomic. `not exercised`, and correctly so for a read-only artifact.
- **No migration framework** — schema evolution is "edit the type, rebuild the
  artifact, re-bundle." No reversible migrations, no backfills, no live data to
  migrate. `not exercised` — see `05` for what a versioning story would look like.
- **No FK constraints / unique / check constraints** — there's no engine to enforce
  them. The build code is the only guard, and it's partial. See `04`.

Read `audit.md` next for the lens-by-lens walk, then the pattern files for the
deep dives.
