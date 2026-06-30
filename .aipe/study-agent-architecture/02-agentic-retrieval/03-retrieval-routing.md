# Retrieval routing

**Industry names:** retrieval routing · source routing. **Type:** Industry
standard. **In this codebase: Not yet implemented** — flattr has one source
(the graph) and no model to route.

> When there are multiple knowledge sources, route the query to the right
> one *before* retrieving. This is `01-reasoning-patterns/07-routing.md`'s
> pattern applied to retrieval. flattr's seam already routes between
> sources by hand (geocode for addresses, the graph for paths).

---

## Zoom out, then zoom in

**Zoom out.**

```
  query → ┌─ router: which source? ──┐
          └──────────┬────────────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     vector DB    SQL DB     web search
     (semantic)   (exact)    (fresh)
```

**Zoom in.** A single vector store is rarely the whole answer. Production
retrieval routes between a semantic store (paraphrase queries), a
relational store (exact lookups), and live search (freshness).

---

## How it works

### Move 1 — the mental model

flattr's seam (`07-routing.md`) already does deterministic source routing,
hand-coded in `MapScreen.tsx`'s flow:

```
  flattr's hand-coded source routing (today)

  "123 Main St" (an address)  → geocode()    (Nominatim — external source)
  a tapped lat/lng            → nearestNode() (the graph — local source)
  "route A to B"              → search()      (the graph — local source)
```

That's the retrieval-routing *shape* with the routing done by code in the
UI, not by a model.

### Move 2 — what an agentic version adds

If flattr indexed POIs for the "plan an afternoon" feature, it would have
*two* sources: the geometric graph (exact node lookups) and a POI
description index (semantic — "find a quiet cafe"). A model router would
pick: semantic query → POI index; "route between these coords" → graph
search. That's a vector-store-vs-exact-store split, the production pattern.
Today the routing is fixed in the UI; agentic routing moves the decision to
a model.

### Move 3 — the principle

A single source is rarely the whole answer; routing between exact,
semantic, and fresh sources is what production retrieval looks like.
flattr's UI already routes between an external geocoder and the local
graph — the agentic version replaces the hand-coded route with a model
that picks the source from intent.

---

## Interview defense

**Q: Does flattr route between sources?**

Yes, deterministically: an address goes to `geocode()` (external
Nominatim), a coordinate to `nearestNode()` (local graph), a route request
to `search()` (local graph) — routing done in the UI, by code. The agentic
version adds a second *semantic* source (a POI index) and lets a model pick
between exact graph lookups and semantic POI search.

Anchor: *"flattr's UI routes addresses to the geocoder and coordinates to
the graph — that's deterministic source routing; agentic routing moves the
pick to a model and adds a semantic source."*

---

## See also

- `01-agentic-rag.md` · `02-self-corrective-rag.md`
- `../01-reasoning-patterns/07-routing.md` (the same pattern, for tools)
- Mechanics (cross-ref): `study-ai-engineering`'s `03-retrieval-and-rag/`
