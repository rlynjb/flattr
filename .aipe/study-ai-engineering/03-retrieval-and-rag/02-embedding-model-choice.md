# Embedding model choice — N/A: flattr embeds nothing

**Industry name(s):** embedding model selection / one-way embedding decision.
**Type:** Industry standard.

## Zoom out — there's no embedding step in flattr, so there's no model to choose

This is a decision you only face once you've decided to embed text.
flattr never embeds text — its only vectors are measured `(lat, lng)`
coordinates (see [embeddings](01-embeddings.md)) — so there is no
embedding model in the stack and no choice to make. The file exists to
mark the absence honestly and to name *why* the decision matters when it
does exist.

```
  Zoom out — the embedding-model slot is empty in flattr

  ┌─ engine (features/routing/) ────────────────────────────┐
  │  nodes carry (lat,lng) — measured, not embedded          │ nearest.ts
  │  ┌─ (NOT BUILT) embedding model ──────────────────────┐  │
  │  │  text-embedding-3 / BGE / on-device MiniLM ...      │  │
  │  │  ★ NOTHING SELECTS HERE — flattr has no text corpus │  │
  │  └─────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** there is no embedding layer; the routing engine reads
  coordinates directly.
- **Axis — what's the cost of changing the choice?** The reason this
  decision gets singled out: switching embedding models means
  **re-embedding the entire corpus**, because vectors from two models
  aren't comparable. It's a one-way door. flattr has no corpus, so the
  door doesn't exist.
- **Seam:** none. There is no embedding seam in flattr. The nearest thing
  is the input seam at `geocode` (`MapScreen.tsx:82`), which sends text to
  a *geocoder*, not an embedder.

## How it works

### Move 1 — the mental model

Picking an embedding model is like picking a hash function for a
persistent index: once you've hashed a million rows with it, switching
means re-hashing all of them, because the new function puts everything in
different buckets. Embedding models are the same — vectors from model A
and model B live in incompatible spaces, so a switch re-embeds the whole
corpus. That's why it's a deliberate, up-front choice. flattr never makes
it because it never builds an embedding index.

```
  Pattern — the one-way embedding decision (flattr never reaches it)

  pick model ──► embed entire corpus ──► index ──► query
       │                                              │
       └── switch model? ── re-embed EVERYTHING ──────┘
            (vectors aren't cross-comparable)

  flattr: no corpus → no index → no choice
```

### Move 2 — the walkthrough

**Where the decision would live (and why it's empty).** A flattr feature
would only need an embedding model if it had text to retrieve over — a
corpus of route notes, saved trips, place descriptions. It has none. The
route facts are computed (`RouteSummary`, `summary.ts:5`), the graph is
geographic (`graph.json`), and the only user text (an address) goes to
`geocode` (`geocode.ts:9`), which returns coordinates, not a vector.
So there's no row that ever gets embedded and no model to pick.

```
  Layers-and-hops — the (empty) embedding slot vs flattr's real path

  flattr's real input path:
  ┌─ UI ──────┐ hop1: address text  ┌─ geocode.ts ──────────┐
  │AddressBar │ ───────────────────►│ Nominatim → lat,lng   │ geocode.ts:9
  └───────────┘                     └────────────────────────┘
                  (no embedding model anywhere on this path)
```

**The boundary condition.** If flattr *did* add a corpus — say, semantic
search over saved routes — the choice would matter exactly because of the
one-way-door property: pick on-device (sentence-transformers / MiniLM,
matching flattr's local-first posture) over a hosted API, and commit,
because re-embedding later is the cost. But that's hypothetical; today
the slot is empty.

### Move 3 — the principle

Some decisions are reversible and some are one-way doors; embedding-model
choice is a one-way door because the artifact (the embedded corpus) is
expensive to regenerate and incompatible across models. The principle:
identify one-way doors early and choose deliberately. flattr's relevant
lesson is the *absence* — don't introduce a one-way door (an embedding
index) for a feature whose data is already structured and local.

## Primary diagram

```
  No corpus, no embedding model, no choice

  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ geocode(text) → lat,lng [geocode.ts:9]  ·  no embedding   │
  │ graph.json (geographic)  ·  RouteSummary (computed)       │
  └──────────────────────────────────────────────────────────┘
  ┌─ embedding-model choice (NOT BUILT, one-way door) ───────┐
  │ would only exist with a TEXT CORPUS to retrieve over —    │
  │ flattr has none, so the decision never arises             │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Embedding-model choice is one of the highest-leverage early decisions in
a RAG system precisely because it's hard to undo — you've lived this in
**AdvntrCue**, where the embedding model is locked in with the indexed
corpus. flattr is the case where the decision is simply not on the table:
no corpus, no index, no one-way door. The transferable insight is
recognizing when a decision *is* a one-way door versus when it's nothing
at all — flattr is the latter for embeddings.

## Interview defense

**Q: Which embedding model would you pick for flattr?** Answer: none —
there's nothing to embed. flattr has no text corpus; its vectors are
measured `(lat, lng)` coordinates and its only user text (an address)
goes to a geocoder (`geocode.ts:9`), not an embedder. The reason
embedding-model choice usually matters is the one-way-door cost
(re-embedding the whole corpus on a switch), and flattr has no corpus to
re-embed. If I ever added semantic search over saved routes, I'd pick
on-device to match local-first — but I wouldn't add it without a
measured need.

```
  No corpus → no index → no embedding model → no one-way door
```

Anchor: *"embedding-model choice is a one-way door, and flattr has no
corpus to walk through it — there's nothing to embed."*

## See also

- [01-embeddings.md](01-embeddings.md) — why flattr's vectors are geographic, not semantic.
- [03-chunking-strategies.md](03-chunking-strategies.md) — N/A: no corpus to chunk.
- [11-rag.md](11-rag.md) — why flattr's context is structured, not retrieved.
