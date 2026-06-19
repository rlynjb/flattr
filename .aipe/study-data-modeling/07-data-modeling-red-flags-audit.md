# Data-modeling red-flags audit

**Industry names:** schema review · data-modeling checklist · the capstone
audit. **Type:** project-specific (this repo's findings, ranked worst-first).

---

## Zoom out, then zoom in

This is the capstone: the standard data-modeling red-flag checklist run against
flattr, ranked worst-first, each flag marked present / absent / not-applicable
with a `file:line`. Here's the whole model one more time, with each red-flag zone
marked on it.

```
  Zoom out — the red-flag zones on the model

  ┌─ Graph artifact (graph.json) ──────────────────────────────────┐
  │  ✗ no schemaVersion ........................ FLAG 1 (file 05)    │
  │  nodes: Record<id,Node>                                          │
  │  edges: Edge[]  ── fromNode/toNode FKs                           │
  │     ✗ not validated at load ................ FLAG 3 (file 04)    │
  │  adjacency: Record<id,id[]>  ── deliberate dup ⚠ FLAG 4 (file 02)│
  └───────────────────────────────┬────────────────────────────────┘
                                   │  loadGraph (bare cast)
  ┌─ Runtime queries ──────────────▼───────────────────────────────┐
  │  nearestNode(): O(N) scan, no spatial index ✗ FLAG 2 (file 03)  │
  │  A*: adjacency O(1) ........................ ✓ healthy           │
  └──────────────────────────────────────────────────────────────────┘
```

Verdict up front: **the core model is healthy — the graph shape fits the
traversal access pattern, the one hot query (neighbors) is correctly indexed,
and the denormalizations are deliberate and safe.** The flags cluster at the
*edges*: the trust boundary (no load validation, no version) and the one query
that snuck in at the UI seam (un-indexed nearest-node). None are catastrophic
today; all are cheap to fix; ignoring them turns "harmless at MVP scale" into
"silent bug at usage scale."

---

## Structure pass

The checklist is the structure. I'll trace one axis across all seven flags —
**"when does this bite?"** — because that's what separates the urgent from the
latent. A flag that bites *now* outranks one that bites *only after a schema
change or growth*.

```
  Axis — "when does it bite?" — sorts the flags

  ┌─ bites at MVP scale, today ────────────────────────────────┐
  │  FLAG 2: nearestNode O(N) — fires every tap (latent-ish:    │
  │          cheap now, scales linearly with the graph)         │
  └────────────────────────────┬───────────────────────────────┘
  ┌─ bites on a schema change ──▼───────────────────────────────┐
  │  FLAG 1: no version  — silent field skew on stale artifacts │
  │  FLAG 3: no FK validation — crash deep in A*, not at load   │
  └────────────────────────────┬───────────────────────────────┘
  ┌─ bites only if the data becomes editable ──▼────────────────┐
  │  FLAG 4: denormalization sync — fine until a write path     │
  └──────────────────────────────────────────────────────────────┘
```

The seam is "what event triggers the failure": a tap (now), a schema change
(future-but-likely), a write path (future-and-hypothetical). That ordering is
the ranking.

---

## How it works — the checklist

### Move 1 — the mental model

A red-flag audit is a `lint` pass for your schema: a fixed list of known
failure shapes, each checked against the real code, each either clean or flagged
with a location. The value isn't the abstract list — it's the *marking*, the
`file:line` next to each verdict that turns "schemas can have problems" into
"this schema has this problem here."

```
  The pattern — checklist × codebase = located verdicts

  red-flag list          this repo            verdict + location
  ─────────────          ─────────            ──────────────────
  no index on hot query  nearestNode      →   ✗ FLAG  nearest.ts:8
  same fact in 2 places  absGrade/adjacency → ⚠ INTENTIONAL grade.ts:31
  no schema version      writeGraph       →   ✗ FLAG  run-build.ts:11
  ...                    ...                  ...
```

### Move 2 — the flags, ranked worst-first

#### FLAG 1 — no schema version on the artifact `[PRESENT — file 05]`

The artifact is `JSON.stringify(graph)` with no `schemaVersion`; `loadGraph` is
a bare cast with no version read. A shipped binary bundles an old-shape JSON; if
`types.ts` changes, a renamed field reads `undefined` silently. **Why #1:** it's
the most expensive class of bug (silent data misread), it has no detection, and
the fix is ~5 lines.

```
  FLAG 1 — version skew is undetectable

  writeGraph: JSON.stringify(graph)   ✗ no stamp   (run-build.ts:11)
  loadGraph:  as unknown as Graph     ✗ no check   (loadGraph.ts:10)
  fix: Graph.schemaVersion + stamp + branch on mismatch
```

#### FLAG 2 — frequent query with no supporting index `[PRESENT — file 03]`

`nearestNode` is an O(N) full scan with a haversine per node, run on every route
request (twice). No spatial index. **Why #2:** it's the only flag that fires
*today*, on the main thread, and it degrades linearly exactly as `tiles.ts` grows
the graph. Behind FLAG 1 only because a slow scan is loud-and-fixable, where
version skew is silent.

```
  FLAG 2 — un-indexed spatial query        (nearest.ts:8)
  for id in nodes: haversine(...) → O(N) per tap
  fix: grid-bucket nodes (reuse tiles.ts:tileKeyOf) or k-d tree
```

#### FLAG 3 — no referential-integrity validation at load `[PRESENT — file 04]`

Nothing checks that `edge.fromNode`/`toNode` resolve to real nodes or that
`adjacency` edgeIds exist. A corrupt/stale artifact crashes deep in A*
(`byId.get(id)!` → undefined), not at load. **Why #3:** real gap, cheap fix
(same pass as FLAG 1), but it only bites on *corrupt* data, which is rarer than
the schema-change trigger of FLAG 1.

```
  FLAG 3 — FKs trusted, never validated   (loadGraph.ts:10 → astar.ts:65)
  build mints them correctly; runtime never re-checks
  fix: validateGraph() at load (every FK in nodes; every adj edgeId in edges)
```

#### FLAG 4 — same fact stored in two places `[PRESENT but INTENTIONAL — file 02]`

`absGradePct` (= `|gradePct|`) and `adjacency` (derivable from `edges`) are both
duplicated. **Not a bug:** both are deliberate read-optimizations, and safe
because the artifact has no runtime write path, so no UPDATE can desync them.
Flagged for completeness, marked intentional. The only soft note: `absGradePct`
is a clarity field with a marginal performance justification — the first thing
to cut under byte pressure.

```
  FLAG 4 — deliberate denormalization, safe   (grade.ts:31, graph.ts:22)
  redundant by design; no write path → cannot desync
  watch: becomes a sync obligation IF the graph ever turns editable
```

#### FLAG 5 — multi-write with no transaction `[NOT APPLICABLE — file 04]`

`not yet exercised`. One writer (`run-build.ts`) does one whole-file write; the
app reads a bundled copy, so no partial-write state is observable and there's no
multi-write set to atomicize. **Consequence of absence:** none at this scale; if
the graph became editable concurrently, atomicity (and locking around the
`edges`+`adjacency` pair) would become required.

#### FLAG 6 — relational schema fighting a document access pattern `[ABSENT — file 06]`

Clean. The storage shape (JSON document → in-memory object graph) matches the
access pattern (dense random in-memory traversal) well. No mismatch. The only
tension is *boundedness*, which `useTileGraph` already manages by building
regions on demand.

#### FLAG 7 — no discernible model / everything in one blob `[ABSENT — file 01]`

Clean. The data has a real, explicit model: `Node`/`Edge`/`Graph` with typed
fields, FK-like references, and a derived index — 28 lines of `types.ts`, not an
untyped JSON soup. The model is the opposite of this red flag.

### Move 3 — the principle

A healthy data model fails its audit at the *edges*, not the *core* — and
flattr's does exactly that. The core (entity shape, hot-query index,
denormalization discipline) is sound because it's the part the author thought
hardest about. The flags live at the trust boundary (load) and the time
boundary (schema change) — the seams where "correct by construction today"
quietly stops being true. The general lesson: audit the boundaries hardest,
because that's where the guarantees you built into the core silently expire.

---

## Primary diagram

The full audit, ranked, in one frame.

```
  flattr data-modeling audit — ranked worst-first

  #  FLAG                          STATUS         WHERE              BITES WHEN
  ─  ────                          ──────         ─────              ──────────
  1  no schema version             ✗ PRESENT      run-build.ts:11    schema change
  2  un-indexed nearest query      ✗ PRESENT      nearest.ts:8       every tap (now)
  3  no load-time FK validation    ✗ PRESENT      loadGraph.ts:10    corrupt artifact
  4  duplicated fact               ⚠ INTENTIONAL  grade.ts:31        editable graph
  5  multi-write, no transaction   — N/A          (one writer)       concurrent edits
  6  storage shape vs access       ✓ CLEAN        loadGraph/astar    —
  7  no model / one blob           ✓ CLEAN        types.ts:1–28      —

  core model: ✓ healthy   |   flags cluster at the load + time boundaries
  every PRESENT flag: cheap fix, latent today, silent-or-scaling failure later
```

---

## Implementation in codebase

### Use cases

This file is the index the others hang off — each flag's deep walk lives in the
file noted. The audit's job is the marked checklist and the ranking.

### Code, line by line

The two highest-ranked flags, side by side — both one-liners that *omit* the
guard.

```
  FLAG 1 + FLAG 3 share a home: the unguarded load boundary

  pipeline/run-build.ts:11   writeFileSync(path, JSON.stringify(graph));
                                  └─ FLAG 1: no version stamped

  mobile/src/loadGraph.ts:10  return graph as unknown as Graph;
                                  └─ FLAG 1: no version read
                                  └─ FLAG 3: no FK validation
       │
       └─ both fixes live in ONE added function called from loadGraph:
          validateGraph(raw) that checks schemaVersion AND referential
          integrity in a single pass over nodes/edges/adjacency
```

```
  FLAG 2: the un-indexed query

  features/routing/nearest.ts:8
    for (const id of Object.keys(graph.nodes)) {   ← O(N), every route req
      const d = haversine(point, {lat:n.lat, lng:n.lng});
    }
       │
       └─ fix reuses existing machinery: features/map/tiles.ts:tileKeyOf
          already buckets coords into a grid — bucket nodes the same way at
          load, scan one cell + neighbors instead of all N
```

```
  FLAG 4: the intentional duplication (NOT a bug)

  pipeline/grade.ts:31        absGradePct: Math.abs(gradePct)   ← copy
  features/routing/graph.ts:22 buildAdjacency(edges)            ← derived
       │
       └─ safe: no runtime write path (loadGraph reads only) → no desync.
          flag exists to document the deliberate trade, not to fix it.
```

---

## Elaborate

A schema red-flag checklist is the data analog of a code linter or a security
threat model: a fixed inventory of known failure shapes you run against reality
so nothing gets skipped by accident. The discipline that makes it useful is
marking the *non-findings* too — saying "FLAG 6: clean, the shape fits"
out loud is what proves you checked, versus silently not mentioning it. The
worst-first ranking is the second half of the discipline: an audit that lists ten
equal-weight findings teaches less than one that says "fix this first, this is
fine, ignore this until you add writes."

The shape of flattr's results — healthy core, flags at the boundaries — is the
common and reassuring outcome for a well-modeled system. The dangerous outcome
is the inverse: a clean-looking boundary hiding a core mismodeling (the wrong
entities, a fact with no single owner, a query the shape can't serve). flattr
doesn't have that; its core is right and its gaps are the cheap, well-understood
boundary guards (version, validation, spatial index) that every system adds as
it grows past the MVP.

This is the capstone, so it cross-links everywhere: the index gap to
`.aipe/study-database-systems/` (scan vs index), the model shape to
`.aipe/study-dsa-foundations/` (graph representation), the boundedness/scaling
tension to `.aipe/study-system-design/` (build-time artifact, datastore choice).

Read next: loop back to whichever flag you want to fix — file 05 for versioning,
file 03 for the spatial index, file 04 for load validation.

---

## Interview defense

**Q: Audit your own data model. What are its worst problems and what's fine?**

The core is healthy — the graph shape fits A*'s in-memory traversal, the hot
neighbor query is correctly indexed by `adjacency`, and the denormalizations are
deliberate and safe. The flags cluster at the boundaries, and I'd fix them in
this order: (1) no schema version on the artifact — silent field skew on stale
binaries, ~5-line fix; (2) `nearestNode` is an un-indexed O(N) scan that fires
every tap and scales linearly as the graph grows; (3) no referential-integrity
check at load, so corrupt data crashes deep in A* instead of at the boundary.
Flags 1 and 3 share one fix — a `validateGraph` at load.

```
  ranked: 1 version (silent, schema-change) > 2 nearest scan (now, scaling)
        > 3 FK validation (corrupt data) > 4 denorm (intentional, safe)
  core ✓ · boundaries ✗ · all cheap fixes
```

**Anchor:** "Healthy core, flags at the load and time boundaries — version
stamp + load validation is the highest-leverage fix, and it's one function."

**Q: Which flag is *not* actually a problem, and why does it look like one?**

The duplicated facts — `absGradePct` and `adjacency`. They look like a
normalization violation, but they're deliberate read-optimizations that are safe
because there's no runtime write path, so no UPDATE can desync them. The sync
obligation only materializes if the graph ever becomes editable.

**Anchor:** "Denormalization is only dangerous with a write path — I have none,
so the duplication is free."

---

## Validate

1. **Reconstruct.** From memory, list the three PRESENT flags in rank order with
   their `file:line`. Check against `run-build.ts:11`, `nearest.ts:8`,
   `loadGraph.ts:10`.
2. **Explain.** Why do FLAG 1 and FLAG 3 share a single fix? (Both are missing
   guards at the same load boundary — one `validateGraph` checks version *and*
   referential integrity in one pass.)
3. **Apply.** You have one afternoon. Which flag do you fix and why? (FLAG 1 +
   FLAG 3 together — the `validateGraph` function — highest leverage, smallest
   surface, closes the silent-misread class.)
4. **Defend.** Argue why FLAG 4 (duplication) should *not* be "fixed." (No write
   path → no desync; both copies are deliberate read-optimizations; removing
   `adjacency` would make the hot query O(E) — `astar.ts:64`.)

---

## See also

- `01-the-data-model-and-its-shape.md` — FLAG 7 (clean: real model).
- `02-normalization-and-duplication.md` — FLAG 4 (intentional duplication).
- `03-indexing-vs-query-patterns.md` — FLAG 2 (un-indexed nearest query).
- `04-transactions-and-integrity.md` — FLAG 3 + FLAG 5.
- `05-migrations-and-evolution.md` — FLAG 1 (no schema version).
- `06-access-patterns-and-storage-choice.md` — FLAG 6 (clean: shape fits).
