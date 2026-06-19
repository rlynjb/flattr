# Directed traversal over undirected storage
### Information hiding / representation independence — Project-specific design move

## Zoom out, then zoom in

Edges are stored *once*, but you can walk them *both ways* — and the difference
matters because a hill is uphill one way and downhill the other. Here's where
the hiding happens.

```
  Zoom out — where directed traversal lives

  ┌─ Engine layer (features/routing) ─────────────────────────────┐
  │  search() / bidirectional()  ── walk edges in both directions │
  │             │ but never touch edge.fromNode/toNode directly   │
  │             ▼                                                  │
  │  ★ graph.ts: otherEnd() · directedGrade() ★                   │ ← we are here
  │             │ the only place that knows the storage is        │
  │             ▼ undirected (each edge stored once)               │
  │  Edge { fromNode, toNode, gradePct (signed from→to) }          │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** You know how a doubly-linked list node has one `next` and one
`prev`, but you traverse it forward or backward with the same node object?
Same here: each `Edge` is stored once with a `fromNode`, a `toNode`, and a grade
signed in the from→to direction. But the router walks edges starting from
*either* end. Two tiny functions hide that asymmetry: `otherEnd(edge, here)`
gives you the node across the edge, and `directedGrade(edge, here)` gives you
the grade *in your direction of travel* — positive uphill, negative down. The
pattern is **information hiding**: one storage decision (undirected, signed
one way) sealed behind helpers so no consumer hard-codes the sign flip.

## Structure pass

**Layers.** The **storage layer** is the `Edge` record (`types.ts:10–20`): one
edge, two endpoints, a signed grade. The **traversal layer** is `otherEnd` /
`directedGrade` (`graph.ts:10–19`). The **consumer layer** is everyone else —
`search`, `bidirectional`, `cost`, `summary`, `geojson`.

**Axis — "who knows the grade is signed from→to?"**

```
  One question down the layers: "who knows about the sign convention?"

  ┌──────────────────────────────────────┐
  │ consumers (cost, astar, geojson…)    │  → DON'T. they call directedGrade.
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ graph.ts: directedGrade()        │  → THE ONE place that flips sign
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ Edge.gradePct (signed from→to)│  → the raw stored convention
          └──────────────────────────────┘

  the sign convention is known at exactly one altitude. that's the hiding.
```

**Seam.** `otherEnd` and `directedGrade` are the seam between "how edges are
stored" and "how edges are traversed." The knowledge axis flips here:
everything above is direction-agnostic; everything below commits to from→to.
That's a load-bearing boundary — change the storage to store both directions
explicitly, and only these two functions change.

## How it works

### Move 1 — the mental model

The shape is one stored edge with a sign that depends on which end you start
from.

```
  Pattern — one edge, two directions, one stored sign

         gradePct = +6 (stored from→to)
     A ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━● B
       │  start at A: directedGrade = +6  (uphill)
       │  start at B: directedGrade = -6  (downhill)
       │
       └─ otherEnd(edge, A) = B ;  otherEnd(edge, B) = A
          one record, the helper picks the right view
```

You never ask "is my from the edge's from?" in consumer code. You ask the
helper, and it answers in *your* frame of reference.

### Move 2 — the walkthrough

**`otherEnd` — neighbor lookup.** Bridge from adjacency-list BFS: you have a
node and an incident edge, you want the node on the far side. In an *undirected*
adjacency where each edge is listed under both endpoints, you can't assume the
neighbor is `edge.toNode` — it depends which end you're standing on.

```
  otherEnd(edge, nodeId):
      if nodeId == edge.fromNode: return edge.toNode
      if nodeId == edge.toNode:   return edge.fromNode
      else: throw   // nodeId isn't on this edge → programmer error, fail loud
```

The boundary condition that bites: the `throw`. If a caller passes a node that
isn't an endpoint (a bug in adjacency construction), `otherEnd` fails *loudly at
the lowest layer* instead of silently returning the wrong neighbor and producing
a subtly broken route. That's error-detection placed where the invariant lives.

**`directedGrade` — the sign flip, contained.** This is the function the whole
audit's "information leakage" finding orbits.

```
  directedGrade(edge, fromNodeId):
      if fromNodeId == edge.fromNode: return  edge.gradePct   // forward = stored sign
      else:                            return -edge.gradePct   // reverse = flip it
```

Two lines. Every consumer that needs "is this uphill *for me*" calls this. The
cost function (`cost.ts:32`), the steep-edge flag (`astar.ts:126`), the route
color (`geojson.ts:55`) — none of them write the ternary. They'd all have to
change together if the convention changed; instead, only `directedGrade` does.

**Where the hiding LEAKS (the honest part).** `routeSummary`
(`summary.ts:16`) needs directed *rise* (meters climbed in the travel
direction), and there's no `directedRise` helper — so it writes the sign flip
inline: `fromNode === edge.fromNode ? edge.riseM : -edge.riseM`. Now the
convention lives in two functions. It's a small leak, but it's the exact shape
APOSD warns about: the same knowledge edited in two places. The fix is one
function (`directedRise`) next to `directedGrade`.

```
  Layers-and-hops — the leak

  ┌─ graph.ts ──────────┐         ┌─ summary.ts ────────────────────┐
  │ directedGrade()     │  hop:   │ inline: from==fromNode           │
  │ knows sign convention│ SHOULD │   ? edge.riseM : -edge.riseM     │
  │                     │ call →  │ ← re-derives the SAME convention │
  └─────────────────────┘  but    └──────────────────────────────────┘
                           doesn't.  two places now know the sign flip.
```

### Move 3 — the principle

When a representation has an asymmetry the rest of the system shouldn't care
about — stored one way, used both ways — seal the asymmetry behind a helper
that speaks the *caller's* frame. The test of success: grep for the raw field
access (`edge.fromNode ===`) and you should find it in *one* file. flattr is one
inline copy away from passing that test cleanly.

## Primary diagram

The full hiding: one storage shape, two helpers, many consumers, one leak to
close.

```
  Directed traversal over undirected storage — full picture

  ┌─ consumers (frame-agnostic) ──────────────────────────────────┐
  │ search relax   bidirectional   cost.ts   geojson route color   │
  │      │              │            │            │                │
  │      └─── all call ─┴────────────┴────────────┘                │
  │                     │ otherEnd / directedGrade                 │
  │  summary.ts ········┘ ← LEAK: inline sign flip (should call)   │
  └─────────────────────┬──────────────────────────────────────────┘
                        ▼ the seam (graph.ts:10–19)
  ┌─ traversal helpers ───────────────────────────────────────────┐
  │ otherEnd(edge, here)      → node across the edge (or throw)    │
  │ directedGrade(edge, here) → +stored if forward, −stored if rev │
  └─────────────────────┬──────────────────────────────────────────┘
                        ▼ storage (types.ts:10–20)
  ┌─ Edge: fromNode, toNode, gradePct (signed from→to), riseM ────┐
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every edge relax in `search` and `bidirectional` calls
`otherEnd` to find the neighbor (`astar.ts:65`, `bidirectional.ts:68,98`).
Every grade-aware cost, color, and steep-flag calls `directedGrade`. The
adjacency itself is built undirected — each edge pushed under *both* endpoints
(`buildAdjacency`, `graph.ts:22–29`) — which is exactly why traversal needs the
direction-resolving helpers.

**The two helpers — `features/routing/graph.ts:10–19`.**

```
  graph.ts  (lines 10–19)

  export function otherEnd(edge, nodeId): string {
    if (nodeId === edge.fromNode) return edge.toNode;
    if (nodeId === edge.toNode)   return edge.fromNode;
    throw new Error(`otherEnd: "${nodeId}" is not an endpoint…`);  ← fail loud
  }

  export function directedGrade(edge, fromNodeId): number {
    return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
  }                                       └─ THE sign flip, in exactly one place
```

**Adjacency stored undirected — `features/routing/graph.ts:22–29`.**

```
  graph.ts  (lines 22–29)

  export function buildAdjacency(edges): Record<string, string[]> {
    const adj = {};
    for (const e of edges) {
      (adj[e.fromNode] ??= []).push(e.id);   ← edge listed under its FROM node
      (adj[e.toNode]   ??= []).push(e.id);   ← AND under its TO node (undirected)
    }
    return adj;
  }
       │
       └─ each edge appears in two adjacency lists. that's why a neighbor
          lookup can't assume edge.toNode — hence otherEnd.
```

**The leak — `features/routing/summary.ts:16`.**

```
  summary.ts  (line 16, inside routeSummary)

  const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
       │
       └─ this is directedGrade's sign-flip logic, copied for riseM.
          FIX: add directedRise(edge, fromNode) to graph.ts and call it.
          One move closes the leak (audit Lens 3, Leak #2).
```

## Elaborate

This is **information hiding** and, underneath it, **representation
independence**: consumers depend on the *meaning* ("grade in my direction"), not
the *storage* ("signed from→to, listed under both endpoints"). It's why flattr
can store each edge once (half the memory, no "is the reverse edge consistent?"
class of bug) and still route both ways correctly. The `must-not-change`
constraint "grade is signed by travel direction" in the project context is
*implemented* by `directedGrade` — that one function is the contract.

Read next: `02-penalty-as-the-domain-seam.md` (the biggest consumer of
`directedGrade`), `01-parametric-search-over-cost-fns.md` (`otherEnd` in the
relax loop). For the graph as a data structure, see
`.aipe/study-data-modeling/` and `.aipe/study-dsa-foundations/`.

## Interview defense

**Q: Why store edges undirected and flip the sign, instead of storing both
directed edges?** Half the storage and no consistency invariant to maintain
between an edge and its reverse (if they were separate records, a build bug
could make A→B and B→A disagree on length). The cost is two helper functions.
Cheap trade, and the helpers are 4 lines total.

```
  store both directed              vs   store once + flip
  ┌──────────┐ ┌──────────┐             ┌──────────┐
  │ A→B +6   │ │ B→A −6   │  ← must      │ A—B +6   │ ← directedGrade
  │          │ │          │    stay in   │          │   computes −6 on demand
  └──────────┘ └──────────┘    sync      └──────────┘
```

**Q: What's the load-bearing part people forget?** The `throw` in `otherEnd`
(`graph.ts:13`). It turns "caller passed a non-endpoint node" — a silent
wrong-neighbor bug — into a loud failure at the layer that owns the invariant.
And the honest follow-up: name the *leak* in `summary.ts:16`. Knowing where your
own hiding is incomplete is a stronger signal than claiming it's perfect.

**Anchor:** "One edge, stored once, signed from→to. `directedGrade(edge, here)`
is the single place the sign flips — except `summary.ts` copied it, and that's
the leak to close."

## Validate

1. **Reconstruct:** write `otherEnd` and `directedGrade` from memory
   (`graph.ts:10–19`).
2. **Explain:** why does `buildAdjacency` push each edge under *both* endpoints
   (`graph.ts:26–27`), and how does that force `otherEnd` to exist?
3. **Apply:** add `directedRise(edge, fromNode)` and refactor `summary.ts:16` to
   use it. What other module could now use it? (`geojson` if it ever colors by
   climb.)
4. **Defend:** a teammate says "just access `edge.gradePct` directly in
   `cost.ts`, it's faster." Walk them through the route-coloring bug that
   appears the first time someone routes B→A.

## See also

- `02-penalty-as-the-domain-seam.md` — `directedGrade`'s biggest consumer.
- `01-parametric-search-over-cost-fns.md` — `otherEnd` in the relax loop.
- `audit.md` Lens 3 (information hiding — the `summary.ts` leak), Lens 6.
- `.aipe/study-data-modeling/` — the `Edge`/`Graph` schema.
