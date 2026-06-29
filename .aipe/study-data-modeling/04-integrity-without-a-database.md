# Integrity without a database

**Industry name:** referential integrity (FK constraints) and schema versioning —
both absent here; the manual stand-ins are *producer-side validation* and a
*missing version sentinel*. **Type label:** Industry standard (the concepts),
Project-specific (what's missing).

---

## Zoom out, then zoom in

A database enforces invariants for you: a foreign key *can't* point at a row that
doesn't exist, a `NOT NULL` column *can't* be null, a `CHECK` *can't* be violated.
flattr has no engine, so every one of those invariants is either enforced by build
code or not enforced at all. Here's the trust boundary:

```
  Zoom out — where invariants are (and aren't) enforced

  ┌─ Build pipeline (producer) ─────────────────────────────────┐
  │  computeGrades clamps |grade| ≤ 40   ✓ partial enforcement   │
  │  splitWays skips zero-length edges    ✓                      │
  │  buildAdjacency built from edges      ✓ (so adj is consistent)│
  └───────────────────────────┬──────────────────────────────────┘
                              │  graph.json  ── NO VALIDATION HERE ──
  ┌─ loadGraph (consumer) ────▼──────────────────────────────────┐
  │  graph as unknown as Graph   ✗ blind cast, no checks         │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  assumed-valid Graph
  ┌─ A* / heatmap ────────────▼──────────────────────────────────┐
  │  graph.nodes[edge.toNode]  ── crashes HERE if FK is dangling  │
  └────────────────────────────────────────────────────────────── ┘
```

Zoom in: the gap is the arrow between producer and consumer. `loadGraph` casts the
JSON to `Graph` with zero validation, so any invariant the producer didn't enforce
surfaces as a crash *deep in traversal*, not at load. The question: **which
invariants does this model assume, which are actually guarded, and where does a
violation blow up?**

## Structure pass

**Layers — the invariants the model depends on, by who (if anyone) enforces them:**

```
  Invariant → enforcer → where a violation surfaces

  referential: every edge.fromNode/toNode ∈ nodes
     enforcer: NONE        surfaces: A* deref, mid-search crash
  field range: |gradePct| ≤ MAX_GRADE_PCT
     enforcer: grade.ts:30 (producer)   surfaces: clamped at build, OK
  no self-loops: fromNode ≠ toNode
     enforcer: split.ts:65 (producer)   surfaces: skipped at build, OK
  schema match: graph.json fields = types.ts
     enforcer: NONE        surfaces: undefined arithmetic, silent
  adjacency consistent with edges
     enforcer: buildAdjacency (producer) surfaces: consistent by construction
```

**Axis traced — "if this invariant is violated, when do I find out?"** Hold it across
the rows. Range and self-loop violations: found out *at build* (the producer fixes
them). Schema-match and referential violations: found out *at use*, deep in
traversal, as `undefined` — the worst time, because the symptom is far from the cause.
The axis-answer flips between "producer-guarded → caught early" and "unguarded →
caught late, or never."

**Seam:** the `loadGraph` cast (`mobile/src/loadGraph.ts:10`). That's the boundary
where an external artifact becomes a trusted in-memory object — and it's where a
validator *should* live and doesn't. Every late-surfacing bug crosses this seam
unchecked. It's the one place to add a guard.

## How it works

### Move 1 — the mental model

You know this from `fetch`. When you do `const data = await res.json() as User`,
TypeScript believes you — the `as` is a *promise to the compiler*, not a check at
runtime. If the API returns a different shape, nothing throws *there*; it throws three
components later when you read `data.profile.name` and `profile` is undefined. That's
exactly `loadGraph`'s `graph as unknown as Graph`: a promise, not a check. The bug
lands far from the lie.

```
  the unchecked-boundary failure shape

  external data ──► cast `as Graph` ──► trusted everywhere ──► deref undefined
   (graph.json)      (the lie)          (no guard)            (the crash, far away)
                          ▲                                        ▲
                          └────────── distance between ────────────┘
                                      cause and symptom
```

The strategy a validator would impose: **check the shape and the invariants at the
boundary, once, so a violation fails loud and early instead of quiet and deep.**

### Move 2 — the walkthrough

#### Gap 1 — no referential integrity on edge endpoints (worst)

Every edge claims two foreign keys: `fromNode` and `toNode`, each supposedly a node
id in `nodes`. Nothing checks that they exist. Walk what happens when one is
dangling — say an edge points at `toNode: "n999"` that isn't in `nodes`. A\* expands:

```ts
// features/routing/astar.ts:64-72
for (const edgeId of graph.adjacency[current] ?? []) {
  const edge = byId.get(edgeId)!;
  const next = otherEnd(edge, current);          // next = "n999" (dangling)
  if (closed.has(next)) continue;
  const tentative = g.get(current)! + costFn(edge, current, userMax);
  if (tentative < (g.get(next) ?? Infinity)) {
    g.set(next, tentative);
    came.set(next, { edge, prev: current });
    open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
    //                                       ▲ graph.nodes["n999"] = undefined
    //                                       heuristicFn derefs .lat → CRASH
  }
}
```

`heuristicFn` is `haversineHeuristic` (`astar.ts:9`), which reads `node.lat` /
`node.lng`. On `undefined`, that's a `Cannot read property 'lat' of undefined` —
thrown deep in the search loop, with a stack trace pointing at the heuristic, not at
the bad edge. The cause (a dangling FK in `graph.json`) is invisible from the symptom.
A database would have refused the edge at insert; here nothing refuses it, ever.

```
  dangling FK: where the database would have stopped it

  WITH FK constraint:  INSERT edge(to:n999) ──► REJECTED at write   (early, clear)
  flattr (none):       edge(to:n999) ships ──► A* derefs nodes[n999]
                                              ──► undefined.lat ──► CRASH  (late, cryptic)
```

The fix is a load-time validator: for every edge, assert `fromNode in nodes` and
`toNode in nodes`. One pass, O(E), at `loadGraph`. Fails loud, names the bad edge,
before any search runs.

#### Gap 2 — no schema version on the artifact (silent drift)

The shipped `graph.json` top-level keys are exactly `{city, bbox, nodes, edges,
adjacency}` — verified, no `version` or `schemaVersion`. The type that reads it lives
in `types.ts` and evolves with the code. So picture the drift: someone renames
`gradePct` → `grade` in `types.ts` and the pipeline, ships an app build, but the
bundled `graph.json` is the *old* one (forgot to re-run `build:graph` and re-copy).

```ts
// mobile/src/loadGraph.ts:9-11
export function loadGraph(): Graph {
  return graph as unknown as Graph;   // old JSON, new type — cast says "trust me"
}
```

The cast succeeds (it's compile-time only). Now `cost.ts` reads `edge.gradePct` and
gets `undefined`, `1 + penalty(undefined, max)` is `NaN`, the whole route's cost is
`NaN`, and A\* either returns a garbage path or no path — *silently*. No crash, no
error, just wrong answers. There's no sentinel that says "this artifact was built for
schema v2 and you're running v3, refuse to load." That sentinel is one integer field
and one equality check, and it's absent.

```
  schema drift with no version field

  types.ts (v3): edge.grade        graph.json (v2): edge.gradePct
        │                                  │
        └──────── loadGraph cast ──────────┘
                       │ no version check
                       ▼
              edge.grade = undefined ──► NaN cost ──► silent wrong route
```

#### Gap 3 — what IS enforced (the producer's partial guard)

Credit where due: the build pipeline *does* enforce two invariants, producer-side:

```ts
// pipeline/grade.ts:30 — field-range constraint (a CHECK, by hand)
const gradePct = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, raw));
```

```ts
// pipeline/split.ts:65 — no self-loop edges
if (fromNode === toNode) continue; // coincident after snapping
```

And adjacency is *consistent by construction* — `buildAdjacency` derives it from
edges, so it can't reference an edge that isn't in `edges` (`graph.ts:22`). These are
real integrity guarantees; they're just all on the *producer* side. The asymmetry is
the lesson: the producer guards what it can see at build time (grade range,
self-loops), but nothing guards the *consumer* against a bad or stale artifact,
because the consumer trusts the cast.

#### Transactions — honestly not exercised

There are no runtime writes to the graph. `loadGraph` reads; A\* and the heatmap read;
`useTileGraph` builds *new* graph objects and merges, never mutating the base in place.
So there's nothing to make atomic — no multi-write operation that could half-succeed.
"No transactions" here isn't a gap; it's the correct answer for a read-only artifact.
The integrity concern that *does* apply is the boundary check, not atomicity.

### Move 2 variant — the load-bearing skeleton

The kernel of "integrity without an engine" is a boundary validator. Three parts —
what breaks without each:

1. **A single check point at the trust boundary.** The `loadGraph` cast is where
   external data becomes trusted. Drop the idea of checking here (validate scattered
   in every consumer) and the checks rot — some paths validate, some don't, exactly
   today's state where the producer guards some things and the consumer none.
2. **Invariant assertions, not just shape.** "Has the right fields" (a shape check,
   e.g. zod) is necessary but not sufficient — you also need "every FK resolves,"
   "adjacency matches edges." Drop the invariant assertions and you catch typos but
   not dangling references — the worst gap (Gap 1) survives.
3. **A version sentinel that refuses on mismatch.** One integer in the artifact, one
   equality check at load. Drop it and stale-artifact drift (Gap 2) is silent forever.

Optional hardening: making the validator *run in CI on the built artifact*, so a bad
`graph.json` never ships. None of the three parts exists today; the producer's
build-time guards (Gap 3) are the closest thing, and they don't cover the consumer.

### Move 3 — the principle

Integrity is about *when* you find out a fact is wrong, and the whole game is moving
that moment earlier — to the write (a DB's FK), or failing that, to the load (a
boundary validator), never to the deref three layers in. A database buys you "early
and loud" for free; without one, you buy it by hand with a validator at the single
seam where untrusted data becomes trusted. flattr skipped that buy: the cast is a
promise, not a check, so its two real integrity bugs (dangling FK, schema drift) both
surface late and cryptic. The transfer: **every `as` cast over external data is an
unpaid integrity debt; pay it with one validator at the boundary, and the deep
mysterious crash becomes a clear message before anything runs.**

## Primary diagram

The trust boundary, the invariants, and where each violation surfaces — the whole
integrity story in one frame.

```
  Integrity in flattr — enforced, unenforced, and the crash sites

  PRODUCER (build) ── enforces ──┐        graph.json        CONSUMER (runtime)
  ┌──────────────────────────┐   │   ┌──────────────────┐   ┌────────────────────┐
  │ grade.ts:30  |grade|≤40  │───┘   │ {city,bbox,nodes,│   │ loadGraph()        │
  │ split.ts:65  no self-loop│       │  edges,adjacency}│──►│ `as Graph`         │
  │ buildAdjacency consistent│       │  NO version field│   │ ✗ NO validation    │
  └──────────────────────────┘       └──────────────────┘   └─────────┬──────────┘
        ✓ caught at build                ✗ no FK check                 │
                                         ✗ no version              trusted Graph
                                                                       ▼
                              ┌──────────────────────────────────────────────────┐
                              │ A* / cost / heatmap                              │
                              │  dangling FK → nodes[id]=undefined → CRASH (deep)│
                              │  schema drift → field=undefined → NaN cost (silent)│
                              └──────────────────────────────────────────────────┘
        the fix: one validator at the loadGraph seam — assert FKs resolve,
                 assert version matches — turns "deep/silent" into "early/loud"
```

## Elaborate

Referential integrity is the database promise that a relationship can't point at
nothing — implemented as a FK constraint the engine checks on every write. Schema
versioning is the same idea over time: a stored format version so a reader can refuse
data it wasn't built for (every migration framework stamps one; every binary format
from PNG to Protobuf carries one). flattr has neither because it has no engine and no
migration framework — and that's a *defensible* place to be for a hand-built static
artifact, right up until the artifact is wrong. The honest framing: the producer-side
guards (grade clamp, self-loop skip) show the team thinks about integrity; the missing
consumer-side validator shows where the no-database choice left a hole. A zod schema +
an FK-resolution pass + a version int at `loadGraph` closes all three gaps in one
function.

Read next: `05` — how the artifact is built and evolved, which is where the missing
version field would get stamped.

## Interview defense

**Q: There's no database. What enforces that an edge's `fromNode` and `toNode`
actually exist?**

Nothing — that's the worst gap. There's no FK constraint and no load-time check.
`loadGraph` casts the JSON `as Graph` with zero validation (`loadGraph.ts:10`), so a
dangling endpoint ships fine and crashes deep in A\*: `graph.nodes[danglingId]` is
`undefined`, the haversine heuristic derefs `.lat`, and you get a cryptic
"undefined.lat" with a stack trace pointing at the heuristic, not the bad edge. A
database would've rejected the edge at insert. The fix is one O(E) pass at load
asserting every FK resolves — turns a deep cryptic crash into an early named error.

```
  WITH FK:   reject at write   (early, clear)
  flattr:    crash at deref    (late, cryptic)  ← one load-time validator fixes this
```

Anchor: *"No referential integrity — a dangling edge endpoint crashes deep in A\* as
undefined.lat; the fix is one FK-resolution pass at the loadGraph boundary."*

**Q: The graph is a bundled JSON file and the type is in code. What stops them from
drifting?**

Nothing — `graph.json` has no schema version field (verified: keys are just
`city/bbox/nodes/edges/adjacency`). Rename a field in `types.ts` without re-building
and re-bundling the artifact, and the cast still succeeds while the renamed field
reads `undefined` — `NaN` costs, silently wrong routes, no error. The standard guard
is a version sentinel: one integer in the artifact, one equality check at load that
refuses a mismatch. It's absent. That's the single cheapest integrity win available
here.

Anchor: *"No version on the artifact — a stale graph.json against a renamed type
fails silently as NaN costs; one version int + an equality check at load stops it."*

## See also

- `01-graph-as-the-schema.md` — the FKs (`fromNode`/`toNode`) this file guards.
- `03-missing-indexes-and-scans.md` — `edgeById`'s throw is the one place a missing
  edge *does* fail loud.
- `05-build-and-evolve-the-artifact.md` — where the version sentinel would be stamped.
- `study-security` — the trust boundary at `loadGraph`; the cast as an unchecked input.
