# Query planning and execution

**Industry name(s):** query planner / execution engine / access path · **Type:**
Industry standard — and **largely `not yet exercised` here** (there is no query
language and no planner; what exists is hand-coded access paths)

## Zoom out, then zoom in

Verdict first: **there is no query planner in this repo, and there can't be —
there's no query language.** A database planner exists to translate declarative
SQL into an execution plan, choosing scans, indexes, and join orders. flattr has
no declarative layer; every read is a hand-written access path. So this file
teaches the planner concept by its *absence* — what the planner would do, and
what the hand-coded code does instead.

```
  Zoom out — where a planner WOULD sit (but doesn't)

  ┌─ Runtime readers ───────────────────────────────────────────────┐
  │  A* search        ─┐                                             │
  │  nearestNode      ─┼─► each reader hand-codes its OWN access path│
  │  heatmap GeoJSON  ─┘   (no shared planner decides for them)      │
  └───────────────────────────┬──────────────────────────────────────┘
        ┌─────────────────────▼─────────────────────┐
        │  ✗ NO QUERY PLANNER / EXECUTION ENGINE ✗   │  ← the absent box
        │     (a DB would put one here)              │
        └─────────────────────┬──────────────────────┘
  ┌─ Storage (graph.json) ────▼──────────────────────────────────────┐
  │  nodes (PK index) · edges (heap) · adjacency (secondary index)   │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"who decides HOW a read executes — which index, which
scan?"* In a DB, the planner decides at query time. Here, **the programmer
decided at write time**, baking the access path into each function. That's the
control-axis flip worth understanding.

## The structure pass

**Layers.** Two: the *declarative layer* (where SQL would live — empty here) and
the *physical-access layer* (the hand-coded reads that actually run). In a DB
these are separated by the planner; here they're collapsed.

**The axis: control — who decides how a read executes?** This is the cleanest
axis for this file:

```
  Axis = "who decides the access path?"

  In a real DB:                          In flattr:
  ┌─ SQL (declarative) ───────┐          ┌─ (no declarative layer) ──┐
  │  "WHAT I want"            │           │   absent                  │
  └────────────┬──────────────┘          └────────────┬──────────────┘
        seam: PLANNER decides ═══╪══            seam: PROGRAMMER decided
  ┌─ execution (physical) ────▼┐          ┌─ access path (physical) ──▼┐
  │  scan/index/join chosen   │           │  index/scan hard-coded in  │
  │  AT QUERY TIME            │           │  the function AT WRITE TIME │
  └───────────────────────────┘          └────────────────────────────┘
```

**Seams.** The seam that *would* matter — the planner boundary between "what" and
"how" — doesn't exist. That's the whole point. The consequence: there's no
`EXPLAIN`, no plan cache, no query optimizer surprising you with a bad plan. You
read the code to know the access path; you never wonder what the planner chose.

## How it works

### Move 1 — the mental model

You know the difference between `useMemo(() => list.find(...))` (you hand-coded
the lookup) and a GraphQL resolver where the framework decides how to fetch.
flattr is entirely the first kind: every read is a `find`, a `map`, or an index
lookup you wrote by hand. There's no framework choosing for you.

```
  The pattern — hand-coded access paths, no planner

  A read in a DB:                    A read in flattr:
  SQL ─► PLANNER ─► PLAN ─► execute  function ─► hard-coded access path ─► run
        (chooses)                              (you chose, at write time)
```

### Move 2 — the three access paths, walked

There are exactly three read shapes in the runtime. Each is a "query plan" a
human wrote.

#### Access path 1 — point lookup via PK (the index-seek)

`graph.nodes[id]` is a hash-index seek: O(1), the equivalent of
`SELECT * FROM nodes WHERE id = $1` resolved by a unique index. A* uses it to
fetch a neighbor node's coords. No planner needed — there's one way to do it and
it's optimal.

```
  Point lookup — the index seek

  graph.nodes["n42"]  ─►  {id,lat,lng,elevationM}      O(1)
  (hash index built into the keyed map; file 03)
```

#### Access path 2 — index scan via the secondary index (the hot path)

A* expanding a node is "fetch all edges incident to this node" =
`SELECT edge FROM edges WHERE fromNode=$1 OR toNode=$1`. A DB would *choose*
between scanning `edges` and using an index on `(fromNode, toNode)`. flattr
doesn't choose — it always uses `adjacency` (the index), then chains
`indexEdges()` to resolve ids to objects. Two O(1) hops, hand-wired.

```
  Index scan — the A* expansion (the hottest "query")

  for edgeId in adjacency[current]:     ← index scan (secondary index)
    edge = byId.get(edgeId)              ← index seek (transient hash index)
    next = otherEnd(edge, current)       ← compute the neighbor
  → equivalent SQL the planner never sees:
    SELECT e.* FROM edges e WHERE e.fromNode = :n OR e.toNode = :n
```

#### Access path 3 — full table scan (no index available)

`nearestNode` is `SELECT id FROM nodes ORDER BY distance(point, node) LIMIT 1` —
a nearest-neighbor query. With no spatial index, the only access path is a full
scan of all 1621 nodes computing distance to each. A DB *with* a spatial index
(PostGIS GiST) would do an index scan; flattr does the scan because the index
doesn't exist (file `03`).

```
  Full scan — nearestNode (no spatial index to seek)

  best = ∞
  for node in ALL nodes:               ← FULL SCAN, O(N)
    d = haversine(point, node)
    if d < best: best = d; keep node
  → SQL: SELECT id FROM nodes ORDER BY ST_Distance(geom, :pt) LIMIT 1
         (a DB would use a GiST index; here there's no index → scan)
```

#### The N+1 question — and why it doesn't bite here

The classic execution anti-pattern is N+1: a loop that issues one query per
iteration. A* *looks* like N+1 — it loops nodes and "queries" edges per node —
but it isn't, because there's no per-query overhead: the "queries" are in-memory
index lookups against a single loaded object, not round-trips. The thing that
makes N+1 painful (network/parse cost per query) is exactly the thing the
load-once-immutable design eliminates. So the pattern that's a red flag in a
networked DB is harmless here.

### Move 2.5 — current vs future state

```
  Phase A (now): hand-coded paths      Phase B (if SQL/SQLite arrived)

  programmer picks index, at write     planner picks index, at query time
  no EXPLAIN — read the code           EXPLAIN ANALYZE shows the plan
  no plan cache, no surprises          plan can change as stats change
  N+1 harmless (in-memory)             N+1 catastrophic (round-trips)
  nearest = full scan (no spatial idx) nearest = GiST index scan
```

The migration cost: you'd gain a declarative layer and lose the certainty that
the access path is exactly what you wrote. For an engine where the access paths
are this simple and this hot, hand-coding them is the *better* choice — you never
fight the planner.

### Move 3 — the principle

**A query planner is a layer that trades control for convenience.** It lets you
say "what" and forget "how" — until the plan goes wrong and you must reverse-
engineer "how" anyway. flattr keeps "how" explicit: there are three access paths,
all visible in the code, none chosen at runtime. The general lesson: a planner
earns its keep when queries are many, varied, and data-dependent; when they're
few, fixed, and hot, hand-coded access paths are simpler and more predictable.

## Primary diagram

The three access paths, the absent planner, and the indexes each uses.

```
  flattr's "query execution" — three hand-coded access paths

  ┌─ Readers (no planner between them and storage) ──────────────────┐
  │                                                                   │
  │  A* point lookup     ─► nodes[id]            ─► PK hash index O(1)│
  │  A* expansion (hot)  ─► adjacency[id]        ─► secondary idx O(1)│
  │                          then byId.get(id)   ─► transient idx O(1)│
  │  nearestNode         ─► loop ALL nodes       ─► FULL SCAN     O(N)│
  │  heatmap             ─► map ALL edges        ─► FULL SCAN     O(E)│
  │                                                                   │
  │  ✗ no planner · no EXPLAIN · no plan cache · no join optimizer    │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** A route request fires all three paths in sequence: `nearestNode`
twice (snap start + goal, full scans), then A* (index seeks + the hot index scan
per expansion). The heatmap fires the edge full scan once per region change.

**The hot access path — `features/routing/astar.ts` (lines 64-74):**

```
  for (const edgeId of graph.adjacency[current] ?? []) {  ← INDEX SCAN: the
    const edge = byId.get(edgeId)!;                         "query plan" a human
    const next = otherEnd(edge, current);                   wrote — always uses
    if (closed.has(next)) continue;                         the adjacency index
    const tentative = g.get(current)! + costFn(edge, current, userMax);
    if (tentative < (g.get(next) ?? Infinity)) {            ← the "WHERE" + cost
      g.set(next, tentative);                                 evaluated inline
      came.set(next, { edge, prev: current });
      open.push(next, tentative + heuristicFn(...));
    }
  }
       │
       └─ no planner decided to use adjacency — the programmer did, by writing
          this loop. There's no alternative plan to fall back to. This is the
          access path, full stop.
```

**The full-scan access path — `features/routing/nearest.ts` (lines 8-15):**

```
  for (const id of Object.keys(graph.nodes)) {   ← FULL SCAN: the only access
    const n = graph.nodes[id];                     path, because no spatial index
    const d = haversine(point, {lat:n.lat, lng:n.lng});
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
       │
       └─ a DB with PostGIS would EXPLAIN this as an index scan; here EXPLAIN
          doesn't exist and the access path is visibly a scan. The plan IS the code.
```

**The edge full scan — `features/map/geojson.ts` (lines 20-21):**

```
  const features = graph.edges.map((e) => ({ ... }));   ← FULL SCAN of edges,
                                                           but a full scan is
                                                           CORRECT here: the
                                                           heatmap wants every
                                                           edge. No index would help.
```

## Elaborate

Query planning is one of the deepest subsystems in a real database — cost-based
optimizers, statistics, histograms, join-order search. None of it applies to
flattr, and pretending otherwise would be inventing infrastructure. What's worth
carrying from the planner world is the *vocabulary of access paths*: point lookup
(seek), index scan, full scan, nearest-neighbor. Naming flattr's three reads in
those terms is what lets you reason about their cost and spot the missing index
(spatial, for path 3).

The honest framing: flattr is at the far end of a spectrum. One end is "all
declarative, planner decides everything" (Postgres). The other is "all
imperative, programmer decides everything" (flattr). The middle (query builders,
ORMs) is where most apps live. flattr sits at the imperative end *because its
access patterns are few and fixed* — three of them, all known at write time. A
planner would add a layer with nothing to optimize.

What to read next: `05` — the write-side topics. Everything from here on is
`not yet exercised`, and the files explain why and what would change.

## Interview defense

**Q: "How does query execution work in this codebase?"**

> There's no query language and no planner — that's the honest answer. Every read
> is a hand-coded access path. There are exactly three: a point lookup via the
> PK hash index (`nodes[id]`), an index scan via the `adjacency` secondary index
> (the A* hot path), and a full scan in `nearestNode` because there's no spatial
> index. The "query plan" is whatever the programmer wrote in the function — no
> optimizer chooses it at runtime, so there's no `EXPLAIN` and no surprises.

```
  point lookup (PK seek) · index scan (adjacency) · full scan (no spatial idx)
                    no planner — the code IS the plan
```

Anchor: *the code is the plan; no planner means no surprises and no EXPLAIN.*

**Q: "Isn't A* an N+1 query problem?"**

> It has the *shape* — loop over nodes, fetch edges per node — but not the *pain*.
> N+1 hurts because each query is a round-trip with parse and network cost. Here
> the "queries" are in-memory index lookups against one loaded object, so per-
> query overhead is nanoseconds. The load-once-immutable design is exactly what
> makes the N+1 shape harmless.

```
  N+1 over network: 1000× round-trip  ✗     N+1 in-memory: 1000× hash lookup  ✓
```

Anchor: *N+1 is a round-trip problem; in-memory there are no round-trips.*

## Validate

1. **Reconstruct:** name the three access paths and the index (or absence) each
   uses. Which is the hot path?
2. **Explain:** why is the edge full scan in `geojson.ts:21` *not* a problem,
   while the node full scan in `nearest.ts:8` *is* a latent one? (The heatmap
   wants every edge; nearest wants one node but scans all — an index would help
   only the second.)
3. **Apply:** you add "show all crossings within the viewport." Write the access
   path. Is it a scan or a seek, and is there an index for it? (A filtered full
   scan of edges by `kind`; no index — and at this scale that's fine.)
4. **Defend:** someone proposes adding SQLite "so we get a real query planner."
   Argue against it for *this* access pattern, grounded in the three paths above.

## See also

- `03-btree-hash-and-secondary-indexes.md` — the indexes these paths use (and lack)
- `05-transactions-isolation-and-anomalies.md` — the write side, all not-yet-exercised
- `.aipe/study-dsa-foundations/` — A* as the algorithm behind the hot access path
