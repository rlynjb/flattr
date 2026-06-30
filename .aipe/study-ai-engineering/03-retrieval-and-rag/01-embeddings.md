# Embeddings — and flattr's only vectors are 2D geo coordinates

**Industry name(s):** text embeddings / dense vector representations.
**Type:** Industry standard.

## Zoom out — flattr embeds nothing semantic; its vectors are lat/lng

flattr has vectors all over it — but they're *geographic*, not
*semantic*. Every node carries a `(lat, lng)` pair, and `nearestNode`
finds the closest one by physical distance. That's a 2D vector in
geographic space, where distance means *meters on the ground*. A text
embedding is a 1536-D vector in *semantic* space, where distance means
*similarity of meaning*. Same word "vector," opposite kind of space.

```
  Zoom out — flattr's vectors live in geographic space, not semantic

  ┌─ engine (features/routing/) ────────────────────────────┐
  │  graph.nodes[id] = { lat, lng }   ← a 2D GEO vector      │ nearest.ts
  │  nearestNode(point) → haversine distance → closest node  │
  │  ★ distance = METERS, not meaning                        │
  └──────────────────────────────────────────────────────────┘

  ┌─ (NOT BUILT) semantic embedding ────────────────────────┐
  │  "flat path" → [0.12, -0.84, ...] (1536-D)              │
  │  distance = MEANING — flattr has none of this            │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** node coordinates → nearest-node lookup → routing.
- **Axis — what does "distance between two vectors" mean?** In flattr:
  meters between two points on the earth (`haversine`). In a semantic
  embedding system: closeness of meaning between two texts (cosine). The
  axis (what distance measures) is the whole contrast.
- **Seam:** `nearest.ts:10`. flattr's "vector similarity" is the
  `haversine` call. There is no embedding model and no semantic seam.

## How it works

### Move 1 — the mental model

You already work with 2D vectors every time you snap a tap to the
nearest node — that's a point in `(lat, lng)` space and a distance
metric. A text embedding is the same idea lifted to ~1500 dimensions,
where the axes aren't latitude and longitude but learned features of
meaning, and "close" means "similar in meaning" instead of "near on the
map." flattr stops at the 2D geographic version.

```
  Pattern — two kinds of vector space

  GEOGRAPHIC (flattr):           SEMANTIC (an embedding model):
   axes = lat, lng                axes = ~1500 learned features
   distance = meters              distance = meaning similarity
   "buy milk" — no meaning        "buy milk" ≈ "purchase dairy"
   nearestNode() via haversine    cosine search via embeddings
```

### Move 2 — the walkthrough

**flattr's actual vector operation.** `nearest.ts:5`:

```ts
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });   // GEO distance
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
}
```

This is a nearest-neighbor search — structurally the same shape as a
vector DB's k-NN — but the vectors are 2D `(lat, lng)` and the metric is
`haversine` (great-circle meters). Swap `haversine` for cosine and 2D for
1536-D and you'd have semantic retrieval. flattr never does, because it
has no text to embed: the user types an address, and that goes to
`geocode`, not to an embedding model.

```
  Layers-and-hops — flattr's geographic nearest-neighbor (the only "vector search")

  ┌─ UI ──────┐ hop1: tap (lat,lng)   ┌─ nearest.ts ──────────┐
  │MapScreen  │ ─────────────────────►│ haversine over nodes  │ nearest.ts:5
  └───────────┘                       │ → closest node id      │
                  hop2: node id ◄──────┴────────────────────────┘
  ┌─ engine ──┐
  │astar.ts   │  routes from that node
  └───────────┘
```

**The boundary condition.** The temptation is to call this "an
embedding." It isn't. An embedding is *learned* — a model maps text to a
position so that meaning-similar texts cluster. flattr's coordinates are
*measured* — they're literal positions on the earth from OSM. No model,
no learning, no semantics. Calling geographic coordinates "embeddings"
would be the conceptual error to avoid in an interview.

### Move 3 — the principle

An embedding is a learned map from objects to a space where geometric
distance approximates a *semantic* relationship you care about. flattr's
coordinates are a measured map to a space where distance is *physical*.
The principle to carry: "vector" describes the data structure, not the
meaning — always ask what the axes are and what distance buys you before
calling something an embedding.

## Primary diagram

```
  flattr's vectors are geographic; embeddings are semantic

  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ node (lat,lng) → nearestNode via haversine [nearest.ts:5] │
  │ distance = meters · measured · no model                   │
  └──────────────────────────────────────────────────────────┘
  ┌─ embeddings (NOT BUILT) ─────────────────────────────────┐
  │ text → embedding model → 1536-D vector → cosine search    │
  │ distance = meaning · learned · needs a corpus to be useful│
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Embeddings are the foundation of every RAG and semantic-search system —
they turn "find similar meaning" into "find nearby vector." You've shipped
real ones in **AdvntrCue** (pgvector + GPT-4, semantic retrieval over a
corpus). flattr is the clean contrast: it has the *nearest-neighbor
machinery* (`nearestNode`) but over geographic vectors, so there's
nothing semantic to embed. Knowing that a k-NN over coordinates is *not*
an embedding system — same algorithm, different space — is the
distinction that separates someone who's used embeddings from someone
who's only heard the word.

## Interview defense

**Q: Does flattr use embeddings?** Answer: no. flattr's only vectors are
2D `(lat, lng)` coordinates, and `nearestNode` (`nearest.ts:5`) does a
nearest-neighbor search over them with `haversine` — geographic distance,
not semantic. An embedding is a *learned* map to a meaning-space;
flattr's coordinates are *measured* positions on the earth. Same k-NN
shape, completely different space. Load-bearing distinction: "vector"
names the structure, not the semantics.

```
  (lat,lng) + haversine = geographic k-NN ≠ embedding + cosine = semantic
```

Anchor: *"flattr does nearest-neighbor over geographic vectors — that's
geometry, not embeddings; there's no text and no learned space."*

## See also

- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — flattr's "retrieval" is spatial, not semantic.
- [02-embedding-model-choice.md](02-embedding-model-choice.md) — N/A: flattr embeds nothing.
- [11-rag.md](11-rag.md) — why flattr's context is structured, not retrieved.
