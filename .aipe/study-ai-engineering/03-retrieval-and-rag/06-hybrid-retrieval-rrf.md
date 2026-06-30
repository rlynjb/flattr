# Hybrid retrieval with RRF — N/A: flattr has nothing to fuse

**Industry name(s):** hybrid retrieval / Reciprocal Rank Fusion (RRF).
**Type:** Industry standard.

## Zoom out — RRF fuses two ranked text lists; flattr produces neither

RRF combines a dense ranking and a sparse ranking into one, so a doc that
ranks well in both rises to the top. It presupposes *two retrievers over
a text corpus*. flattr has zero text retrievers — its one retrieval is a
single geographic nearest-node scan that returns *one* node, not a ranked
list to fuse. There's nothing to combine.

```
  Zoom out — the fusion slot is empty (no rankings exist)

  ┌─ app (mobile/) ─────────────────────────────────────────┐
  │  nearestNode(point) → ONE node id  (not a ranked list)   │ nearest.ts:5
  │  ┌─ (NOT BUILT) hybrid retrieval ────────────────────┐   │
  │  │  dense list + sparse list → RRF → fused ranking    │   │
  │  │  ★ flattr has no dense list and no sparse list      │   │
  │  └─────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** point → single nearest-node scan → routing. No ranking
  layer, no fusion layer.
- **Axis — how many ranked lists exist?** RRF needs ≥2. flattr produces
  a single best node (an argmin), not a top-k ranking, so the count is
  zero ranked lists. The axis bottoms out immediately.
- **Seam:** none for fusion. The only retrieval seam (`nearest.ts:10`)
  returns one result by argmin, not a list.

## How it works

### Move 1 — the mental model

RRF is voting by rank: each retriever ranks the candidates, every
candidate scores `sum of 1/(k + rank)` across the lists, and things that
place well everywhere win — no score normalization needed. The whole
mechanism assumes multiple ranked lists over the same candidate set.
flattr never builds even one ranked list; it takes an argmin.

```
  Pattern — RRF fuses ranked lists (flattr has none)

  dense  → [d3, d7, d1]            score(doc) = Σ 1/(k+rank)
  sparse → [d7, d2, d5]            → d7 wins (ranks high in both)
            ▲ flattr produces no such lists — it returns one node
  flattr → argmin haversine → single node id   (nothing to fuse)
```

### Move 2 — the walkthrough

**Why there's nothing to fuse.** `nearest.ts:5` returns a single id:

```ts
let bestDist = Infinity;
for (const id of Object.keys(graph.nodes)) {
  const d = haversine(point, { lat: n.lat, lng: n.lng });
  if (d < bestDist) { bestDist = d; bestId = id; }   // argmin, not a ranking
}
return bestId;                                         // ONE result
```

It keeps the single closest node. There's no second retriever, no top-k
list, and no second signal to combine — so RRF has no inputs. flattr's
"relevance" is one metric (geographic distance) with one answer (the
nearest), which is the opposite of the multi-signal setting RRF exists
for.

```
  Layers-and-hops — single argmin, no fusion stage

  ┌─ UI ──────┐ hop1: point     ┌─ nearest.ts ──────────┐
  │MapScreen  │ ───────────────►│ argmin haversine       │ nearest.ts:5
  └───────────┘                 └──────────┬─────────────┘
                  hop2: ONE node id ◄───────┘   (no list → no RRF)
```

**The boundary condition.** RRF earns its place only when two retrievers
disagree in useful ways (dense catches paraphrases, sparse catches exact
terms). flattr has one signal and one answer, so introducing RRF would be
fusing a list with itself — meaningless. The honest statement is: no
second retriever, no fusion.

### Move 3 — the principle

RRF is a way to reconcile *disagreeing* rankings without trusting either's
raw scores. It's valuable exactly when you have multiple imperfect signals
over the same candidates. flattr has one perfect-enough signal (geographic
distance) and returns a single argmin, so there's nothing to reconcile.
The principle: fusion is for multi-signal retrieval; with one metric and
one answer, you don't rank — you minimize.

## Primary diagram

```
  Nothing to fuse — flattr returns one node, not rankings

  ┌─ hybrid + RRF (NOT BUILT) ───────────────────────────────┐
  │ dense list + sparse list → RRF (Σ 1/(k+rank)) → fused     │
  │ needs ≥2 ranked lists over a text corpus                  │
  └──────────────────────────────────────────────────────────┘
  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ argmin haversine → single node id [nearest.ts:5]          │
  │ one signal · one answer · no ranking · no fusion          │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Hybrid retrieval with RRF is the production default when one retriever
isn't enough — and you've felt the need for it on the text side of
**AdvntrCue**, where dense alone misses exact identifiers. flattr is the
degenerate case: one geometric signal, one argmin, no list, no fusion.
The transferable point is recognizing RRF's precondition — *multiple
ranked lists* — and seeing immediately that an argmin doesn't qualify.

## Interview defense

**Q: How would you fuse flattr's retrieval signals with RRF?** Answer: I
wouldn't — there's one signal and one answer. `nearestNode`
(`nearest.ts:5`) is an argmin over `haversine` distance returning a single
node, not a ranked list. RRF needs ≥2 ranked lists to reconcile; flattr
produces zero. Fusion presupposes disagreement between retrievers, and
flattr has exactly one geometric retriever.

```
  one metric → argmin → one node. RRF needs ≥2 lists; there are none.
```

Anchor: *"RRF fuses disagreeing rankings — flattr has one signal and
returns one node, so there's nothing to fuse."*

## See also

- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — the two signals RRF would combine; flattr has neither.
- [07-reranking.md](07-reranking.md) — N/A: no candidate list to rerank.
- [11-rag.md](11-rag.md) — why flattr's context is structured, not retrieved.
