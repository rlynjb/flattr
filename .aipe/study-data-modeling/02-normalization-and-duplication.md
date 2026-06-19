# Normalization and duplication

**Industry names:** denormalization · precomputed / materialized derived
columns · single source of truth. **Type:** language-agnostic (the DB-modeling
principle; flattr's instance is project-specific).

---

## Zoom out, then zoom in

Normalization is information-hiding for data: each fact lives in exactly one
place, and everything else points at it. flattr stores several facts *more than
once* on purpose — and the interesting question is which duplications are
deliberate read-optimizations and which would be a bug. Here's where these
fields sit.

```
  Zoom out — where the duplicated facts live

  ┌─ Build pipeline (writes once) ──────────────────────────────┐
  │  grade.ts    →  computes lengthM, riseM, gradePct, absGrade  │
  │  graph.ts    →  computes adjacency from edges                │ ← we are here
  └───────────────────────────────┬─────────────────────────────┘
                                   │  frozen into graph.json
  ┌─ Runtime (reads only) ─────────▼────────────────────────────┐
  │  cost.ts uses gradePct        zones.ts uses absGradePct      │
  │  A* uses adjacency            (nothing recomputes them)      │
  └──────────────────────────────────────────────────────────────┘
```

The verdict up front: flattr has **two deliberate denormalizations** —
`absGradePct` (a precomputed `|gradePct|`) and the entire `adjacency` index
(precomputed from `edges`) — and **zero accidental ones**. No source fact is
editable in two places, because the artifact is read-only at runtime. That's the
cleanest possible normalization story, and the reason is structural: a build-
time-only artifact can denormalize freely, because there's no UPDATE path to
fall out of sync.

---

## Structure pass

Three layers, and I'll trace the axis **"if I changed the underlying fact, what
else would have to change?"** — which is exactly the question normalization
answers. Where the answer is "nothing else, it's the only copy" you're
normalized; where it's "N other places" you've denormalized and bought a sync
obligation.

```
  Axis — "change this fact, what else must change?" — down the layers

  ┌─ Layer 1: SOURCE facts (one copy each) ─────────────────────┐
  │  elevationM   → nothing else holds it. NORMALIZED.          │
  │  geometry     → nothing else holds it. NORMALIZED.          │
  └────────────────────────────┬───────────────────────────────┘
                               │  derive
  ┌─ Layer 2: DERIVED + stored (a 2nd copy of a fact) ─────────▼┐
  │  gradePct     → derived from elev+geom; stored.             │
  │  absGradePct  → derived from gradePct; stored. (a 3rd copy) │
  │  adjacency    → derived from edges' from/to; stored.        │
  │     change elevation → ALL of these go stale. DENORMALIZED. │
  └────────────────────────────┬───────────────────────────────┘
                               │  read-only at runtime
  ┌─ Layer 3: the saving grace ────────────────────────────────▼┐
  │  no runtime writes → no UPDATE can desync the copies.       │
  │  the only "sync" is a full rebuild (run-build.ts).          │
  └──────────────────────────────────────────────────────────────┘
```

**The seam that matters is between Layer 2 and Layer 3.** In a normal CRUD
database, that boundary is where denormalization gets dangerous — an UPDATE to
the source that forgets to update the copies leaves the data lying. flattr
*doesn't have that boundary as a live path*: there's no UPDATE, only a full
rebuild. So the denormalizations cost nothing in correctness; they only cost
artifact size and a rebuild step. That's why they're the right call.

---

## How it works

### Move 1 — the mental model

You know this from React already: derived state. You don't store
`fullName` in `useState` next to `firstName` and `lastName` — you compute it on
render, because storing it means two places to keep in sync. *Unless* the
computation is expensive and the inputs rarely change — then you `useMemo` it.
Denormalization is `useMemo` for your database: cache the derived value when
recomputing it on every read would cost more than the staleness risk.

```
  The pattern — normalized vs denormalized

  NORMALIZED (one copy, compute on read):
    elevationM ──derive──► grade (computed live, every read)
       │                     fresh always, but pays compute each read

  DENORMALIZED (cache the derived value):
    elevationM ──derive once──► [gradePct stored] ──► read (cheap)
       │                              │
       └─ change source ──────────────┘ now stale until rebuild
                                         (the sync obligation)
```

### Move 2 — the parts, one at a time

#### `gradePct` — derived from elevation, stored

`gradePct` is `(elev(to) − elev(from)) / lengthM * 100`. It's a pure function of
two source facts: elevation and geometry. flattr computes it once at build
(`grade.ts`) and stores it on every edge. The alternative — storing only
`elevationM` per node and computing grade live in the A* cost function — would
keep the artifact smaller and the data strictly normalized, but every edge
expansion would redo a haversine-length + division.

```
  gradePct — precomputed derived column

  build time:   geometry + elevation  ──►  gradePct stored on edge
  runtime read: cost.ts reads edge.gradePct directly (no recompute)
                            │
                            └─ sync obligation: if elevation changes,
                               gradePct is stale until full rebuild
```

The boundary condition: this is only safe because nothing edits `elevationM` at
runtime. In a CRUD app where a user could correct an elevation, storing
`gradePct` would mean a trigger or a recompute-on-write — or stale grades.

#### `absGradePct` — a third copy of the same fact

This is the one to scrutinize, because it's a copy of a copy. `absGradePct` is
just `Math.abs(gradePct)`. It exists because the **heatmap** reads steepness
without a travel direction (file 01's seam-2), and it doesn't want to call
`Math.abs` per edge on every render. So flattr stores it.

```
  absGradePct — denormalized for the heatmap reader

  gradePct: +3.2  ──Math.abs──►  absGradePct: 3.2  (stored alongside)
                                       │
       two readers, two fields:        ▼
   routing → gradePct (signed)    heatmap → absGradePct (magnitude)
   "one graph, two readings" (spec §4.1)
```

Is storing `Math.abs(x)` worth it? Honest answer: it's a marginal call. The
compute saved is trivial (one `abs`). The real reason it earns its place is
*semantic*, not performance: it names the two readings explicitly so a reader of
the schema sees "this field is for the heatmap, that one for routing" without
chasing call sites. That's denormalization for clarity, not speed — a weaker
justification, but defensible in a schema this small. If you were trimming
artifact bytes, `absGradePct` is the first field to drop and compute on read.

#### `adjacency` — the big deliberate duplication

`adjacency` duplicates information already fully present in `edges`: every
`adjacency[n] = [e0, e1]` entry is recoverable by scanning `edges` for ones
whose `fromNode` or `toNode` is `n`. It's stored because the neighbor query is
the hottest path in the whole app (file 03). This is the textbook
denormalization: redundant by definition, justified by query frequency.

```
  adjacency — fully derivable, stored anyway

  edges (the source of truth for connectivity):
    e0{n0,n1}  e1{n1,n2}
         │
         └─ buildAdjacency() buckets by endpoint ──►
            adjacency: n0→[e0], n1→[e0,e1], n2→[e1]
                          │
            sync obligation: add/remove an edge → adjacency must
            be rebuilt. At build time that's automatic (one pass).
```

The boundary condition: `tiles.ts` proves the sync obligation is real.
`prefixGraph` and `stitchGraph` both have to update `adjacency` *and* `edges`
together whenever they touch the graph — miss one and the index lies about
connectivity. That's the cost of the denormalization, paid in those two
functions.

### Move 2.5 — current state vs the CRUD future

Right now the denormalization is free because there's no write path. If flattr
ever let users *edit* the graph (correct a missing sidewalk, flag a closed
path), the picture flips.

```
  Phase A (now): build-time-only artifact
    rebuild = the only sync. Denormalize freely. No desync risk.

  Phase B (hypothetical: editable graph)
    every edit to elevation/geometry must cascade:
      elevation change → riseM → gradePct → absGradePct → (heatmap)
      edge add/remove  → adjacency
    → you'd need recompute-on-write, or accept stale derived data
    → the denormalizations that are free now become a liability
```

The takeaway is the one that lands in interviews: *the safety of a
denormalization depends entirely on whether there's a write path*. flattr's is
safe because there isn't one.

### Move 3 — the principle

Normalization is the default; denormalization is an optimization you justify per
case against a *measured* read cost and a *named* sync obligation. The cleanest
denormalizations are the ones where the sync obligation is structurally
impossible to violate — and a build-time-only artifact gives you exactly that.
flattr's lesson: you can denormalize aggressively when your data is immutable at
runtime, because immutability eliminates the failure mode (stale copies) that
makes denormalization dangerous everywhere else.

---

## Primary diagram

Every duplicated fact, its source, and its sync obligation, in one frame.

```
  flattr's denormalization map

  SOURCE (single copy)        DERIVED + STORED          READER
  ──────────────────          ────────────────          ──────
  Node.elevationM ─┐
                   ├─► Edge.riseM      (stored) ──────► climb totals
  Edge.geometry ───┤
                   ├─► Edge.lengthM    (stored) ──────► cost.ts
                   └─► Edge.gradePct   (stored) ──────► cost.ts (signed)
                              │
                              └─► Edge.absGradePct (stored) ─► zones.ts heatmap
                                       (copy of a copy — weakest case)

  Edge.fromNode/toNode ─────► adjacency (stored) ──────► A* neighbor lookup
                                       (hottest query — strongest case)

  sync obligation for ALL of the above: a full rebuild (run-build.ts).
  there is NO runtime write path → no desync is possible.  ← why it's safe
```

---

## Implementation in codebase

### Use cases

- **Heatmap render** reaches for `absGradePct` so it never computes magnitude on
  the fly (`features/grade/zones.ts:39`).
- **A* expansion** reaches for `adjacency` so neighbor lookup is O(1)
  (`features/routing/astar.ts:64`).
- **The build** materializes all derived fields once (`pipeline/grade.ts`,
  `pipeline/build-graph.ts:29`).

### Code, line by line

The denormalization happens in one place — the grade pass writes all four
derived fields, including the redundant `absGradePct`.

```
  pipeline/grade.ts (lines 24–33)

  return edges.map((e) => {
    const lengthM = geometryLength(e.geometry);   ← derive from source geom
    const riseM = nodes[e.toNode].elevationM       ← derive from source elev
               - nodes[e.fromNode].elevationM;
    const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;
    const gradePct = Math.max(-MAX_GRADE_PCT,
                     Math.min(MAX_GRADE_PCT, raw));
    return { ...e, lengthM, riseM, gradePct,
             absGradePct: Math.abs(gradePct) };     ← the redundant copy:
  });                                                 |gradePct|, stored so
       │                                              the heatmap reads it raw
       └─ four derived columns written once; never recomputed at runtime
```

The two readers that justify the split — signed for routing, abs for heatmap.

```
  features/routing/cost.ts (line 32)     ← signed reader
  gradeCostDirected = (edge, fromNodeId, userMax) =>
    edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
                                          │
                                          └─ uses SIGNED grade (direction)

  features/grade/zones.ts (line 39)      ← magnitude reader
    arr.push(e.absGradePct);             ← uses the stored magnitude,
                                            no Math.abs at read time
```

The sync obligation made concrete: `stitchGraph` must touch `edges` AND
`adjacency` together, or the index lies.

```
  features/map/tiles.ts (lines 67–82)

  edges.push({ id, fromNode: a, toNode: b, ... });  ← add to edges
  (adjacency[a] ??= []).push(id);                    ← AND to adjacency
  (adjacency[b] ??= []).push(id);                    │
       │                                             └─ both endpoints
       └─ miss either line and the new connector edge exists in `edges`
          but A* never finds it (adjacency wouldn't list it) — the
          denormalization's sync cost, paid here
```

---

## Elaborate

The "single source of truth" rule comes straight from relational normalization
(Codd's normal forms): a fact stored twice can disagree with itself, and a
schema that *allows* disagreement will eventually contain it. Denormalization
deliberately accepts that risk to buy read performance — it's the same trade as
a materialized view or a cache. The discipline is: name the read you're
optimizing, measure it, and name the write that must keep the copy fresh.

This cross-links directly to information-hiding in software design (see
`.aipe/study-software-design/`): a normalized schema hides each fact behind one
owner the same way a deep module hides a decision behind one interface. The DB
version just has teeth — a foreign key and a unique constraint enforce the
hiding, where in code it's convention.

flattr's specific lesson is about *immutability as a denormalization enabler*.
Event-sourced and append-only systems lean on the same insight: if you never
mutate in place, derived/cached data can't drift, so you're free to precompute
aggressively. flattr's build-time artifact is the simplest version of that idea.

Read next: file 03 (the `adjacency` denormalization is *for* a query — here's
the query and the index that has no equivalent).

---

## Interview defense

**Q: You store `gradePct`, `absGradePct`, `lengthM`, `riseM` — all derivable.
Isn't that denormalized? Defend it.**

Yes, it's denormalized, and it's safe because the artifact is read-only at
runtime. The derived fields are precomputed once at build and frozen; there's no
UPDATE path, so the classic denormalization failure — a source edit that leaves
the copy stale — can't happen. The sync obligation is a full rebuild, paid once.

```
  why this denormalization is safe

  normal DB:   UPDATE source ──► copy goes stale ──► must cascade  ← risk
  flattr:      no UPDATE, only rebuild ──► copy can't go stale      ← no risk
```

**Anchor:** "Denormalization is dangerous because of the write path; a build-
time-only artifact has none — so it's free."

**Q: Which of these stored fields is the weakest justification?**

`absGradePct`. It's `Math.abs(gradePct)` — a copy of a copy, saving one trivial
`abs` per read. It earns its place semantically (it names the heatmap's reading
distinctly from routing's signed reading), not on performance. If I were
trimming artifact bytes for download size, it's the first field I'd drop and
compute on read.

**Anchor:** "`absGradePct` is denormalized for *clarity*, not speed — the one
field I'd cut under byte pressure."

---

## Validate

1. **Reconstruct.** List flattr's two deliberate denormalizations and, for each,
   name the source fact and the reader it optimizes. Check against
   `pipeline/grade.ts:31` (`absGradePct`) and
   `features/routing/graph.ts:22–29` (`adjacency`).
2. **Explain.** Why is storing derived data dangerous in a normal database but
   safe here? Trace it to the absence of a runtime write path
   (`mobile/src/loadGraph.ts` only reads).
3. **Apply.** You add user-submitted "this block is closed" flags that the app
   writes at runtime. Which denormalizations now need a sync strategy, and what
   would it be? (`adjacency` if edges can be removed; recompute the affected
   buckets, or rebuild.)
4. **Defend.** A reviewer says "drop `absGradePct`, just call `Math.abs` in the
   heatmap." Agree or push back, with the byte/clarity trade named. (Defensible
   either way; the honest call is it's a clarity field, droppable under size
   pressure — `features/grade/zones.ts:39`.)

---

## See also

- `01-the-data-model-and-its-shape.md` — the source/derived seam this builds on.
- `03-indexing-vs-query-patterns.md` — the query `adjacency` denormalizes for.
- `05-migrations-and-evolution.md` — what "full rebuild = the only sync" implies.
- `.aipe/study-software-design/` — information-hiding, the code analog.
