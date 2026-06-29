# Adjacency as a denormalized index

**Industry name:** adjacency list / precomputed access index; the `absGradePct`
case is a *materialized derived column* (denormalization for read speed).
**Type label:** Industry standard (adjacency list), Language-agnostic
(denormalization tradeoff).

---

## Zoom out, then zoom in

Normalization says: store every fact once, in one place, so it can't disagree with
itself. flattr deliberately breaks that rule twice — and both breaks are the right
call. Here's where the denormalization lives:

```
  Zoom out — the model's two derived copies

  ┌─ Graph ────────────────────────────────────────────────────┐
  │                                                            │
  │  PRIMARY FACTS                  DERIVED COPIES (this file)  │
  │  ┌──────────────┐               ┌────────────────────────┐ │
  │  │ edges[]      │ ──duplicated──►│ adjacency: id → id[]    │ │ ← we are here
  │  │  .fromNode   │   endpoints    │  (edge endpoints again) │ │
  │  │  .toNode     │               └────────────────────────┘ │
  │  │  .gradePct   │ ──Math.abs───► ┌────────────────────────┐ │ ← and here
  │  └──────────────┘               │ edge.absGradePct        │ │
  │                                 │  (|gradePct| per edge)  │ │
  │                                 └────────────────────────┘ │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: a database would give you a B-tree index and a generated column for free,
and enforce that they stay in sync. flattr has neither engine, so it materializes
both by hand — `buildAdjacency` builds the access index, `computeGrades` writes the
derived column. The question: **when is copying a fact the right move, and what does
it cost you?**

## Structure pass

**Layers — the spectrum from "stored once" to "stored everywhere":**

```
  Normalization spectrum, three points on it

  ┌─ fully normalized ─────────┐   each fact once, joins to read
  │  (a relational edges table)│   integrity free, reads slow
  └────────────────────────────┘
  ┌─ flattr: primary + index ──┐   facts once in edges[], copied
  │  (adjacency, absGradePct)  │   into derived structures for reads
  └────────────────────────────┘
  ┌─ fully denormalized ───────┐   every read self-contained,
  │  (one giant per-query blob) │   updates touch many places
  └────────────────────────────┘
```

**Axis traced — "if I change the primary fact, what else must change?"** Hold it
across the two seams:

- Change an edge's `fromNode`: `adjacency` must be rebuilt (the endpoint copy is now
  wrong). The codebase guarantees this by *never* hand-editing adjacency —
  `buildAdjacency` rebuilds it whole from edges (`graph.ts:22-29`).
- Change an edge's `gradePct`: `absGradePct` must be recomputed. The codebase
  guarantees this by computing both in the *same* expression (`grade.ts:31`).

**Seam:** the boundary is "who writes the derived copy." In both cases the answer is
"only the build pipeline, in one place, atomically with the primary fact." That's
what makes the denormalization safe — the update path is funneled through a single
function. Strip that discipline and the copies drift. That's the whole lesson.

## How it works

### Move 1 — the mental model

You've made this exact tradeoff in frontend without naming it: you keep a `Map` from
id → item next to your array of items, so a click handler can look up the clicked
item in O(1) instead of `.find()`-ing the array every time. The array is the source
of truth; the map is a derived index you rebuild when the array changes. `adjacency`
is that map. `absGradePct` is the same move at the field level — caching
`Math.abs(x)` next to `x` so the render path doesn't recompute it.

```
  Denormalization = trade write-discipline for read-speed

   primary fact            derived copy            read path
   ┌──────────┐  build/    ┌──────────┐  O(1) or   ┌──────────┐
   │ edges[]  │ ─compute─► │ index /  │ ─O(deg)──► │ A* /     │
   │ gradePct │  (1 place) │ abs col  │            │ heatmap  │
   └──────────┘            └──────────┘            └──────────┘
        ▲                       │
        └── must rebuild if ────┘   ← the cost: an update obligation
            primary changes
```

The strategy: **copy the fact into the shape the hot read wants, and pay for it by
funneling all writes through one rebuild.**

### Move 2 — the walkthrough

#### Seam 1 — `adjacency` duplicates edge endpoints

A\* expansion asks, thousands of times per search: "given I'm at node `current`,
which edges touch it?" Answer that from `edges[]` directly and it's an O(E) scan per
expansion — at 1879 edges, ruinous. So the model stores the answer:

```ts
// features/routing/graph.ts:22-29
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);  // edge appended to its FROM endpoint
    (adj[e.toNode] ??= []).push(e.id);    // AND its TO endpoint — duplicated
  }
  return adj;
}
```

Every edge's `(fromNode, toNode)` relationship is now stored *twice*: once as the
edge's own fields, once inside two adjacency lists. That's the duplication. The
payoff, in A\*:

```ts
// features/routing/astar.ts:64
for (const edgeId of graph.adjacency[current] ?? []) {  // O(degree), not O(E)
  const edge = byId.get(edgeId)!;
  const next = otherEnd(edge, current);
  ...
}
```

`graph.adjacency[current]` is O(1), and it yields only the handful of edges touching
`current` (degree ~2-4 in a street grid). Without the index, that single line would
be a full edge scan inside the hottest loop in the program.

```
  what adjacency buys, per A* expansion

  WITHOUT index:  for each of ~1879 edges, is current an endpoint?   O(E)
  WITH index:     graph.adjacency[current] → [e0, e1]                O(1) + O(deg)

  multiplied by ~hundreds of expansions per route = the difference
  between "instant" and "noticeable"
```

**The update obligation:** because adjacency copies the endpoints, it's only correct
if rebuilt whenever edges change. The codebase honors this — adjacency is built once
in `buildGraph` (`build-graph.ts:29`) and rebuilt, never patched, when tiles merge
(`tiles.ts` rebuilds via `prefixGraph`/`stitchGraph`). It is *never* hand-edited.
That single discipline is what keeps the denormalization safe.

#### Seam 2 — `absGradePct` is a materialized `Math.abs(gradePct)`

`gradePct` is signed (uphill +, downhill −) because the *router* needs direction.
But the *heatmap* asks "how steep is this, regardless of direction" — it wants
`|gradePct|`. Rather than call `Math.abs` per edge per render, the build materializes
it:

```ts
// pipeline/grade.ts:30-31
const gradePct = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, raw)); // PRIMARY
return { ...e, lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) }; // DERIVED
```

The two are written in the *same return statement* — there is no code path that
produces an edge with one but not the other. That's what makes this safe: the
derived column can't drift because it's never written separately. Contrast the
hazard a database's generated column protects against and this convention only
*conventionally* protects against — if someone later wrote `edge.gradePct = x` at
runtime without touching `absGradePct`, the two would silently disagree. Nothing
writes edges at runtime, so the hazard is latent, not live.

Who reads which:

```
  the two grade fields serve two different reads

  edge.gradePct  ──► directedGrade() ──► cost.ts (router) ──► signed penalty
   (signed)            (graph.ts:17)        free downhill, charged uphill

  edge.absGradePct ──► zones.ts (heatmap) ──► classify.ts ──► color band
   (derived |x|)        p85 per grid cell       (direction-agnostic steepness)
```

#### The cosmetic third copy — `node.id`

Worth naming because it's the *un*justified version of the same move. In
`graph.json`, a node is stored as `{"n0": {"id": "n0", ...}}` — the map key `n0`
*and* the `id` field both hold `"n0"`. The id is stored twice. Unlike the other two,
this copy buys nothing (the key already is the id) and could drift (key `n0` holding
`{id: "n5"}`). It's a few KB of redundancy and a latent inconsistency with no read
that needs it. If you were trimming the artifact, this is the copy to drop — keep the
map key, drop the inner `id`, or vice versa.

### Move 2 variant — the load-bearing skeleton

The kernel of "safe denormalization" has exactly three parts. Drop any one and the
copies drift:

1. **A single primary source.** `edges[]` and `gradePct` are the one place the fact
   lives. Drop this (let two structures both claim to be authoritative) and there's
   no truth to rebuild from.
2. **A pure rebuild function from primary → derived.** `buildAdjacency(edges)` and
   the `Math.abs` in `computeGrades`. Drop this (patch the derived copy by hand) and
   it diverges the moment a primary fact changes.
3. **A funnel that forces every write through the rebuild.** Here it's a convention,
   not an engine: adjacency is only ever assigned from `buildAdjacency`; `absGradePct`
   is only ever written next to `gradePct`. Drop the funnel and parts 1–2 don't save
   you — someone writes the copy directly and it rots.

Optional hardening (not present, would be the upgrade): a validator that *checks*
the derived data matches its source on load — `assert absGradePct === |gradePct|`
for every edge, `assert adjacency consistent with edges`. That's the database's
"the engine enforces it" replaced by a load-time check. flattr has neither.

### Move 3 — the principle

Denormalization is information leakage's deliberate twin: you copy a fact on purpose,
accepting an update obligation in exchange for read speed. It's only safe when the
update path is funneled — one source, one rebuild, every write through it. flattr's
adjacency and `absGradePct` are textbook-correct because the funnel holds (build-time
only, single expression). The `node.id` double-store is the cautionary version: a
copy with no read that needs it and no funnel guaranteeing it. The principle that
transfers: **never copy a fact unless a hot read demands it, and when you do, make
exactly one function responsible for keeping the copy true.**

## Primary diagram

The two justified denormalizations and the one cosmetic one, with their funnels.

```
  Denormalization in flattr's model — sources, copies, funnels

  PRIMARY (source of truth)        FUNNEL (the one writer)      DERIVED (read-fast copy)

  ┌─ edges[] ──────────┐                                    ┌─ adjacency ──────────┐
  │  .fromNode .toNode │── buildAdjacency(edges) ──────────►│ id → [edgeId,...]     │
  └────────────────────┘   graph.ts:22, build-graph.ts:29   │ used by A* astar.ts:64│
       JUSTIFIED                (rebuilds whole, never patch)└──────────────────────┘
       O(1) expansion

  ┌─ edge.gradePct ────┐                                    ┌─ edge.absGradePct ───┐
  │  signed, clamped    │── computeGrades (same return) ───►│ |gradePct|            │
  └────────────────────┘   grade.ts:31                      │ used by heatmap       │
       JUSTIFIED                (written in one expression)  │ zones.ts:38           │
       no per-render abs                                     └──────────────────────┘

  ┌─ map key "n0" ─────┐                                    ┌─ node.id "n0" ───────┐
  │  the real PK        │── (no funnel — just both stored) ─│ redundant copy        │
  └────────────────────┘   COSMETIC: no read needs it,      │ could drift, buys     │
                           could drift                       │ nothing               │
                                                            └──────────────────────┘
```

## Elaborate

This is the data analog of information hiding from `study-software-design`:
normalization is "store each fact once so it can't disagree with itself," exactly as
a deep module hides each decision in one place. Denormalization is the deliberate
violation — and like every deliberate violation, it's only defensible when you can
name what you bought (here: O(1) expansion, no per-render abs) and you've contained
the cost (a single rebuild funnel). The adjacency list specifically is the canonical
graph-storage tradeoff you already met in `Graph.ts` / `Graph2.ts`: adjacency list
(fast neighbor iteration, the choice here) vs adjacency matrix (fast edge-existence
check, O(V²) space — wrong for a sparse street grid).

Read next: `03` for the *missing* index — the `edges` array has no id index, the one
denormalization the model *should* have made and didn't.

## Interview defense

**Q: `adjacency` stores every edge's endpoints a second time. Isn't that a
normalization violation?**

Yes, deliberately. It's a precomputed access index — the same move as keeping a
`Map<id, item>` beside an array so lookups are O(1). A\* expansion asks "which edges
touch this node" hundreds of times per route; answering from `edges[]` is an O(E)
scan each time, answering from `adjacency` is O(1) + O(degree). The violation is
safe because adjacency is *derived* — built by `buildAdjacency` from edges, rebuilt
whole on every change, never hand-edited. One source, one rebuild function.

```
  the safety condition for any denormalization

  source of truth ──one rebuild fn──► derived copy
       edges[]      buildAdjacency      adjacency
                    (never patched)
  break the arrow (patch the copy) → drift
```

Anchor: *"Adjacency is a derived index, not a second source — rebuilt whole from
edges, never patched, so it can't drift."*

**Q: `absGradePct` is just `Math.abs(gradePct)`. Why store it?**

Read-path optimization for the heatmap, which wants direction-agnostic steepness and
renders it per edge per frame. Materializing `|gradePct|` at build time keeps the
abs out of the hot render loop. It's safe because both fields are written in the same
expression in `computeGrades` — there's no path that produces one without the other.
A database would express this as a generated column; with no engine, the convention
*is* the constraint. The latent risk: a future runtime write to `gradePct` that
forgets `absGradePct` would silently desync them. Nothing writes at runtime, so it's
latent — but it's the exact failure mode of every hand-maintained derived column.

Anchor: *"Materialized derived column for the heatmap hot path — safe only because
one expression writes both; that's the convention standing in for a generated
column."*

## See also

- `01-graph-as-the-schema.md` — the primary-vs-derived seams set up here.
- `03-missing-indexes-and-scans.md` — the index the model *didn't* materialize.
- `04-integrity-without-a-database.md` — no validator checks the copies match.
- `study-software-design` — information hiding, the CODE analog of normalization.
