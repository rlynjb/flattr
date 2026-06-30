# Derived and Denormalized Fields

**Industry name(s):** denormalization / materialized derived columns / computed
field caching. **Type:** Industry standard (data modeling tradeoff).

---

## Zoom out, then zoom in

You've made this call in a database before: a value you *could* compute on every
read, but you store it anyway so the read is cheap — a `comment_count` column
instead of `COUNT(*)` each time. The cost is that it's now a second copy of a
fact, and a copy can drift. flattr makes that exact call twice. Here's where
those two stored-derivations sit.

```
  Zoom out — derived fields live at the build/read boundary

  ┌─ Build layer (pipeline/grade.ts) ──────────────────────────────┐
  │  gradePct = clamp(riseM / lengthM · 100)                       │
  │  ★ absGradePct = |gradePct|  ── derived, written to disk ★     │ ← we are here
  └──────────────────────────────────┬─────────────────────────────┘
  ┌─ Build layer (pipeline/build-graph.ts) ─────────────────────────┐
  │  ★ adjacency = buildAdjacency(edges) ── inverse of FK relation ★│
  └──────────────────────────────────┬─────────────────────────────┘
                                      │ serialized into graph.json
  ┌─ Read layer (mobile/) ─────────────▼────────────────────────────┐
  │  heatmap reads absGradePct · A* reads adjacency (no recompute)  │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: two fields in the schema aren't primitive — they're functions of other
fields, computed at build time and stored. `absGradePct = |gradePct|`, and
`adjacency` = the inverse of `fromNode`/`toNode`. The question: *which
denormalizations earn their keep, and which is just a convenience copy?*

---

## The structure pass

**Layers.** The fact exists at two altitudes: the *source* field it's derived
from, and the *stored* derivation. For grade: `gradePct` (source) → `absGradePct`
(stored). For topology: `fromNode`/`toNode` (source) → `adjacency` (stored).

**Axis — "if the source changes, does the derivation update?"** This is the
drift question — the whole risk of denormalization.

```
  One question across both denormalizations: does the copy track the source?

  ┌─ absGradePct ──────────────────┐  re-derived ONLY at build (grade.ts:31)
  │   source: gradePct             │  no runtime write path → can't drift TODAY
  └────────────────┬───────────────┘
  ┌─ adjacency ────────────────────┐  re-derived ONLY at build (build-graph.ts:29)
  │   source: fromNode/toNode      │  prefixGraph re-keys BOTH together (tiles.ts)
  └────────────────────────────────┘

  both are build-time-only derivations — the seam is "is there a write path?"
```

**Seam.** The load-bearing boundary is **whether a runtime mutation exists**.
Today none does (the model is read-only), so neither copy can drift — the risk
is latent, gated behind a write path that doesn't exist. The one place ids
*are* mutated at runtime — `prefixGraph` (`tiles.ts:21-38`) — correctly updates
`adjacency` and the FKs together, so even that mutation keeps them in sync.
That's file `05`.

---

## How it works

### Move 1 — the mental model

A denormalized field is a cache with the invalidation problem moved into your
schema. You know `useMemo(() => Math.abs(g), [g])` — recompute only when the
input changes. `absGradePct` is that, except the "recompute" happens once at
build time and the result is frozen into the artifact. Cheap reads forever; the
catch is there's no `[g]` dependency tracking — if `gradePct` ever changes
without re-running the derivation, the cache is stale and nothing notices.

```
  Two kinds of stored fact

  PRIMITIVE (a real input):     riseM, lengthM, gradePct, lat, lng
        │ no source — measured / sampled
        ▼
  DERIVED (a function of inputs, stored anyway):
        absGradePct = |gradePct|              (grade.ts:31)
        adjacency   = invert(fromNode,toNode) (graph.ts:22-29)
  derived fields are the drift risk — primitives can't drift
```

### Move 2 — the walkthrough

**`absGradePct` — the derived column.** Watch the exact line where the copy is
made:

```ts
// pipeline/grade.ts:24-33
export function computeGrades(nodes, edges) {
  return edges.map((e) => {
    const lengthM = geometryLength(e.geometry);
    const riseM = nodes[e.toNode].elevationM - nodes[e.fromNode].elevationM; // primitive
    const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;
    const gradePct = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, raw));   // primitive-ish (clamped)
    return { ...e, lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) }; // ← DERIVED, stored
  });
}
```

Line 31 is the denormalization. `absGradePct` is *exactly* `|gradePct|` — no
information that isn't already in `gradePct`. Why store it? Because the heatmap
read path wants steepness-only and reads it directly:

```ts
// features/map/geojson.ts:30 — heatmap coloring
color: bandColor(classifyAbs(e.absGradePct, bands)),
// features/grade/zones.ts:41 — zone rollup
arr.push(e.absGradePct);
```

The route path, by contrast, wants *directed* grade and recomputes the sign on
the fly with `directedGrade` (`geojson.ts:55`). So the split is deliberate:
the symmetric read (heatmap: "how steep, ignoring direction") gets a stored
field; the directional read (route: "uphill or downhill *this way*") computes
per query. That's a clean read-pattern-driven denormalization.

```
  Why absGradePct is stored: two read shapes, two needs

  heatmap  (symmetric, "how steep")  ──► reads absGradePct directly   (stored)
  route    (directional, "up THIS way") ──► directedGrade(edge,from)  (computed)
                                             then |·| via classify
  the symmetric reader is hot and frequent → cache the symmetric value
```

The cost, stated plainly: `gradePct` and `absGradePct` are one fact in two
fields. If a future feature edits `gradePct` in memory without re-deriving
`absGradePct`, the heatmap and the router disagree about the same edge. There's
no write path today (`04`), so this is latent — but it's the textbook
denormalization hazard, and worth a comment or a derive-on-read helper if a
mutation path ever lands.

**`adjacency` — the materialized inverse index.** Same category, different
verdict. It restates `fromNode`/`toNode` as a node→edges map:

```ts
// features/routing/graph.ts:22-29
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);  // edge belongs to its "from" node
    (adj[e.toNode]   ??= []).push(e.id);  // and its "to" node
  }
  return adj;
}
```

Everything in `adjacency` is re-derivable from `edges` by this one pass. So why
persist it into `graph.json` instead of rebuilding it on load? Because it's the
index the hot query needs (`03`), and rebuilding it is O(E) work you'd repeat
every cold start. Storing it trades 1879 edge-ids of disk for O(1) neighbor
expansion. Unlike `absGradePct`, this one is unambiguously worth it — A* is
*unusable* without an O(1) neighbor lookup.

```
  adjacency: stored inverse, paid for in disk, redeemed in A*

  on disk:   adjacency: { "n0":["e0","e3"], "n1":["e0","e1"], ... }
                              │ load (no recompute)
                              ▼
  A* inner loop:  for (edgeId of graph.adjacency[current])   ← O(1)
                  (astar.ts:64)   vs.   edges.filter(touches current)  ← O(E)
```

### Move 2.5 — current state vs future state

Right now both denormalizations are safe because the model is **read-only** —
no code mutates a loaded `Graph`'s `gradePct` or endpoints (except `prefixGraph`,
which updates the FK and `adjacency` together). The drift risk is entirely
gated behind a write path.

```
  Phase A (now)                     Phase B (if runtime edits land)
  ─────────────                     ──────────────────────────────
  read-only Graph                   some feature mutates an edge
  absGradePct can't drift           must re-derive absGradePct on write
  adjacency can't drift             must update adjacency on add/remove edge
  → no guard needed                 → derive-on-read OR a setter that re-derives
```
The takeaway for Phase B: *don't add a setter that writes `gradePct` raw.* Route
edits through a function that re-derives `absGradePct` (and `adjacency` on
add/remove), the same way `prefixGraph` already keeps ids in sync.

### Move 3 — the principle

Denormalize for a read pattern, never for convenience. `adjacency` passes the
test — name the capability lost without it (O(1) A* expansion) and it's
concrete. `absGradePct` passes a weaker version — it serves the symmetric
heatmap reader, but it's one `Math.abs` away from free, so its keep-or-drop
depends entirely on whether the read is hot enough to matter. The discipline:
every stored derivation should answer "which read does this make cheap, and is
that read hot?"

---

## Primary diagram

Both denormalizations, their sources, their readers, and the drift gate.

```
  Derived fields — source → stored copy → reader, gated by "no write path"

  PRIMITIVES (build inputs)            DERIVED (stored)         READERS
  ┌────────────────────┐               ┌──────────────┐
  │ riseM, lengthM     │── compute ──► │ gradePct     │
  └────────────────────┘   grade.ts:30 └──────┬───────┘
                                              │ |·|  grade.ts:31
                                              ▼
                                       ┌──────────────┐  heatmap: classifyAbs
                                       │ absGradePct  │──► geojson.ts:30
                                       └──────────────┘    zones.ts:41
  ┌────────────────────┐  invert       ┌──────────────┐  A* expansion
  │ fromNode, toNode   │── graph.ts ──►│ adjacency    │──► astar.ts:64  (O(1))
  └────────────────────┘   :22-29      └──────────────┘
        ▲                                      ▲
        └──── drift impossible while ──────────┘
              the Graph is read-only (Phase A)
```

---

## Elaborate

This is the same tradeoff as a materialized view or a denormalized counter
column in Postgres — store the answer, pay on write (here: on build) instead of
on read. The reason it's low-risk in flattr and high-risk in a typical CRUD app
is the write frequency: a CRUD app writes constantly, so a denormalized column
needs triggers or app discipline to stay correct; flattr writes once, at build,
so the derivation runs exactly when the source does. The lesson generalizes:
**denormalization risk scales with write frequency, not with the derivation's
complexity.**

Cross-link: this is the data-modeling face of software-design's single-source-
of-truth — `study-software-design` argues the principle in code; here it's the
schema. Read `03` next for why `adjacency` is specifically the *right* index.

---

## Interview defense

**Q: `absGradePct` is just `|gradePct|`. Why is it in the schema at all?**
It's a denormalized column serving the heatmap read path, which wants
steepness-only and is the frequent symmetric reader (`geojson.ts:30`,
`zones.ts:41`). The route path needs *directed* grade and computes it per query
instead (`directedGrade`). So the symmetric reader gets a cached value, the
directional one computes. I'd flag that it's a second copy of one fact — safe
only because there's no runtime write path; if one lands, route edits through a
re-deriving setter.

```
  symmetric read (hot) → cache absGradePct
  directional read     → compute directedGrade per query
  drift-safe ONLY because writes happen once, at build
```
Anchor: "stored derivation is a cache; it's safe here because the write happens
once at build, so it can't go stale."

**Q: Why ship `adjacency` in the file instead of rebuilding it on load?**
Because it's the index A* depends on — O(1) neighbor expansion (`astar.ts:64`)
— and rebuilding it is O(E) work repeated every cold start. Storing 1879
edge-ids buys load-once instead of recompute-each-launch. Unlike `absGradePct`,
this one's load-bearing: A* with an O(E) neighbor scan is a different
complexity class.
Anchor: "adjacency is a materialized index — the one denormalization where I can
name the exact capability lost without it."

---

## See also

- `01-graph-as-entity-model.md` — where these fields sit in the full schema
- `03-indexes-vs-query-patterns.md` — `adjacency` as the index that serves A*
- `05-tile-prefixing-and-id-namespacing.md` — the one runtime mutation that keeps FK + adjacency in sync
- `study-software-design` — single source of truth, the principle behind the verdict
