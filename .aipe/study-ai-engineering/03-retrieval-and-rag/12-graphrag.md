# GraphRAG — flattr's graph is geographic, not a knowledge graph

**Industry name(s):** GraphRAG / graph-augmented retrieval.
**Type:** Industry standard.

## Zoom out — flattr traverses a graph, but it carries coordinates, not entities

GraphRAG extracts entities and relationships into a *knowledge graph*,
then traverses those relationships to retrieve text the query wouldn't
match by vocabulary alone. flattr has a graph and traverses it constantly
(A*, BFS) — but its graph is *geographic*: nodes are `(lat, lng)` points,
edges are street segments with grade. The traversal machinery is
structurally familiar to GraphRAG's, but the graph carries coordinates,
not concepts. That contrast is the whole lesson here.

```
  Zoom out — same traversal shape, different payload

  ┌─ knowledge graph (GraphRAG, NOT flattr) ────────────────┐
  │  [auth] ──relates_to──► [session] ──discussed_in──► [doc]│
  │  nodes = ENTITIES · edges = SEMANTIC relations           │
  └──────────────────────────────────────────────────────────┘

  ┌─ flattr's geographic graph (BUILT) ─────────────────────┐
  │  (node:lat,lng) ──edge: street, gradePct──► (node:lat,lng)│ graph.ts
  │  nodes = PLACES · edges = ROADS with grade               │
  │  ★ traversed by A* — same algorithm family, no entities  │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** graph data (`graph.json`) → adjacency (`graph.ts`) → A*
  traversal (`astar.ts`).
- **Axis — what do the nodes and edges *mean*?** GraphRAG: nodes are
  entities, edges are semantic relations, traversal retrieves related
  text. flattr: nodes are coordinates, edges are roads with grade,
  traversal finds a low-grade *path*. The axis (what the graph encodes)
  flips entirely; the traversal algorithm stays familiar.
- **Seam:** `graph.ts` adjacency. Both GraphRAG and flattr "walk
  neighbors" here — but flattr walks to minimize a *cost* (distance +
  grade penalty), not to gather semantically related chunks.

## How it works

### Move 1 — the mental model

You've built graph search — BFS, A*, Dijkstra over an adjacency list.
GraphRAG is graph search where the nodes are *ideas* and walking an edge
means "this concept relates to that one, follow it to find relevant
docs." flattr is graph search where the nodes are *places* and walking an
edge means "this street connects here, follow it if it's flat enough."
Identical traversal skeleton; the nodes mean completely different things.

```
  Pattern — graph traversal, two payloads

  GraphRAG:  start entity ─► walk relations ─► reach docs ─► retrieve
             goal: gather semantically related text
  flattr:    start node   ─► walk roads     ─► reach goal ─► return path
             goal: minimize distance + grade penalty   astar.ts
             ▲ same "expand neighbors" loop; nodes carry lat/lng, not meaning
```

### Move 2 — the walkthrough

**flattr's nodes and edges carry geometry, not entities.**
`features/routing/types.ts`:

```ts
export type Node = { /* id, lat, lng, ... */ };          // a PLACE
export type Edge = { /* fromNode, toNode, lengthM, ... gradePct, riseM */ };  // a ROAD
```

A GraphRAG node would be `{ entity: "auth", type: "concept" }` and an edge
`{ relation: "discussed_in" }`. flattr's are coordinates and street
segments with physical attributes (length, rise, grade). The graph
encodes *where things are*, not *how ideas relate*. So traversing it
answers "what's a flat route from A to B," never "what docs relate to
this query."

**The traversal is A*, not retrieval.** The cost function is geometric,
`cost.ts:32`:

```ts
export const gradeCostDirected: CostFn = (edge, fromNodeId, userMax) =>
  edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
```

This is the structural twin of a GraphRAG traversal step — "expand
neighbors, score them, follow the best" — but the score is *distance ×
grade penalty*, not semantic relevance. Same loop, geometric objective.

```
  Layers-and-hops — flattr's geographic traversal (GraphRAG's twin)

  ┌─ data ────┐ hop1: adjacency   ┌─ astar.ts ────────────┐
  │graph.json │ ──────────────────►│ expand neighbors      │
  │graph.ts   │                    │ score by grade cost    │ cost.ts:32
  └───────────┘                    └──────────┬─────────────┘
                  hop2: low-grade path ◄────────┘
                  (GraphRAG would emit related CHUNKS here instead)
```

**The boundary condition — where the analogy stops.** It's tempting to
call A* "GraphRAG over a map." Don't. GraphRAG's value is retrieving text
that *doesn't share vocabulary* with the query but *is structurally
related* — that requires nodes to be entities and edges to be semantic
relations. flattr's edges are physical roads; following one tells you
nothing about meaning, only about geography. The traversal *mechanism* is
shared; the *retrieval* purpose is absent because there's nothing textual
to retrieve.

### Move 3 — the principle

GraphRAG and flattr's router are the same algorithm family — graph
traversal with a scoring rule — pointed at different graphs. GraphRAG's
graph encodes *meaning* (entities, relations) so traversal gathers related
text; flattr's encodes *space* (coordinates, roads) so traversal finds a
low-grade path. The principle: a graph traversal is only "RAG" if the
graph carries semantics. The same A* skeleton over a geographic graph is
routing, not retrieval — and conflating the two hides what each graph
actually encodes.

## Primary diagram

```
  GraphRAG vs flattr — same traversal, opposite graph

  ┌─ GraphRAG (NOT BUILT) ───────────────────────────────────┐
  │ entities + semantic relations → traverse → retrieve docs  │
  │ "find related text that shares no vocabulary with query"  │
  └──────────────────────────────────────────────────────────┘
  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ (lat,lng) nodes + road edges → A* traverse → low-grade path│
  │ scored by distance × grade penalty [cost.ts:32]           │
  │ geographic graph · no entities · routing, not retrieval   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

GraphRAG arrived to fix plain RAG's blind spot: docs that are relevant but
don't share words with the query, reachable only through explicit
relations. You'd reach for it in **AdvntrCue** when vector similarity
misses structurally-related content. flattr is the sharp contrast — it has
the *graph-traversal muscle* (A* over an adjacency list, your DSA
wheelhouse) but the graph is geographic, so traversal is routing, not
retrieval. The transferable insight: graph algorithms transfer across
domains, but "GraphRAG" specifically requires the graph to encode
*semantics* — geography doesn't qualify.

## Project exercises

### B-GRAG.1 — name the geographic-vs-knowledge-graph boundary in code

- **Exercise ID:** B-GRAG.1
- **What to build:** a short doc comment / ADR at the graph types that
  states explicitly: this is a geographic graph (coordinates + roads), not
  a knowledge graph — A* here is routing, not GraphRAG retrieval.
- **Why it earns its place:** it prevents the most likely conceptual drift
  (calling the router "GraphRAG") and sharpens the interview answer.
- **Files to touch:** `features/routing/types.ts` (document `Node`/`Edge`
  semantics); `features/routing/astar.ts` (note: traversal goal is path
  cost, not retrieval).
- **Done when:** the types carry an explicit "geographic, not knowledge
  graph" note.
- **Estimated effort:** half an hour.

## Interview defense

**Q: Is flattr's router a form of GraphRAG?** Answer: no — same algorithm
family, wrong graph. flattr's nodes are `(lat, lng)` and edges are roads
with grade (`types.ts`), so A* (`astar.ts`) traverses a *geographic*
graph to find a low-grade path, scored by `gradeCostDirected`
(`cost.ts:32`). GraphRAG traverses a *knowledge* graph — entities and
semantic relations — to retrieve related text. The traversal skeleton is
shared; the graph's payload (coordinates vs concepts) is the whole
difference. Load-bearing point: a traversal is only GraphRAG if the graph
encodes meaning.

```
  A* over (lat,lng) graph = routing ≠ traverse entity graph = GraphRAG
```

Anchor: *"flattr's graph carries coordinates, not entities — so A* over it
is routing, not GraphRAG retrieval, even though the traversal looks the
same."*

## See also

- [11-rag.md](11-rag.md) — why flattr's context is structured, not retrieved.
- [01-embeddings.md](01-embeddings.md) — flattr's vectors are geographic.
- [../04-agents-and-tool-use/01-agents-vs-chains.md](../04-agents-and-tool-use/01-agents-vs-chains.md) — the route pipeline is a fixed chain.
