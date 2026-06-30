# Dense vs sparse retrieval — flattr's retrieval is spatial, a third kind

**Industry name(s):** dense (embedding) vs sparse (BM25) retrieval.
**Type:** Industry standard.

## Zoom out — flattr does neither: its "retrieval" is geographic nearest-node

Dense and sparse are two ways to retrieve *text*: dense by embedding
similarity, sparse by keyword overlap. flattr retrieves neither way. Its
one retrieval-shaped operation is `nearestNode` — find the closest graph
node to a tapped point — and "closest" means *physical distance on the
earth*. That's a third category entirely: spatial retrieval. No
embeddings (dense), no keywords (sparse), just `haversine`.

```
  Zoom out — flattr's retrieval is spatial, not dense or sparse

  ┌─ app (mobile/) ─────────────────────────────────────────┐
  │  tap (lat,lng) ──► nearestNode ──► closest node id       │ nearest.ts:5
  │  ★ "relevance" = METERS, not meaning and not keywords    │
  └──────────────────────────────────────────────────────────┘

   dense:  query → embed → cosine top-k   (meaning)   ← NOT flattr
   sparse: query → terms → BM25 top-k     (keywords)  ← NOT flattr
   spatial: point → haversine min         (geometry)  ← flattr
```

## Structure pass

- **Layers:** tapped point → nearest-node scan → routing.
- **Axis — what makes a result "relevant"?** Dense: semantic closeness.
  Sparse: term overlap. flattr (spatial): physical proximity. Trace that
  one axis and the three are clearly distinct retrieval families.
- **Seam:** `nearest.ts:10` — the `haversine` comparison. That's flattr's
  entire "relevance function," and it's geometric.

## How it works

### Move 1 — the mental model

You know the three ways to find a record: by fuzzy meaning (dense), by
matching words (sparse), or by *coordinates* (spatial — what a map app
does when you tap "near me"). Dense and sparse both operate on text and
fight over recall vs precision on language. flattr only ever does the
third: it takes a coordinate and returns the nearest node by
great-circle distance. There's no text in the loop at all.

```
  Pattern — three retrieval families, one axis (what is "relevant?")

  dense:   "auth bug"  ──► [vector] ──cosine──► "login broken"  (meaning)
  sparse:  "auth bug"  ──► [terms]  ──BM25───► "...auth...bug"   (overlap)
  spatial: (47.6,-122) ──► [point]  ──haversine──► nearest node  (meters)
                                                    ▲ flattr lives here
```

### Move 2 — the walkthrough

**flattr's spatial retrieval, end to end.** `nearest.ts:5`:

```ts
export function nearestNode(graph: Graph, point: LatLng): string {
  let bestDist = Infinity;
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    const d = haversine(point, { lat: n.lat, lng: n.lng });  // GEOMETRIC relevance
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
}
```

The relevance score is `haversine` distance — pure geometry. There's no
query embedding to cosine against (dense) and no tokenized query to score
by term frequency (sparse). The "query" is a `(lat, lng)` point and the
"documents" are nodes; relevance is meters. This is a fully legitimate
retrieval — it just lives in a family the dense/sparse dichotomy doesn't
cover.

```
  Layers-and-hops — flattr's spatial retrieval path

  ┌─ UI ──────┐ hop1: point (lat,lng)  ┌─ nearest.ts ─────────┐
  │MapScreen  │ ──────────────────────►│ min haversine        │ nearest.ts:5
  └───────────┘                        └──────────┬────────────┘
                  hop2: nearest node id ◄──────────┘
  ┌─ engine ──┐
  │astar.ts   │  routes from the retrieved node
  └───────────┘
```

**The boundary condition.** The mistake would be to slot flattr into the
dense/sparse debate ("is it dense or sparse?"). It's neither — asking
that question imports text-retrieval framing onto a geometric problem.
The dense-vs-sparse tradeoff (paraphrase recall vs exact-term precision)
has no meaning when the query is a coordinate. The right axis for flattr
is spatial-index choice (linear scan now, k-d tree at scale), not
embedding-vs-BM25.

### Move 3 — the principle

Dense and sparse are two answers to one question — *what makes text
relevant* — and the production answer is usually "both, fused." flattr
asks a different question — *what's physically nearest* — so it sits in a
third family with its own scaling story (spatial indexes). The principle:
name the relevance metric before reaching for a retrieval method.
Geometry isn't dense and isn't sparse; calling it either is a category
error.

## Primary diagram

```
  flattr's retrieval is spatial — a third family

  ┌─ TEXT retrieval (NOT BUILT in flattr) ───────────────────┐
  │ dense:  embed query → cosine top-k (semantic)             │
  │ sparse: tokenize → BM25 top-k (keyword)                   │
  │ hybrid: fuse both with RRF                                │
  └──────────────────────────────────────────────────────────┘
  ┌─ SPATIAL retrieval (BUILT) ──────────────────────────────┐
  │ point → haversine min → nearest node [nearest.ts:5]       │
  │ relevance = meters · scales with a spatial index, not ANN │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The dense/sparse/hybrid stack is the core of modern text retrieval —
dense for paraphrase recall, sparse for exact terms and identifiers, RRF
to fuse them. You've worked the dense side in **AdvntrCue**. flattr
sharpens the boundary of that whole conversation: its retrieval is real
and useful but *geometric*, so it belongs to the spatial family that the
dense/sparse axis simply doesn't address. Knowing that retrieval has more
than two families — and which one a coordinate query lives in — is the
distinction to carry.

## Interview defense

**Q: Is flattr's retrieval dense or sparse?** Answer: neither — it's
spatial. `nearestNode` (`nearest.ts:5`) scores relevance by `haversine`
distance, so the "query" is a coordinate and relevance is meters. Dense
(embedding cosine) and sparse (BM25) both operate on text; flattr has no
text in the retrieval loop. The dense-vs-sparse tradeoff doesn't apply;
the relevant axis is spatial-index choice at scale. Load-bearing point:
naming the relevance metric (geometry) reveals it's a third family.

```
  coordinate query + haversine = spatial retrieval ≠ dense ≠ sparse
```

Anchor: *"flattr retrieves by physical distance, not meaning or keywords —
that's spatial retrieval, a family the dense/sparse axis doesn't cover."*

## See also

- [01-embeddings.md](01-embeddings.md) — flattr's vectors are geographic.
- [04-vector-databases.md](04-vector-databases.md) — the store is a static graph.
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — N/A: nothing to fuse.
