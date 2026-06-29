# The datastore map

**Industry name(s):** storage architecture / data-access map · **Type:**
Language-agnostic (the concepts) anchored to project-specific shape.

## Zoom out, then zoom in

Before any mechanism, here's where "the database" lives in flattr — and the
first surprise is that there isn't one process you'd call a database. There are
two storage surfaces, in two different lifecycles.

```
  Zoom out — where storage lives in flattr

  ┌─ BUILD layer (pipeline/, runs offline on your machine) ──────┐
  │  osm.ts → split.ts → grade.ts → build-graph.ts               │
  │      writes ──►  ★ graph.json ★   (the artifact / "the DB")  │ ← we are here
  └────────────────────────────┬─────────────────────────────────┘
                               │  git-committed, bundled by Expo
  ┌─ APP layer (mobile/, runs on device) ─▼──────────────────────┐
  │  loadGraph.ts  ── reads graph.json once ──► Graph (in RAM)    │
  │  useTileGraph  ── merges live tiles ──────► Graph (in RAM)    │
  │  elevCache.ts  ── reads/writes ───────────► AsyncStorage (KV) │ ← and here
  └───────────────────────────────────────────────────────────────┘
```

Zoom in. The thing this whole guide circles is: *how does flattr execute and
preserve reads and writes, and which engine guarantees does it assume it has?*
The answer is "almost none, and it doesn't need them" — but you can't say that
with confidence until you've mapped the two surfaces and named what each one
is standing in for. That map is this file.

## The structure pass

Three layers, one axis held constant, and the seams where the axis flips.

**Layers** (by lifecycle):
1. **Build** — `pipeline/`, runs once offline, produces `graph.json`.
2. **Bundle/read** — `loadGraph.ts`, reads the artifact into memory at startup.
3. **Runtime mutate** — `elevCache.ts` + `useTileGraph.ts`, the only places
   data changes after startup.

**Axis traced — "is this data mutable, and who can write it?"**

```
  one axis — "who can write this data?" — across the layers

  ┌─ Build layer ─────────────────┐
  │  graph.json: WRITABLE          │   the pipeline owns it; full rewrite
  └───────────────┬────────────────┘
       seam ══════╪══════  (artifact frozen, committed to git)
  ┌─ Read layer ──▼────────────────┐
  │  graph.json: READ-ONLY          │   loadGraph() never writes back
  └───────────────┬────────────────┘
       seam ══════╪══════  (a second, independent store appears)
  ┌─ Runtime layer ▼───────────────┐
  │  elevCache: WRITABLE (KV, 1 wr.)│   debounced single-writer persistence
  │  merged graph: WRITABLE (RAM)   │   rebuilt, never persisted
  └─────────────────────────────────┘
```

The axis-answer **flips twice**, and each flip is a load-bearing seam:

- **Build → Read seam.** The artifact goes from writable to frozen. This is the
  seam with *no contract* — no schema version, no checksum, no handshake. The
  app trusts that whatever `build-graph.ts` last emitted matches the `Graph`
  type the app casts to (`loadGraph.ts:9`). That's red-flag #2.
- **Read → Runtime seam.** A *second, completely separate* store appears
  (AsyncStorage), with its own (weak) durability rules. The graph and the
  elevation cache never share a transaction, a lock, or a consistency guarantee.

**Why map seams before mechanics:** the interesting database lessons in flattr
all live at these two seams. The missing schema version is a *contract* gap at
the first seam. The debounced KV writes are a *durability* mechanism at the
second. Learn the joints and the rest hangs off them.

## How it works

### Move 1 — the mental model

You already know the shape of a normal app's data layer: a React component calls
`fetch('/api/thing')`, a handler runs a SQL query against Postgres, rows come
back. flattr deletes the middle two boxes. The "query" runs in-process against a
data structure that's already in RAM; the "rows" are object references.

```
  the pattern — flattr collapses the data stack into RAM

  normal app:                     flattr:
  ┌──────────┐                    ┌──────────┐
  │ UI       │                    │ UI       │
  └────┬─────┘                    └────┬─────┘
   fetch│ (network hop)            call│ (function call, same process)
  ┌────▼─────┐                    ┌────▼──────────────┐
  │ handler  │                    │ astar / nearest   │
  └────┬─────┘                    │   over Graph (RAM)│
   SQL │ (network hop)            └────┬──────────────┘
  ┌────▼─────┐                     ref │ (pointer deref)
  │ Postgres │                    ┌────▼──────────────┐
  │  (disk)  │                    │ nodes / adjacency │  already loaded
  └──────────┘                    └───────────────────┘
```

The strategy: **pay the I/O cost once at build+load time, then every read is a
memory access.** That's why there's no query planner and no transactions — those
mechanisms exist to manage disk I/O and concurrent durable mutation, and flattr
has neither in the hot path.

### Move 2 — the four storage surfaces, one at a time

**The artifact: `graph.json`.** This is flattr's "tablespace." One file, JSON,
544 KB, holding the whole dataset. Top-level keys (verified by inspecting the
file): `city`, `bbox`, `nodes`, `edges`, `adjacency`. The `Graph` type that
mirrors it is `features/routing/types.ts:22`.

```
  graph.json — the artifact's logical layout

  {
    "city":  "seattle-mvp",                ← metadata
    "bbox":  [minLng,minLat,maxLng,maxLat],← spatial bounds
    "nodes": { "n0": {...}, "n1": {...} }, ← 1621 entries, keyed by id  (the PK map)
    "edges": [ {...}, {...} ],             ← 1879 entries, an array     (scanned)
    "adjacency": { "n0": ["e3","e7"] }     ← 1621 entries, id→edgeId[]  (the index)
  }
```

The two access shapes inside one artifact are the whole storage-engine lesson:
`nodes` is a **hash map** (primary-key lookup), `edges` is an **array** (full
scan unless you go through the index), and `adjacency` is the **hand-built
secondary index** that connects them. Hold that — `03` walks it in full.

**The reader: `loadGraph()`.** The entire "open the database" path:

```ts
// mobile/src/loadGraph.ts:6-11 — the whole reader
import graph from "../assets/graph.json";   // line 7: Metro bundles the JSON at build
export function loadGraph(): Graph {
  return graph as unknown as Graph;          // line 10: cast, no validation
}
```

Line 7 is the load: Metro (Expo's bundler) inlines `graph.json` into the JS
bundle, so by the time the app runs the object is already parsed and in memory —
there's no `fs.readFile`, no `await`. Line 10 is the seam with no contract: a
double cast (`as unknown as Graph`) that tells TypeScript "trust me" and does
**zero runtime validation.** If a future `build-graph.ts` renames `adjacency`,
this line still compiles and still "succeeds" — the breakage surfaces later as
an undefined-index crash deep in A*. That's the schema-version gap made concrete.

**The runtime read+write store: `elevCache`.** The only thing in flattr that
writes durable data after startup. It's a key/value store: keys are `~90m DEM
cell` strings (`useTileGraph.ts:36`), values are elevation in meters. Backed by
AsyncStorage under one key, `flattr.elevCache.v1` (`elevCache.ts:7`).

```
  elevCache — KV store layered over AsyncStorage

  ┌─ in-memory tier ────────────┐
  │  Map<string, number> (mem)  │  ← every getElev/putElev hits this first
  └──────────────┬───────────────┘
        dirty?    │ debounced 4s (PERSIST_DEBOUNCE_MS)
  ┌──────────────▼───────────────┐
  │  AsyncStorage["...elevCache.v1"]  one JSON blob, whole-map rewrite
  └──────────────────────────────┘
```

Note the `.v1` in the key — the elevCache *does* version its storage namespace,
which is exactly the discipline `graph.json` is missing. Bump it to `.v2` and
old caches are simply ignored, never misread. `07` walks the write/durability
path; `02` walks why "whole-map rewrite" is the cost model it is.

**The transient join: the merged graph.** `useTileGraph.ts:132-145` stitches the
base graph + live viewport tiles + route corridor into one merged `Graph` on
every relevant state change. This is a *materialized view* computed in RAM and
never persisted — pure derived state. It's the closest flattr gets to a "query
result set," and `04` treats it as one.

### Move 3 — the principle

A datastore is wherever the system's source-of-truth bytes live plus the rules
for reading and changing them. flattr has two such places with two different
rule sets — a frozen artifact with no contract, and a KV cache with a weak
durability contract. Mapping *where the bytes live and who's allowed to change
them* is the move that makes every other database concept findable; you can't
reason about isolation or recovery until you know which store you're talking
about.

## Primary diagram

The full map: two storage surfaces, two lifecycles, the seams between them.

```
  flattr — the complete datastore map

  ┌─ BUILD (offline, pipeline/) ─────────────────────────────────────┐
  │  OSM ─► split ─► grade ─► build-graph ─► graph.json               │
  │                                            │ WRITABLE here only    │
  └────────────────────────────────────────────┼─────────────────────┘
                              seam: no version / no checksum  ║ frozen
  ┌─ APP (on device, mobile/) ─────────────────▼─────────────────────┐
  │                                                                   │
  │  graph.json ──loadGraph()──► Graph (RAM, READ-ONLY)               │
  │                 │                                                 │
  │                 ├─ nodes      Record<id,Node>   ► PK map  (O(1))  │
  │                 ├─ adjacency  id→edgeId[]        ► 2ndary index   │
  │                 └─ edges      Edge[]             ► scanned        │
  │                                                                   │
  │  reads:  astar.search() ── adjacency walk ──► path                │
  │          nearestNode() ──── O(N) edge/node scan ──► id            │
  │                                                                   │
  │  useTileGraph ── merge(base, view, corridor) ► merged Graph (RAM) │
  │                                                                   │
  │  ┌─ separate store ─────────────────────────────────────────┐    │
  │  │ elevCache  getElev/putElev ─► Map ─debounce─► AsyncStorage│    │
  │  │            (the ONLY durable write path; key ".v1")       │    │
  │  └───────────────────────────────────────────────────────────┘   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

This shape has a name: **embedded / in-process storage**, the same family as
SQLite, LMDB, or RocksDB-as-a-library — the data engine runs inside your process
rather than as a separate server you talk to over a socket. flattr is the
extreme end: the engine is *just JavaScript objects*, and the "query language" is
hand-written functions. You've shipped the next rung up in `buffr` (SQLite as the
canonical local store) and `dryrun` (GitHub-as-backend) — both trade the network
hop for local files, same instinct as flattr, but with a real engine managing
the bytes.

The spec's intended target (`docs/flattr-spec.md` §8) is Next.js + Postgres +
pgvector — the same stack as your `AdvntrCue`. The day flattr makes that jump,
this map gains a *third* layer (a real server, over the network) and every
`not yet exercised` concept in this guide activates at once. The map is the thing
that tells you which.

## Interview defense

**Q: "Walk me through flattr's data layer."**

> Two surfaces. A read-only artifact, `graph.json` — built offline by the
> pipeline, bundled, loaded once into RAM, never written back. And a key/value
> cache, `elevCache`, over AsyncStorage — the only durable write path, used to
> avoid re-hitting a throttled elevation API. The artifact is where the
> index-vs-scan lessons live; the cache is where the durability lessons live.
> Everything between them — transactions, locks, a query planner — is absent
> because the workload is read-mostly against in-memory data.

```
  artifact (RO, RAM) ──┐
                       ├──► two stores, two rule sets, no shared txn
  elevCache (KV, disk)─┘
```

Anchor: *two storage surfaces, two lifecycles, two contracts — and the
interesting bugs live at the seams between them.*

**Q: "Where's the riskiest part of that map?"**

> The build→read seam. The app does `graph.json as unknown as Graph` with no
> runtime validation and no schema version. The two sides are coupled only by a
> TypeScript type that's erased at runtime. A field rename in the pipeline
> ships a broken bundle silently.

Anchor: *a frozen artifact with no version field is an un-versioned API between
two programs that can't be deployed in lockstep.*

## See also

- `02-records-pages-and-storage-layout.md` — why JSON-as-storage costs what it does
- `03-btree-hash-and-secondary-indexes.md` — the nodes map and adjacency index
- `07-wal-durability-and-recovery.md` — the elevCache write path
- `09-database-systems-red-flags-audit.md` — the missing schema version, ranked
- `../study-system-design/` — which datastore and how it scales
- `../study-data-modeling/` — the schema shape itself
