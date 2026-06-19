# The datastore map

**Industry name(s):** read-only data store / immutable artifact / embedded
data file · **Type:** Project-specific (the pattern — "ship the data inside the
app" — is Industry standard for read-only datasets)

## Zoom out, then zoom in

Before any mechanism, here's the whole picture. There is exactly one box in
this system that plays the role a database plays in a normal app — and it isn't
a database. It's a JSON file.

```
  Zoom out — where the "database" lives in flattr

  ┌─ Build layer (offline, pipeline/) ──────────────────────────────┐
  │  Overpass + Open-Meteo  ──►  buildGraph()  ──►  JSON.stringify   │
  └──────────────────────────────────────────┬──────────────────────┘
                                              │  writes graph.json
  ┌─ Storage layer ────────────────────────── ▼ ─────────────────────┐
  │  ★ graph.json — the ONLY persistent store ★   ← we are here      │
  │  immutable · read-only · bundled into the app · 544 KB           │
  └──────────────────────────────────────────┬──────────────────────┘
                                              │  import (once, at startup)
  ┌─ Runtime layer (Expo RN) ──────────────── ▼ ─────────────────────┐
  │  loadGraph() ─► in-memory Graph ─► A* / nearestNode / GeoJSON    │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question this file answers is *"where does flattr's data live,
how is it read, and what's the boundary past which durability stops being the
app's problem?"* The answer is unusual and worth saying out loud: the store is
write-once-at-build, read-only-at-runtime, and lives **inside the app bundle**.
That single fact determines everything downstream — it's why transactions,
locks, WAL, and replication are all `not yet exercised`.

## The structure pass

**Layers.** Three, top to bottom: the *build layer* (`pipeline/`) that produces
the artifact, the *storage layer* (the `graph.json` file itself), and the
*runtime layer* (`features/` + `mobile/src/`) that reads it.

**The axis: state — who owns it, where it lives, is it mutable?** Trace that one
question down the stack and watch the answer flip:

```
  Axis = "who owns the data and can they mutate it?"  — traced downward

  ┌─ Build layer ─────────────────────────────────┐
  │  OWNS + WRITES the data (the only writer)      │  → mutable here
  └───────────────────────────┬────────────────────┘
            seam: JSON.stringify → file  ═══════╪═══  (state freezes)
  ┌─ Storage layer ───────────▼────────────────────┐
  │  graph.json — holds the data, nobody mutates it │  → immutable
  └───────────────────────────┬────────────────────┘
            seam: import / loadGraph()  ═════════╪═══  (copy into RAM)
  ┌─ Runtime layer ───────────▼────────────────────┐
  │  in-memory Graph — READS only, never writes back│  → read-only
  └───────────────────────────────────────────────────┘
```

**Seams.** Two load-bearing ones, and the axis flips at both:

- **build → storage** (`JSON.stringify(graph)` → `writeFileSync`,
  `pipeline/run-build.ts:12`). Before this seam the data is mutable, in-flight,
  being assembled. After it, it's a frozen byte sequence. This is the
  bulk-load / commit boundary — the moment the dataset becomes canonical.
- **storage → runtime** (`import graph from "./graph.json"`,
  `mobile/src/loadGraph.ts:7`). The file is deserialized into a JS object once.
  After this seam there is no path back to the file — the runtime can mutate its
  in-memory copy all it wants and the artifact never notices.

That second seam is *why* there's no durability problem at runtime: writes (if
there were any) would never reach disk, so there's nothing to lose on a crash
and nothing to recover.

## How it works

### Move 1 — the mental model

You already know the shape: it's a `fetch()` that returns a big JSON blob,
except the fetch is `import` and the server is the app bundle. The data ships
*with the code*. There's no round-trip, no connection pool, no query — just a
deserialize-once-then-read-from-memory loop.

```
  The pattern — load-once, read-many over an immutable blob

   build time              run time
   ──────────              ────────────────────────────
   assemble  ──► FILE ──► load once ──► [ in-RAM Graph ] ──► read
   (writer)     (frozen)  (deserialize)      ▲                ▲
                                             │                │
                                       never written     read by A*,
                                       back to disk       nearest, GeoJSON
```

The whole engine is a reader. That's the thing to hold in your head.

### Move 2 — the moving parts

#### The artifact is the source of truth

The canonical dataset is one file. In a Postgres app the source of truth is the
data directory the server guards; here it's a 544 KB JSON file you can open in
an editor. There's no server process mediating access — the "DBMS" is
`JSON.parse` (done implicitly by the bundler's JSON import) plus plain object
property access.

What breaks if you forget this: you go looking for a connection string, a
migration runner, a pool config — and none exist, because there's no server to
connect to. The data *is* the file.

#### The load is a single deserialize, not a connection

```
  Layers-and-hops — the one and only data fetch

  ┌─ Storage ────┐  hop 1: bundler resolves the JSON import   ┌─ Runtime ─┐
  │  graph.json  │ ──────────────────────────────────────────►│ JS object │
  └──────────────┘  hop 2: loadGraph() casts to Graph type    └─────┬─────┘
                    (no network, no parse cost beyond bundle)       │
                                                                    ▼
                                                          A* / nearest / map
```

One hop, no network. Compare a normal app: client → load balancer → service →
connection pool → DB → back. Here the "DB" is in-process, so the read latency
is a property access, measured in nanoseconds.

#### The access paths fan out from the loaded object

Once `loadGraph()` returns the `Graph`, three readers consume it, each via a
different access path (this is what the rest of the guide unpacks):

- **PK lookup** — `graph.nodes[id]` (a hash lookup; file `03`)
- **index scan** — `graph.adjacency[id]` then `byId.get(edgeId)` (file `03`)
- **full scan** — `nearestNode` loops every node (file `04`)

#### Move 2.5 — current state vs. future state

This concept is fully shipped on the read side and *deliberately empty* on the
write side. Here's the comparison that matters:

```
  Phase A (now): read-only artifact     Phase B (if a DB arrived)

  graph.json bundled in app             Postgres / SQLite store
  load once at startup                  connection + pool
  no write path                         INSERT/UPDATE on edge edits
  rebuild = redeploy                    migrations + live writes
  durability: N/A (nothing written)     WAL + fsync + backups
  consistency: trivial (1 copy)         isolation levels matter
```

The takeaway for Phase B: almost nothing on the *read* side changes — A* still
asks for `adjacency[current]`. What changes is everything this guide marks `not
yet exercised`: you'd suddenly need transactions (file `05`), concurrency
control (`06`), a WAL (`07`), and a replication story (`08`). The read-only
choice is what buys their absence.

### Move 3 — the principle

**Immutability is a design decision that deletes problems.** By making the store
write-once-at-build, flattr trades away the ability to edit data at runtime and
gets, in exchange, the deletion of every hard consistency-and-durability problem
a stateful DB carries. For a routing app over a city that changes on the scale
of months, that's the right trade. The general lesson: before reaching for a
database, ask whether your data actually changes at runtime — if it doesn't, a
bundled artifact is simpler and faster, and the "missing" DB machinery was never
needed.

## Primary diagram

The full map, every layer and hop labelled.

```
  flattr datastore — full map

  ┌─ BUILD (pipeline/, offline) ────────────────────────────────────┐
  │  parseOsm → splitWays → sampleElevations → computeGrades         │
  │                              │ buildAdjacency()                  │
  │                              ▼                                    │
  │                     Graph {nodes,edges,adjacency}                │
  │                              │ JSON.stringify (run-build.ts:12)   │
  └──────────────────────────────┼───────────────────────────────────┘
                  ═══ COMMIT SEAM ┼═══ (state freezes; mutable→immutable)
  ┌─ STORAGE ────────────────────▼───────────────────────────────────┐
  │  graph.json  —  544 KB  —  1621 nodes · 1879 edges · 1 bbox       │
  └──────────────────────────────┼───────────────────────────────────┘
                  ═══ LOAD SEAM ══┼═══ (deserialize into RAM; read-only)
  ┌─ RUNTIME (Expo RN) ──────────▼───────────────────────────────────┐
  │  loadGraph()  →  Graph in memory                                  │
  │      ├─ nodes[id]        PK hash lookup        (→ file 03)        │
  │      ├─ adjacency[id]    secondary index scan  (→ file 03)        │
  │      └─ nearestNode()    full scan O(N)        (→ file 04)        │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every screen load in the mobile app hits this path exactly once:
`MapScreen` mounts, calls `loadGraph()`, and from then on routing and the
heatmap read the in-memory copy. The `useTileGraph` hook *extends* this base
artifact at runtime by building extra tiles, but the bundled `graph.json` is
always the foundation it merges onto.

**The loader — `mobile/src/loadGraph.ts` (lines 6-11):**

```
  import type { Graph } from "features/routing/types";   ← the store's schema
  import graph from "../assets/graph.json";              ← the ONLY persistent
                                                            store, bundled

  export function loadGraph(): Graph {
    return graph as unknown as Graph;   ← cast: JSON has no types; we assert
  }                                       it matches Graph. No validation —
       │                                  the build pipeline is trusted to
       │                                  have produced a well-formed graph.
       └─ this is the entire "open a connection to the database" step.
          No pool, no retry, no auth. The import IS the connection, and it
          can't fail at runtime (bundle-time resolved). Without this cast
          the rest of the app couldn't treat the blob as a typed Graph.
```

**The commit seam — `pipeline/run-build.ts` (lines 10-13, 47-48):**

```
  function writeGraph(graph: Graph, path: string): void {
    writeFileSync(path, JSON.stringify(graph));   ← the bulk-load "COMMIT":
  }                                                 mutable Graph → frozen bytes
  ...
  mkdirSync("data", { recursive: true });
  writeGraph(graph, "data/graph.json");           ← writes to data/, then a
       │                                            human copies it to
       │                                            mobile/assets/ (loadGraph.ts
       └─ note: this is the ONLY writeFileSync in the data path. There is no    comment).
          runtime write anywhere. Search the runtime for fs writes — there are
          none. That absence is the whole durability story (→ file 07).
```

**The schema the store conforms to — `features/routing/types.ts` (lines 22-28):**

```
  export type Graph = {
    city: string;
    bbox: [number, number, number, number];  ← the partition key range (file 02)
    nodes: Record<string, Node>;              ← PK-indexed table (file 03)
    edges: Edge[];                            ← heap file: unordered rows (file 02)
    adjacency: Record<string, string[]>;      ← secondary index (file 03)
  };
       │
       └─ this type IS the storage schema. graph.json is a serialization of
          exactly this shape. The store has no schema enforcement of its own —
          the TypeScript type is the only contract, checked at build, asserted
          (not validated) at load.
```

## Elaborate

The "ship data inside the app" pattern is old and respectable: SQLite databases
bundled in mobile apps, static-site generators baking content into HTML, CDNs
serving JSON. It works when (a) the data is read-mostly or read-only, and (b)
the dataset fits in memory. flattr satisfies both — 544 KB fits trivially, and
the street graph for a neighborhood doesn't change between deploys.

The spec (`docs/flattr-spec.md` §5, lines 139-173) originally planned to put the
artifact in **Netlify Blobs** with per-city tiles, fronted by a thin Next.js
runtime. The repo as built skips Blobs entirely and bundles the file into the
Expo app — a simplification that's correct for a single-city MVP and would need
revisiting for multi-city (you don't want every city's graph in every app
bundle).

Where it stops working: the moment users can *edit* the graph (report a closed
sidewalk, add a path), you need a write path, and a write path is where every
`not yet exercised` topic in this guide wakes up. Read file `05` for what that
first write would cost.

What to read next: `02` for how a single `Node`/`Edge` is laid out inside the
blob, then `03` for the indexes that make reads fast.

## Interview defense

**Q: "Walk me through where this app's data lives and how it's accessed."**

> It's a read-only artifact, not a database. One JSON file — `graph.json`, about
> 544 KB, 1621 nodes and 1879 edges — built offline by the `pipeline/` and
> bundled into the app. At startup `loadGraph()` deserializes it into an
> in-memory `Graph` object once. From there three access paths read it:
> primary-key lookup via `nodes[id]`, a secondary-index scan via `adjacency[id]`,
> and a full scan in `nearestNode`. There's no server, no connection, no query
> language — the import is the connection and property access is the query.

```
  build ──► graph.json ──► loadGraph() ──► in-RAM Graph ──► A*/nearest/map
  (writer)  (immutable)    (deserialize)   (read-only)
```

Anchor: *the import is the connection; property access is the query.*

**Q: "Why no database? Isn't that a shortcut?"**

> It's a deliberate fit-to-the-problem call. The street graph is read-only at
> runtime and changes on the scale of months, so a bundled artifact gives
> nanosecond reads and deletes every transaction, locking, WAL, and replication
> problem a stateful DB carries. It becomes the wrong call the day users can
> edit the graph — then you need a write path and all that machinery comes back.

```
  read-only data?  ──yes──►  bundle it  (delete the DB problems)
        │
        └──no, runtime writes──►  now you need: txns, locks, WAL, replicas
```

Anchor: *immutability is a design decision that deletes problems.*

## Validate

1. **Reconstruct (from memory):** draw the three-layer map (build / storage /
   runtime) and mark the two seams. Name what flips at each seam.
2. **Explain:** why does `loadGraph()` (`mobile/src/loadGraph.ts:9`) have no
   error handling or retry? (Because the import is bundle-time resolved — it
   can't fail at runtime the way a network DB connection can.)
3. **Apply to a scenario:** a user reports a sidewalk is closed and wants it
   removed from routing. Trace every layer that would have to change. (Storage
   gains a write path; build is no longer the only writer; durability, isolation,
   and recovery — files `05`–`07` — all become live.)
4. **Defend the decision:** someone says "you should've used SQLite from day
   one." Make the counter-argument grounded in `loadGraph.ts:9` and the absence
   of any runtime `writeFileSync`.

## See also

- `02-records-pages-and-storage-layout.md` — how a `Node`/`Edge` sits in the blob
- `03-btree-hash-and-secondary-indexes.md` — the access paths' index structures
- `07-wal-durability-and-recovery.md` — why the rebuild is the recovery story
- `.aipe/study-system-design/` — why a build-time artifact, and how tiling scales
- `.aipe/study-data-modeling/` — the `Graph` schema's shape and field choices
