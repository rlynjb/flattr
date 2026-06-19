# Transactions and integrity

**Industry names:** referential integrity · foreign-key constraints · node
snapping (vertex deduplication) · load-time validation. **Type:** language-
agnostic principle; flattr's enforcement points are project-specific.

---

## Zoom out, then zoom in

Integrity is the question "can the data be in a state that's structurally
impossible to interpret?" In a relational DB, foreign keys, unique constraints,
and transactions are the machinery that says *no*. flattr has no DB, so every
integrity guarantee is either hand-enforced in the pipeline or — and this is the
finding — not enforced at all. Here's where the guards live, and where they're
missing.

```
  Zoom out — where integrity is (and isn't) enforced

  ┌─ Build pipeline (where guards exist) ───────────────────────┐
  │  osm.ts    → drops ways referencing unknown OSM nodes        │
  │  split.ts  → snapKey() snaps coincident vertices to ONE id   │ ← guards here
  │              (the "don't make a disconnected graph" rule)    │
  └───────────────────────────────┬─────────────────────────────┘
                                   │  graph.json (FK refs frozen in)
  ┌─ Runtime load (where guards are MISSING) ──────▼────────────┐
  │  loadGraph() = `graph as unknown as Graph`  ← NO validation │ ← gap here
  │  A* later: byId.get(edgeId)!  / nodes[id]   ← trusts the FKs │
  └──────────────────────────────────────────────────────────────┘
```

Verdict up front: flattr has **one real integrity mechanism — node snapping at
build time** — which prevents the worst structural failure (a graph where
visually-connected streets are actually disconnected). But the FK-like
references (`edge.fromNode`, `edge.toNode` → a real node id) are **enforced
nowhere**: the pipeline produces them correctly by construction, and the runtime
trusts them blindly with a bare type cast. There is no load-time validation and
no transaction concept. That's defensible for a build-time artifact you control,
but it's a sharp edge: a corrupt or hand-edited `graph.json` fails deep inside
A* with a confusing `undefined` deref, not at load with a clear error.

---

## Structure pass

Two layers (build, runtime). I'll trace the axis **"who guarantees this
reference resolves?"** — the FK question — across both, because that's where the
guarantee evaporates.

```
  Axis — "who guarantees edge.fromNode points at a real node?" — by layer

  ┌─ Build layer ──────────────────────────────────────────────┐
  │  split.ts MINTS both the node and the edge.fromNode id in   │
  │  the same pass (nodeId() creates the node, returns its id,  │
  │  the edge stores that id). Guaranteed BY CONSTRUCTION.      │
  └────────────────────────────┬───────────────────────────────┘
                  seam: artifact serialized to disk
                  (the guarantee is now an ASSUMPTION)
  ┌─ Runtime layer ────────────▼───────────────────────────────┐
  │  loadGraph() casts JSON to Graph with NO check.             │
  │  A* does nodes[id] / byId.get(id)! and TRUSTS it resolves.  │
  │  guaranteed by: nobody. Hope + the fact you built the file. │
  └──────────────────────────────────────────────────────────────┘
```

**The seam is serialization to disk.** On the build side, integrity is a
structural guarantee — the same code that creates a node hands its id to the
edge, so a dangling reference is impossible. The moment the graph is
`JSON.stringify`'d and re-read, that guarantee downgrades to an *assumption*: the
runtime can't tell a valid artifact from a corrupt one, because it never checks.
In a relational DB the FK constraint persists across that boundary (it's stored
in the schema); flattr's "constraint" lives only in the build code and doesn't
survive serialization.

---

## How it works

### Move 1 — the mental model

You know this from rendering a list with `.map()` and a `key`: React trusts that
every `key` is unique and stable. If two items share a key, React doesn't throw —
it silently reconciles wrong, and you get a baffling bug far from the cause. A
foreign key is the same trust relationship between rows: `edge.fromNode` is a
"key" into `nodes`, and *something* has to guarantee it resolves. Either the
database enforces it (FK constraint) or you're trusting it like a React key —
fine until it isn't.

```
  The pattern — FK integrity: a reference that must resolve

  edge.fromNode = "n5"
         │
         ▼  must exist
  nodes["n5"]  ──►  { id:"n5", lat, lng, elev }   ✓ resolves
         │
         ▼  if "n5" was never created…
  nodes["n5"]  ──►  undefined  ──►  later: undefined.elevationM  ✗ crash
                                    (far from the real cause)
```

### Move 2 — the parts, one at a time

#### Node snapping — the one real integrity guard

The structural invariant that *matters most* for a routing graph: two streets
that cross at a point must share a node, or the router can't turn from one onto
the other. OSM gives you separate ways with coincident endpoints; if you minted
a fresh node id per way, the crossing streets would be disconnected and A* would
report "no route" between visually-adjacent points. `split.ts` prevents this
with `snapKey` — round the coordinate to 7 decimals, and identical coordinates
map to the *same* node id.

```
  Node snapping — coincident vertices become ONE node

  way A endpoint (47.6231367, -122.3278253) ─┐
                                              ├─ snapKey → same key
  way B endpoint (47.6231367, -122.3278253) ─┘   → same node id "n0"
         │
         ▼  both ways' edges now reference n0
  adjacency[n0] = [eA, eB]   ← the crossing is connected; A* can turn
```

The boundary condition: this is the difference between a connected graph and a
pile of disconnected line segments. Drop the snapping and `nearestNode` might
snap your tap to a node that A* can't escape because nothing else references it —
the spec's "no route" (disconnected) failure, which it deliberately keeps
distinct from "no flat route" (`BLOCKED`). The snap precision (7 decimals ≈ 1cm)
is the tuning knob: too coarse and distinct nearby intersections collapse into
one; too fine and truly-coincident OSM vertices fail to merge.

#### The FK-like references — minted correctly, enforced nowhere

`edge.fromNode` and `edge.toNode` are foreign keys into `nodes`. At build time
they're correct by construction: `split.ts`'s `nodeId()` helper creates the node
*and* returns the id the edge stores, in one call. There's no window where an
edge references a node that doesn't exist.

```
  FK minting — node and reference created together (build time)

  fromNode = nodeId(a)   ←┐ nodeId() creates nodes[id] if absent,
  toNode   = nodeId(b)   ←┘ returns the id the edge will store
       │
       ▼
  edges.push({ fromNode, toNode, ... })  ← references can't dangle:
                                            the node was just created
```

But there is **no enforcement that survives to runtime**. `loadGraph` is one
line: `return graph as unknown as Graph`. A double cast — it tells TypeScript
"trust me" and does zero runtime checking. If the bundled `graph.json` were
truncated, hand-edited, or written by an older pipeline with a renamed field,
nothing catches it at load. The failure surfaces later, inside A*, as
`byId.get(edgeId)!` returning `undefined` and the non-null assertion crashing on
the next property access — a stack trace pointing at the router, not the data.

```
  the missing guard — no load-time validation

  graph.json (possibly corrupt)
       │
       ▼
  loadGraph(): `graph as unknown as Graph`   ← NO check, NO error here
       │
       ▼ (much later, inside A*)
  byId.get(edgeId)!  → undefined  → undefined.fromNode  ✗ crash far from cause
       │
       └─ a 10-line validateGraph() at load — "every edge.fromNode/toNode is a
          key in nodes; every adjacency edgeId exists" — would turn this into a
          clear error at the boundary. It does not exist.
```

#### Transactions — not applicable, and that's correct

There's no transaction concept, and there shouldn't be: a transaction guarantees
a *set of writes* commit atomically. flattr has one writer (`run-build.ts`) doing
one `writeFileSync` of the whole artifact. There's no partial-write window
visible to readers (the app bundles the file at build, not mid-write). The
closest thing to an atomicity concern is that `writeGraph` isn't atomic on disk
(no write-to-temp-then-rename), so a crash mid-write could leave a truncated
`graph.json` — but since the app consumes a *bundled* copy, not the live file, a
reader never sees the half-written state. **Transactions: not exercised, and not
needed at this scale.**

### Move 2.5 — current state vs an editable future

Today integrity is build-time-structural and runtime-trusted. If the graph
became editable at runtime (file 02's Phase B), every guard would need to move
across the serialization seam.

```
  Phase A (now)                    Phase B (editable graph)
  ───────────                      ────────────────────────
  FK valid by construction         FK must be CHECKED on every write
  no load validation needed*       load validation mandatory
  one writer, one write            concurrent edits → need atomicity/locks
  *(still a sharp edge for         add edge → must also touch adjacency
   corrupt/stale artifacts)         transactionally (else index lies)
```

### Move 3 — the principle

Integrity is a property of the *data*, but it can only be guaranteed by
*something that runs*. A foreign key that's "always correct because of how we
build it" is correct exactly until someone builds it differently or the file
gets corrupted — because the guarantee lives in code, not in the data. The
durable move is to make the data self-checking at the trust boundary: validate
at load, where the cost is one pass and the payoff is errors that point at the
real cause. flattr enforces the integrity invariant that *would silently corrupt
routing* (node snapping) and skips the one that *would only crash loudly* (FK
validation) — a reasonable triage, but the FK check is cheap enough that its
absence is a genuine gap, not a deliberate trade.

---

## Primary diagram

Every integrity guarantee, where it's enforced, and where it's only assumed.

```
  flattr's integrity guarantees — enforced vs assumed

  INVARIANT                         ENFORCED BY            WHERE
  ─────────                         ───────────            ─────
  crossing streets share a node     snapKey() (snapping)   split.ts:9 ✓ build
  ways ref only known OSM nodes      coordsById guard       osm.ts:18  ✓ build
  edge.fromNode/toNode → real node   construction only      split.ts   ✓ build
       │                             …NOT re-checked         ✗ runtime (gap)
  adjacency edgeIds exist            construction only       ✗ runtime (gap)
  artifact shape is current          — nothing —             ✗ (file 05)
  atomic multi-write                 N/A (one whole-file     — not needed —
                                      write, bundled copy)

  ┌─ the trust boundary ──────────────────────────────────────────┐
  │  build: integrity GUARANTEED ──serialize──► runtime: ASSUMED   │
  │         (lives in code)         (cast, no check)               │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

- **Building the graph from OSM** → snapping (`split.ts`) and the unknown-node
  drop (`osm.ts`) enforce structural integrity.
- **Loading the artifact at app start** → `loadGraph` trusts it entirely.
- **Routing** → A* dereferences FKs (`nodes[id]`, `byId.get(id)!`) assuming they
  resolve.

### Code, line by line

The one real integrity guard — coincident-vertex snapping.

```
  pipeline/split.ts (lines 9–11, 47–56)

  function snapKey(p: LatLng): string {
    return `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;   ← round to ~1cm
  }                                                        identical coords →
                                                           identical key
  function nodeId(p: LatLng): string {
    const key = snapKey(p);
    let id = keyToId.get(key);
    if (id === undefined) {                  ← first time we see this coord:
      id = `n${nodeCounter++}`;              ← mint a new node id
      keyToId.set(key, id);
      nodes[id] = { id, lat: p.lat, lng: p.lng, elevationM: 0 };
    }
    return id;                               ← same coord again → SAME id
  }                                             (the snapping; keeps the
                                                 graph connected)
```

The unknown-node guard at parse time — the FK check that *does* exist (build).

```
  pipeline/osm.ts (lines 16–20)

  for (const nodeId of el.nodes) {
    const c = coordsById.get(nodeId);
    if (c) coords.push(c);            ← only keep nodes we have coords for
  }                                      (a referential check: way → node)
  if (coords.length < 2) continue;    ← drop ways that lost too many refs
       │
       └─ this is the one FK-style validation in the codebase — and it's
          build-time, on OSM's node refs, not on the final graph's edge FKs
```

The missing runtime guard — the bare cast.

```
  mobile/src/loadGraph.ts (lines 9–11)

  export function loadGraph(): Graph {
    return graph as unknown as Graph;   ← double cast: ZERO runtime validation
  }                                        of FKs, ids, field shape
       │
       └─ no validateGraph() exists. A corrupt/stale artifact passes load
          silently and crashes later in A* (byId.get(id)! → undefined).
```

The trusting dereference downstream — where the absence bites.

```
  features/routing/astar.ts (line 65)

  const edge = byId.get(edgeId)!;   ← `!` asserts non-null with no check
       │
       └─ if adjacency lists an edgeId not in `edges` (a broken artifact),
          this is undefined; the next line (otherEnd(edge, current)) throws
          deep in the search, not at load
```

---

## Elaborate

Referential integrity is the relational model's defining guarantee: a foreign
key constraint means the database physically refuses to store an edge pointing
at a nonexistent node (`ON DELETE RESTRICT/CASCADE` decides what happens to
edges when a node goes away). flattr replaces the constraint with a build-time
invariant, which is the standard tradeoff for read-only derived data — you trust
the producer instead of the store. The risk is the same one denormalization
carries: the guarantee lives in code that could change, not in the data that
gets read.

The node-snapping problem is specific to spatial/graph data and shows up
everywhere geometry meets topology: GIS systems call it "snapping" or "noding,"
GPU mesh tools call it "vertex welding," and they all solve it the same way —
quantize coordinates to a tolerance and merge anything that collapses to the
same bucket. The 7-decimal `toFixed` is a coordinate quantization; the tolerance
*is* the modeling decision (file 03's grid-cell idea is the same quantize-to-a-
bucket move applied to a different query).

The honest gap — load-time validation — is the cheapest integrity win available:
a single pass asserting "every `edge.fromNode`/`toNode` is a key in `nodes`,
every `adjacency` edgeId is in `edges`" converts silent corruption into a loud,
located error. It pairs naturally with file 05's missing schema version: a
validator is also the natural place to check the version.

Read next: file 05 (the artifact has no version field — the integrity gap that's
about *time*, not references).

---

## Interview defense

**Q: How do you guarantee referential integrity without a database?**

Two halves, honestly. The FK-like refs (`edge.fromNode`/`toNode` → a node id)
are correct *by construction* — the build code that creates a node hands its id
to the edge in the same pass, so a dangling ref is impossible at build time. But
that guarantee doesn't survive serialization: at runtime `loadGraph` is a bare
cast with no validation, so a corrupt artifact crashes deep in A* instead of
failing at load. The one invariant I *do* enforce structurally is node snapping —
coincident vertices snap to one id, which keeps crossing streets connected.

```
  build: FK correct by construction ──serialize──► runtime: trusted, unchecked
  (the guarantee lives in code, not in the data → doesn't cross the boundary)
```

**Anchor:** "Snapping prevents the silent failure (disconnected graph); FK
validation prevents the loud one (crash) — I do the first, and a 10-line
load-time `validateGraph` is the cheap fix for the second."

**Q: Do you need transactions?**

No. One writer, one whole-file write, and the app consumes a bundled copy — so
there's no partial-write state a reader can observe and no multi-write set to
make atomic. The only latent issue is `writeGraph` isn't write-to-temp-then-
rename, but since readers never touch the live file, it doesn't matter.

**Anchor:** "Transactions guard concurrent multi-writes; I have one writer doing
one write — not exercised, not needed."

---

## Validate

1. **Reconstruct.** Name flattr's one structural integrity guard and the failure
   it prevents. Check `pipeline/split.ts:9` (snapping → connected graph).
2. **Explain.** Why does a broken `edge.fromNode` crash in A* rather than at
   load? Trace `loadGraph`'s bare cast (`loadGraph.ts:10`) to
   `byId.get(edgeId)!` (`astar.ts:65`).
3. **Apply.** Write the signature and three assertions of a `validateGraph(g)`
   that closes the load-time gap. (Every `edge.fromNode`/`toNode` in `g.nodes`;
   every `adjacency` edgeId in the edge set; every adjacency key in `g.nodes`.)
4. **Defend.** A reviewer says "add FK constraints like a real DB." Explain what
   replaces them here and why the build-time guarantee is weaker. (Construction-
   time correctness lives in code, not data, so it doesn't survive serialization —
   `split.ts` vs `loadGraph.ts`.)

---

## See also

- `02-normalization-and-duplication.md` — the sync obligation a write path adds.
- `05-migrations-and-evolution.md` — the no-version gap a validator would also
  catch.
- `03-indexing-vs-query-patterns.md` — the FK refs the queries traverse.
- `.aipe/study-database-systems/` — FK constraints, atomicity, durability.
