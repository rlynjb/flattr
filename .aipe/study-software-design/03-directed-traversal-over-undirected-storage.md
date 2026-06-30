# 03 — Directed traversal over undirected storage

**Industry names:** derived value / single source of truth / don't-materialize.
**Type label:** Language-agnostic.

The graph stores each edge *once*, undirected, with a signed grade. The
direction of travel is **derived** at traversal time by one function —
never stored as two opposing edges.

---

## Zoom out, then zoom in

This is the storage-shape decision underneath the routing core. It's why
`graph.json` is half the size it could be and why the sign of every grade
is correct everywhere.

```
  Zoom out — where the derivation lives

  ┌─ STORAGE (graph.json, static) ───────────────────────────────┐
  │  Edge { fromNode, toNode, gradePct (signed from→to),          │
  │         absGradePct }   — stored ONCE, undirected             │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ at traversal time
  ┌─ ROUTING CORE ───────────────▼──────────────────────────────┐
  │  ★ directedGrade(edge, fromNode)  graph.ts:17 ★ ← we are here │
  │     │ used by                                                 │
  │     ├─ cost.ts:32 gradeCostDirected (signed cost)            │
  │     ├─ astar.ts:126 summarizePath (steep flag)              │
  │     ├─ summary.ts:16 routeSummary (climb)                   │
  │     └─ geojson.ts:55 routeToGeoJSON (color)                 │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **derive, don't materialize.** You've made this
call every time you chose to compute `fullName` from `first + last`
rather than store a third column that can drift out of sync. Here the
"derived value" is the signed grade *in your direction of travel*, and
the function that derives it is the single source of truth for the sign.

---

## Structure pass

**Layers.** Undirected storage (one `Edge`, one signed `gradePct`) →
directed view (computed per traversal). The adjacency list
(`buildAdjacency`, `graph.ts:22`) lists each edge under *both* endpoints,
so the same stored edge is reachable walking either way.

**Axis held constant — "is grade a stored field or a computed value?"**

```
  "directed grade: stored or derived?" — trace across the seam

  ┌─ storage ─────────────┐   seam    ┌─ traversal ──────────────┐
  │ gradePct: +6 (from→to)│ ════╪════► │ directedGrade(e, A) = +6 │
  │ stored ONCE           │ (it flips)│ directedGrade(e, B) = −6 │
  └───────────────────────┘           └──────────────────────────┘
         one number                      two views, neither stored
```

**Seam.** `Edge.gradePct │ directedGrade`. The axis flips from *stored*
to *derived* exactly at this function. Everything above the seam sees a
directed grade and never touches the raw sign; everything below stores a
single signed number. → the directed grade feeds the penalty seam (`02`).

---

## How it works

### Move 1 — the mental model

The shape: one undirected edge, two ways to walk it, and a sign flip that
distinguishes them — computed, not stored. If you've ever stored a single
`balance` and computed "is this a debit or credit *for this account*" at
read time rather than duplicating the transaction, same move.

```
  Pattern — one edge, derived direction

        gradePct = +6  (stored, means A→B rises 6%)
   A ●━━━━━━━━━━━━━━━━━━● B
        │                │
   walk A→B: directedGrade = +6  (uphill, penalized)
   walk B→A: directedGrade = −6  (downhill, free)
        the edge is stored once; the sign is a function of WHERE YOU START
```

### Move 2 — the walkthrough

**The derivation — three lines, the whole sign convention.**
`graph.ts:17-19`:

```ts
// features/routing/graph.ts:17-19
export function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
}
```

Bridge: it's a ternary. If you're starting at the edge's stored
`fromNode`, you're going "with" the stored direction → keep the sign. If
you're starting at the other end, you're going against it → negate.
**This is the only place in the entire codebase that knows the sign
rule.** That's the load-bearing property — audit lens 3 calls it out.

**Storage stays undirected — `buildAdjacency`.** `graph.ts:22-29` lists
each edge id under *both* its endpoints:

```ts
// features/routing/graph.ts:22-29
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);   // reachable walking from→to
    (adj[e.toNode]   ??= []).push(e.id);   // AND walking to→from
  }
  return adj;
}
```

So when `search` expands a node, it sees every incident edge regardless
of stored orientation, and `otherEnd` (`graph.ts:10`) picks the far
endpoint. One stored edge, both directions traversable. **The alternative
flattr rejected:** materialize two directed edges (A→B with +6, B→A with
−6). That doubles `graph.json`, doubles the adjacency, and creates a
*second* place the sign lives — so a sign bug could now exist in the data
rather than in one function. Deriving keeps the sign in code, where one
test covers it.

**Every consumer asks the same function.** The directed grade is needed
in four places, and all four call `directedGrade` rather than re-deriving
the sign:

```
  cost.ts:32      gradeCostDirected → penalty(directedGrade(edge, from), max)
  astar.ts:126    summarizePath    → directedGrade(edge, from) > userMax (flag)
  geojson.ts:55   routeToGeoJSON   → classifyDirected(directedGrade(...), max)
  summary.ts:16   routeSummary     → directedRise (the same sign rule, inlined ⚠)
```

**One honest wrinkle.** `summary.ts:16` computes the directed *rise*
(meters climbed) by re-deriving the sign inline rather than calling a
shared helper:

```ts
// features/routing/summary.ts:16
const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
```

That's the *same sign convention* as `directedGrade`, applied to `riseM`
instead of `gradePct`. It's a tiny, contained duplication — the rule
("from===fromNode keeps sign") now lives in two spots. Not a real leak
(it's three tokens, both in the same `features/routing` folder), but if
you wanted to be strict you'd add `directedRise(edge, fromNode)` next to
`directedGrade` and have summary call it. The reason it's fine today:
both are trivial and co-located. Worth noting so you don't think the
single-source-of-truth claim is absolute.

### Move 3 — the principle

When a value can be *computed* from what you already store, computing it
beats storing it — you erase an entire class of "the derived copy drifted
from the source" bug, and you shrink the artifact. The cost is a function
call at read time, which for a grade lookup is free. Materialize only
when the recomputation is expensive *and* the source rarely changes;
neither is true here.

---

## Primary diagram

```
  Directed traversal over undirected storage — full recap

  ┌─ STORAGE (graph.json) ─────────────────────────────────────┐
  │  Edge: fromNode=A, toNode=B, gradePct=+6, riseM=+3         │
  │  adjacency:  A → [edge]   B → [edge]   (both, graph.ts:22) │
  └───────────────────────────┬────────────────────────────────┘
                              │  directedGrade(edge, from)  graph.ts:17
                  ┌───────────┴───────────┐
            from=A │ +6 (uphill)     from=B │ −6 (downhill)
                  ▼                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │  cost.ts:32   astar.ts:126   geojson.ts:55   summary.ts:16│
   │  (penalty)    (steep flag)   (color)         (climb ⚠inline)│
   └─────────────────────────────────────────────────────────┘
            one stored sign → many directed views, derived
```

---

## Elaborate

This is the database-normalization instinct ("don't store what you can
derive") applied to a graph, and it's also a classic space/time tradeoff
landing on the right side for a mobile artifact: `graph.json` ships to the
phone, so halving the edge count matters. The undirected-storage-with-
derived-direction shape shows up anywhere edges are symmetric in topology
but asymmetric in cost — elevation routing, current-aware river routing,
one-way-street modeling. Read `02` for the penalty that consumes the
derived grade; read `study-data-modeling` for the normalization framing.

---

## Project exercises

### EX-03-A — Extract `directedRise` to kill the inline duplication

- **What to build:** a `directedRise(edge, fromNodeId)` in `graph.ts`
  next to `directedGrade`; rewire `summary.ts:16` to call it.
- **Why it earns its place:** makes the single-source-of-truth claim
  literally true — the sign rule then lives in exactly one folder, one
  pattern.
- **Files to touch:** `features/routing/graph.ts`, `summary.ts`, tests.
- **Done when:** `summary.ts` has no inline `? : -` sign flip and tests
  pass.
- **Estimated effort:** 20 min.

### EX-03-B — Prove derivation beats materialization

- **What to build:** a test asserting `directedGrade(e, e.fromNode) ===
  -directedGrade(e, e.toNode)` for every edge in a fixture — the
  antisymmetry the materialized version would have to maintain by hand.
- **Why it earns its place:** shows the invariant is free when derived
  and would be a data-integrity burden if stored.
- **Files to touch:** `features/routing/graph.test.ts`.
- **Done when:** the property holds across the fixture graph.
- **Estimated effort:** 25 min.

---

## Interview defense

**Q: Why store edges undirected and derive direction, instead of two
directed edges?**

Two reasons. Size: `graph.json` ships to a phone, and materializing both
directions doubles the edge count and the adjacency list. Correctness:
materializing puts the sign in the *data*, so a sign bug becomes a data
bug across thousands of edges. Deriving puts the sign in *one function*
(`directedGrade`, `graph.ts:17`), where one unit test covers every case.
The cost is a ternary at read time — free.

```
  materialize:  A→B(+6), B→A(−6)   2 edges, sign lives in DATA (×N)
  derive:       A—B(+6)            1 edge, sign lives in CODE  (×1 fn)
```

**Q: When would you materialize instead?** When the recomputation is
expensive and the source is near-static — e.g. if "directed grade"
required a heavy elevation re-sample per read. Here it's a sign flip, so
never.

**Anchor:** "The sign convention lives in one ternary — `directedGrade`
in `graph.ts:17`. The edge is stored once; the direction is a function of
where you start."

---

## See also

- `02-penalty-as-the-domain-seam.md` — consumes the derived grade.
- `01-parametric-search-over-cost-fns.md` — the search that traverses.
- `audit.md` lens 3 (sign convention hidden in one place), lens 7
  (sign-aware naming).
