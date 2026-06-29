# Directed traversal over undirected storage

> **Derive-don't-materialize / single source of truth / computed property**
> — Language-agnostic. The "store once, compute the variant" move.

## Zoom out, then zoom in

A street has a grade. Walk it east-to-west and you're going uphill (+6%);
walk it west-to-east and you're going downhill (−6%). You could store *both*
directed edges in the graph. flattr stores *one* undirected edge with a
signed grade and derives the direction at query time. One function,
`directedGrade`, three lines, turns "the grade of this street" into "the
grade *I* experience walking it this way."

```
  Zoom out — where the direction is derived

  ┌─ build pipeline ──────────────────────────────────┐
  │  computeGrades → Edge { gradePct: +6 (from→to) }   │  store ONE sign
  └──────────────────────┬─────────────────────────────┘
                         │ Edge (one per street, undirected adjacency)
  ┌─ graph.ts ───────────▼─────────────────────────────┐
  │  ★ directedGrade(edge, fromNode) ★                  │ ← we are here
  │     fromNode === edge.fromNode ?  +gradePct         │
  │                                : −gradePct          │
  └──────────────────────┬─────────────────────────────┘
                         │ signed grade in travel direction
  ┌─ cost.ts ────────────▼─────────────────────────────┐
  │  gradeCostDirected → penalty(directedGrade(...))    │
  └────────────────────────────────────────────────────┘
```

Zoom in: the graph is stored *undirected* (one edge, in both nodes'
adjacency lists — `graph.ts:22-29`) but traversed *directed* (the sign flips
with travel direction). The single edge is the source of truth; the directed
view is computed, never stored. That's the "derive, don't materialize" move,
and it's why there's exactly one place to fix if the sign convention is ever
wrong.

## Structure pass

**Layers.** Storage vs query, split by `directedGrade`:
- *Storage*: `Edge.gradePct` — one signed number, from→to (`types.ts:17`).
- *The seam*: `directedGrade(edge, fromNode)` (`graph.ts:17`).
- *Query*: `cost.ts` and `summary.ts` ask "grade in MY direction."

**Axis — "what's the direction of travel?"**

```
  axis = "does direction matter, and who resolves it?"

  ┌─ Edge (storage) ──────────┐  direction-AGNOSTIC: one signed number
  │  gradePct = +6 (from→to)  │  the street doesn't know which way you walk
  └──────────┬─────────────────┘
             │ seam: directedGrade(edge, fromNode)
  ┌─ traversal (query) ───────┐  direction-AWARE: +6 forward, −6 reverse
  │  the search arrives FROM   │  the answer depends on WHERE you came from
  │  a specific node           │
  └────────────────────────────┘

  "which way?" is unanswerable in storage, answered at the seam
```

**Seam.** `directedGrade(edge, fromNodeId)` is the boundary. Below it, the
edge has no notion of "your" direction. Above it, every consumer that cares
about uphill-vs-downhill asks this one function. The axis flips here:
storage is symmetric, traversal is signed.

## How it works

### Move 1 — the mental model

You know computed properties — a Vue `computed` or a React `useMemo` that
derives `fullName` from `firstName` + `lastName` instead of storing a third
field that can drift out of sync. `directedGrade` is a computed property over
an edge: the directed grade is *derived* from the stored grade plus which
endpoint you're standing on, never stored as its own field.

```
  the pattern — one stored fact, two derived views

                    Edge.gradePct = +6   (from→to, the source of truth)
                         │
            ┌────────────┴────────────┐
   from === edge.fromNode      from === edge.toNode
            │                          │
            ▼                          ▼
        +6 (uphill)               −6 (downhill)
        forward traversal         reverse traversal
```

In one sentence: **store the fact once with a sign convention; compute the
direction-specific value at the point of use.**

### Move 2 — the step-by-step walkthrough

#### The whole derivation is one ternary

```ts
// graph.ts:16-19 — directedGrade, annotated
/** Signed grade in the direction of travel: +gradePct forward, -gradePct reverse. */
export function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
  //     └─ which endpoint am I leaving? ─┘   forward    reverse (flip sign)
}
```

That's it. The edge stores `gradePct` as signed from→to (`types.ts:17`). If
you're leaving the `fromNode`, you experience it as stored. If you're leaving
the `toNode`, you're going the other way, so flip the sign. **What breaks if
you don't derive — if you materialize two directed edges instead?** You
double the edge count, double the storage in `graph.json`, and create the
classic redundancy bug: nothing structurally stops the forward edge's grade
and the reverse edge's grade from disagreeing after an edit. Deriving makes
the disagreement *impossible* — there's only one number.

#### The undirected storage is in the adjacency, not a second edge

```ts
// graph.ts:22-29 — buildAdjacency, annotated
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);   // edge listed under BOTH endpoints
    (adj[e.toNode]   ??= []).push(e.id);   // → traversable in either direction
  }
  return adj;
}
```

This is the other half. One `Edge` appears in *both* endpoints' adjacency
lists, so the search can leave it from either side. Combined with `otherEnd`
(`graph.ts:10-14`), which returns the opposite endpoint regardless of which
side you came from, the single edge behaves as bidirectional. **What breaks
if the edge only appeared under `fromNode`?** The graph becomes directed by
accident — you could never route "downhill" along that street.

```
  layers-and-hops — how one edge serves both directions

  ┌─ adjacency (graph.ts) ──────────────────────────────┐
  │  adj["A"] = [e1]      adj["B"] = [e1]   ← same edge  │
  └─────────┬──────────────────────┬─────────────────────┘
     leave A│                leave B│
            ▼                       ▼
  ┌─ otherEnd(e1, "A")=B ┐  ┌─ otherEnd(e1, "B")=A ┐
  │ directedGrade=+6     │  │ directedGrade=−6     │
  └──────────────────────┘  └──────────────────────┘
        uphill cost              downhill = free
```

#### Two consumers, both ask the same function

```ts
// cost.ts:32-33 — routing asks for directed grade
gradeCostDirected = (edge, from, max) =>
  edge.lengthM * (1 + penalty(directedGrade(edge, from), max));

// summary.ts:15-17 — the summary independently derives directed rise
const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
```

Here's an honest wrinkle. `cost.ts` calls `directedGrade`. But `summary.ts`
re-derives the *same flip* for `riseM` inline (`summary.ts:16`) rather than
calling a shared `directedRise(edge, from)` helper. The grade is centralized;
the rise direction is not. It's a *minor* echo of the same logic — the kind
of thing the audit flags under information leakage (the sign-flip convention
known in two spots). The fix is small: a `directedRise` sibling next to
`directedGrade` in `graph.ts`. **What breaks today?** Nothing — but if the
sign convention ever changed, `graph.ts` and `summary.ts` would both need the
edit, and one could be missed.

### Move 3 — the principle

When a value has variants that are pure functions of a stored value plus
context, store the value and compute the variants. Materializing the variants
buys a lookup and pays with redundancy that can desync. The general lesson:
**a single source of truth isn't a database concept — it's a per-edge one.**
One signed grade, derived two ways, can never contradict itself.

## Primary diagram

The full move: pipeline stores one sign, adjacency makes it bidirectional,
`directedGrade` derives the travel-direction value, consumers ask.

```
  directed traversal over undirected storage — complete

  ┌─ build pipeline ───────────────────────────────────────┐
  │  computeGrades → Edge{ gradePct:+6, riseM:+3 } (from→to)│ STORE once
  │  buildAdjacency → e1 under adj[A] AND adj[B]            │ undirected
  └───────────────────────────┬─────────────────────────────┘
                              │ Graph (one edge per street)
  ┌─ graph.ts ────────────────▼─────────────────────────────┐
  │  otherEnd(e, here) → the far endpoint                   │
  │  directedGrade(e, here) → +6 if here==fromNode else −6  │ ← DERIVE
  └───────────────────────────┬─────────────────────────────┘
              ┌───────────────┴────────────────┐
   ┌─ cost.ts ▼──────────┐         ┌─ summary.ts ▼──────────┐
   │ penalty(directed)   │         │ directedRise (inline ⚠)│
   └─────────────────────┘         └────────────────────────┘
```

## Elaborate

This is "single source of truth" and the computed-property idea you use daily
in reactive frontends, applied to a graph edge. It's also why the spec lists
"grade is signed by travel direction" as a data-model invariant — the
storage commits to one convention (signed from→to) and everything downstream
derives from it.

It's the same hiding discipline as pattern `02`, one layer down: `02` keeps
*grade-as-cost* knowledge in one file; `03` keeps *direction-of-travel*
knowledge in one function. The minor `summary.ts` echo is the one spot where
the discipline isn't fully held — see `audit.md` Lens 3. For the heatmap, note
the *opposite* choice: the overview uses `absGradePct` (direction-agnostic
steepness, `types.ts:18`) because a heatmap has no travel direction. Same data,
two derived views, picked by what the consumer needs.

## Interview defense

**Q: "Why not just store two directed edges? Lookups would be O(1) with no
ternary, and directed graphs are the normal representation for pathfinding."**

The ternary is free and storing two edges doubles the artifact and invites a
desync bug. `graph.json` ships to the device; doubling the edge count doubles
what we bundle and parse. More importantly, two directed edges means the
uphill grade and the downhill grade are *separate stored numbers* — nothing
enforces that they're negatives of each other. One bad pipeline edit and a
street is +6% uphill but only −4% downhill, which is physically nonsense and
silent. Deriving from one signed value makes that contradiction
unrepresentable. The cost is one comparison per edge expansion, which is
noise next to the heap operations.

```
  two directed edges          vs     one + directedGrade
  ┌──────────────┐                   ┌──────────────┐
  │ e_AB: +6     │ can drift          │ e: +6        │ one truth
  │ e_BA: −4 ⚠   │ apart              └──────┬───────┘
  └──────────────┘                    ±flip at query → ±6 always consistent
```

*Anchor: derive the directed view from one stored sign so the two directions
can never contradict each other.*

**Q: "Where would this design bite you?"**

The sign convention is implicit knowledge — "gradePct is from→to" lives in a
comment (`types.ts:17`) and is assumed by `directedGrade`, `cost.ts`, and the
inline rise flip in `summary.ts`. That last one is the bite: the rise flip is
re-derived in `summary.ts` instead of calling a shared helper, so the
convention is known in two places. If it changed, both must change. I'd
extract a `directedRise` next to `directedGrade` to close that gap.

*Anchor: the one place the single-source-of-truth leaks is the inline rise
flip in `summary.ts:16` — it should call a shared helper like
`directedGrade` does.*

## See also

- `02-penalty-as-the-domain-seam.md` — the same hiding move, one layer up.
- `01-parametric-search-over-cost-fns.md` — `directedGrade` feeds the cost fn.
- `audit.md` Lens 3 (the `summary.ts` rise-flip echo).
- `study-data-modeling/` — single source of truth at the schema level.
