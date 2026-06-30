# Vector databases — N/A: flattr's store is a static graph.json

**Industry name(s):** vector database / approximate nearest-neighbor index.
**Type:** Industry standard.

## Zoom out — flattr's "database" is a read-only JSON graph, queried geographically

A vector database stores embeddings and answers "find me the k most
*semantically* similar vectors." flattr's store is `graph.json` — a
static, read-only file of nodes (`lat`, `lng`) and edges — and its one
"nearest-neighbor" query is `nearestNode`, which finds the closest point
*geographically*. No embeddings, no ANN index, no server. It's a graph
loaded into memory, not a vector DB.

```
  Zoom out — flattr's store is a static graph file

  ┌─ build (pipeline/) ─────────────────────────────────────┐
  │  run-build.ts → writes data/graph.json  (read-only)      │ run-build.ts:48
  └────────────────────────────┬─────────────────────────────┘
  ┌─ app (mobile/) ────────────▼─────────────────────────────┐
  │  loads graph.json → nearestNode(point) [nearest.ts:5]    │
  │  ★ this is the "query" — geographic k-NN, no ANN index   │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** build writes `graph.json` → app loads it → routing reads it.
- **Axis — what does the store index, and how is it queried?** A vector
  DB: indexes embeddings, queried by cosine similarity (often
  approximate). flattr: stores a graph, queried by exact `haversine`
  scan over nodes and adjacency lookups. The axis (index type + query
  metric) is the whole contrast.
- **Seam:** the `graph.json` load boundary. Above it, a build pipeline
  produces a static artifact; below it, the app reads it. Nothing on
  either side is a vector index.

## How it works

### Move 1 — the mental model

A vector DB is a specialized index for one question — "nearest vectors by
meaning" — usually approximate, so it stays fast at millions of rows.
flattr answers a *different* nearest question — "nearest node by physical
distance" — and answers it *exactly* with a linear scan, because the
graph is small enough that exactness is cheap. Same "find nearest"
verb, but no embeddings and no approximation.

```
  Pattern — vector DB vs flattr's static graph store

  vector DB:     embeddings ─► ANN index (HNSW/IVF) ─► cosine top-k
                 (approximate, scales to millions)

  flattr:        graph.json ─► in-memory nodes ─► haversine exact min
                 (exact linear scan, small graph)  nearest.ts:5
```

### Move 2 — the walkthrough

**flattr's store and its query.** The store is written once at build
(`run-build.ts:48`) and read-only thereafter:

```ts
function writeGraph(graph: Graph, path: string): void {
  writeFileSync(path, JSON.stringify(graph));   // static artifact, no DB
}
```

The "query" against it is an exact scan, `nearest.ts:5`:

```ts
for (const id of Object.keys(graph.nodes)) {
  const d = haversine(point, { lat: n.lat, lng: n.lng });  // exact, not ANN
  if (d < bestDist) { bestDist = d; bestId = id; }
}
```

No HNSW, no IVF, no cosine — just a loop and a distance metric over a
fixed set of nodes. The adjacency in `graph.ts` answers "neighbors of
node X" by lookup, the way an adjacency list does, not by similarity
search.

```
  Layers-and-hops — query path against the static graph

  ┌─ app ─────┐ hop1: tap (lat,lng)  ┌─ nearest.ts ──────────┐
  │MapScreen  │ ────────────────────►│ exact haversine scan  │ nearest.ts:5
  └───────────┘                      └──────────┬─────────────┘
                  hop2: node id ◄────────────────┘
  ┌─ engine ──┐
  │graph.ts   │  adjacency lookup → A* over graph.json
  └───────────┘
```

**The boundary condition.** A vector DB earns its place at scale and
under semantic queries — neither of which flattr has. The graph is small
and the query is exact-geographic, so an ANN index would add latency and
a dependency for no recall benefit. If flattr's node count ever exploded,
the geographic answer is a *spatial* index (a k-d tree / R-tree), not a
*vector* DB — because the query is still geometric, not semantic.

### Move 3 — the principle

A vector database is the right store only when the query is "nearest by
learned similarity" and the scale defeats an exact scan. flattr's query
is "nearest by physical distance" at a scale where exact wins, so the
right store is a static graph, not a vector DB. The principle: match the
store to the *query's distance metric and scale*, not to whatever's
fashionable — and a geographic nearest-neighbor wants a spatial index,
never a vector one.

## Primary diagram

```
  flattr stores a graph, not vectors

  ┌─ build (pipeline/) ──────────────────────────────────────┐
  │ run-build.ts → graph.json (read-only) [run-build.ts:48]   │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ app (mobile/) ────────────▼─────────────────────────────┐
  │ load graph.json → nearestNode (exact haversine) [nearest] │
  │ adjacency lookup → A*   ·  NO embeddings, NO ANN index    │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Vector DBs (pgvector, Pinecone, sqlite-vec, Qdrant) exist to make
semantic k-NN fast at scale. You've run one for real in **AdvntrCue**
(pgvector unifying relational + vector queries). flattr is the
counter-example: its store is a static graph queried geographically, so a
vector DB would be pure overhead. The transferable point is store
selection by query shape — semantic-at-scale wants a vector DB,
geographic wants a spatial index, small-and-exact wants a plain scan, and
flattr is firmly in the last two.

## Interview defense

**Q: What vector database does flattr use?** Answer: none. Its store is a
read-only `graph.json` written once at build (`run-build.ts:48`), and its
nearest-neighbor query is an exact `haversine` scan in `nearestNode`
(`nearest.ts:5`) — geographic, not semantic, no ANN index. A vector DB
answers semantic k-NN at scale; flattr answers geographic nearest at
small scale, so even if it grew, the right tool is a spatial index (k-d
tree), not a vector DB.

```
  graph.json + exact haversine scan ≠ embeddings + ANN cosine index
```

Anchor: *"flattr's store is a static graph queried by physical distance —
a vector DB would index the wrong thing with the wrong metric."*

## See also

- [01-embeddings.md](01-embeddings.md) — flattr's vectors are geographic.
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — flattr's "retrieval" is spatial.
- [10-incremental-indexing.md](10-incremental-indexing.md) — how graph.json is rebuilt.
