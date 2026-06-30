# Reranking — N/A: flattr has no candidate list to rerank

**Industry name(s):** reranking / cross-encoder two-stage retrieval.
**Type:** Industry standard.

## Zoom out — reranking polishes a candidate list; flattr never produces one

Reranking is the second stage of retrieval: a fast retriever returns ~50
candidates, then a slow cross-encoder reorders the top few for quality.
It needs a candidate list to reorder. flattr's retrieval (`nearestNode`)
returns a single best node by argmin — there's no top-50 to refine. No
list, no rerank stage.

```
  Zoom out — the rerank stage is empty (no candidate list)

  ┌─ app (mobile/) ─────────────────────────────────────────┐
  │  nearestNode → ONE node (argmin)  ← no top-k candidates  │ nearest.ts:5
  │  ┌─ (NOT BUILT) rerank ─────────────────────────────┐    │
  │  │  top-50 → cross-encoder → top-5                   │    │
  │  │  ★ flattr has no top-50 to feed it                 │    │
  │  └────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** point → single nearest-node scan → routing. No two-stage
  retrieve-then-rerank pipeline.
- **Axis — is retrieval one stage or two?** Reranking exists to add a
  second, higher-quality stage on top of a coarse first stage. flattr is
  single-stage: one exact `haversine` scan, one answer. The axis
  ("how many stages?") reads *one*, so there's no second stage to be a
  reranker.
- **Seam:** none for reranking. The retrieval seam (`nearest.ts:10`)
  emits one node, not a list.

## How it works

### Move 1 — the mental model

Two-stage retrieval is "cast a wide cheap net, then carefully sort the
catch." Stage one (bi-encoder cosine) is fast and coarse and returns
many; stage two (cross-encoder) is slow and accurate and reorders the few
that matter. flattr does neither stage on a list — its retrieval is a
single exact minimum, already optimal for its one metric, so there's
nothing coarse to refine.

```
  Pattern — two-stage retrieve→rerank (flattr is single-stage)

  stage 1: bi-encoder → top-50 (fast, coarse)
  stage 2: cross-encoder → top-5 (slow, accurate)   ← rerank lives here
            ▲ needs a candidate list
  flattr:  exact haversine argmin → top-1 (already optimal, one stage)
```

### Move 2 — the walkthrough

**Why there's no candidate list.** `nearest.ts:5` is already exact:

```ts
for (const id of Object.keys(graph.nodes)) {
  const d = haversine(point, { lat: n.lat, lng: n.lng });
  if (d < bestDist) { bestDist = d; bestId = id; }   // exact min, no shortlist
}
return bestId;
```

Reranking exists to fix a *coarse* first stage — approximate retrievers
trade accuracy for speed, so a second pass cleans up the ordering.
flattr's first (and only) stage is *exact*: a full scan that already
finds the true nearest node. There's no approximation error to correct
and no shortlist to reorder. The two-stage pattern presupposes a quality
gap that flattr's exact scan doesn't have.

```
  Layers-and-hops — exact single stage, no rerank

  ┌─ UI ──────┐ hop1: point   ┌─ nearest.ts (EXACT) ──┐
  │MapScreen  │ ─────────────►│ full scan → true min   │ nearest.ts:5
  └───────────┘               └──────────┬─────────────┘
                  hop2: best node ◄────────┘  (no top-50 → no rerank)
```

**The boundary condition.** A reranker only pays off when stage one is
approximate and recall is measurably imperfect — you measure hit@k before
and after to justify it. flattr's retrieval is exact and returns one
answer, so a reranker has no input and no error to fix. Bolting one on
would be reordering a list of length one.

### Move 3 — the principle

Reranking is a remedy for the speed/accuracy compromise of a coarse first
stage — it's the "polish the shortlist" half of two-stage retrieval, and
it earns its place only when measured retrieval quality is bad. flattr's
single exact scan has no compromise to remedy. The principle: add a
rerank stage only when stage one is approximate *and* the numbers say it's
hurting — never reflexively, and never when retrieval is already exact.

## Primary diagram

```
  No candidate list → no reranking

  ┌─ two-stage retrieval (NOT BUILT) ────────────────────────┐
  │ bi-encoder top-50 → cross-encoder rerank → top-5          │
  │ justified by hit@k before/after                           │
  └──────────────────────────────────────────────────────────┘
  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ exact haversine scan → top-1 [nearest.ts:5]               │
  │ no shortlist · no approximation · nothing to polish       │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Reranking with a cross-encoder is the standard fix when bi-encoder recall
is good but ordering is bad — the kind of quality tuning you'd reach for
in **AdvntrCue** after measuring hit@k. flattr's retrieval is exact and
single-answer, so the two-stage pattern has no foothold. The transferable
discipline is the measure-before-adding rule: reranking is earned by
numbers, and flattr's retrieval gives it nothing to earn.

## Interview defense

**Q: Would a reranker improve flattr's retrieval?** Answer: no — there's
no candidate list to rerank. `nearestNode` (`nearest.ts:5`) is an *exact*
scan returning the single true-nearest node, not a coarse top-50.
Reranking remedies an approximate first stage; flattr's first stage is
exact, so there's no quality gap and no shortlist to reorder. You add a
reranker only when measured recall is bad — flattr's gives it nothing.

```
  exact top-1 → no shortlist → nothing for a cross-encoder to reorder
```

Anchor: *"reranking polishes a coarse shortlist — flattr's retrieval is
exact and returns one node, so there's no list and no stage two."*

## See also

- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — no rankings to fuse either.
- [../02-context-and-prompts/02-lost-in-the-middle.md](../02-context-and-prompts/02-lost-in-the-middle.md) — the "few relevant items" instinct reranking serves.
- [11-rag.md](11-rag.md) — why flattr's context is structured, not retrieved.
