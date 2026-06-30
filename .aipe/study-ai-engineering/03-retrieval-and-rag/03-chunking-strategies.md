# Chunking strategies — N/A: flattr has no corpus to chunk

**Industry name(s):** chunking / document segmentation for retrieval.
**Type:** Industry standard.

## Zoom out — chunking is a corpus operation, and flattr has no corpus

Chunking is the step where you cut documents into retrievable pieces
before embedding them. It only exists when you have a body of text to
retrieve over. flattr has no such body — its data is a geographic graph
(`graph.json`) and a computed route struct (`RouteSummary`), neither of
which is text. So there's nothing to chunk. This file marks the absence
and names the one structural rhyme worth noticing.

```
  Zoom out — the chunking slot is empty (no documents exist)

  ┌─ build (pipeline/) ─────────────────────────────────────┐
  │  OSM ways → split into edges → graph.json  build-graph.ts│
  │  ★ this LOOKS like chunking, but it segments GEOMETRY,   │
  │     not text — edges aren't retrievable chunks            │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** OSM ways → edge segmentation (`split.ts`) → graph.
- **Axis — what gets cut, and why?** In RAG: text is cut so each chunk is
  a coherent retrieval unit (enough context, not too much). In flattr:
  OSM ways are split into ~90m edges so grade is computed over sane
  baselines (`run-build.ts:33–37`) — a *geometric* cut for physics, not a
  text cut for retrieval. The axis (purpose of the split) is the contrast.
- **Seam:** `pipeline/split.ts`. flattr's only "segmentation" lives here,
  and it cuts line geometry, not prose.

## How it works

### Move 1 — the mental model

You know how you'd break a long markdown doc into sections before
indexing it for search — small enough to be precise, big enough to keep
context? That's chunking, and the unit you produce is the unit you
retrieve. flattr does have a *splitting* step, but it cuts road geometry
into short segments so elevation math stays physical — the output is an
edge, not a searchable chunk. Same verb, different noun.

```
  Pattern — chunking text vs splitting geometry

  RAG chunking:      document ─► [chunk][chunk][chunk] ─► embed each
                                 (retrieval units)

  flattr splitting:  OSM way ─► [edge][edge][edge]     ─► compute grade
                                 (physics units, ~90m) split.ts
```

### Move 2 — the walkthrough

**Why flattr splits — and why it's not chunking.** The build pipeline
splits ways to ~90m so grades aren't computed over baselines finer than
the elevation DEM. `run-build.ts:33–37`:

```ts
// splitting finer than the DEM would compute grades over sub-DEM baselines and spike
// wildly at cell steps. ~90m keeps grades physically sane on this coarse source ...
return { provider: openMeteoProvider(), sampleOpts: { dedupePrecision: 0.0008 }, maxSegM: 90 };
```

The segment length is chosen for *elevation physics*, not retrieval
quality. There's no embedding step after it, no query that retrieves an
edge by similarity, no notion of "too small loses context." Edges feed
the A* router, not a vector search. So the analogy to chunking is purely
structural — both cut a big thing into smaller units — and the *purpose*
is entirely different.

```
  Layers-and-hops — geometry split (not text chunk)

  ┌─ build ───┐ hop1: OSM ways   ┌─ split.ts ────────────┐
  │overpass.ts│ ────────────────►│ cut to ~90m segments  │ split.ts
  └───────────┘                  └──────────┬─────────────┘
                  hop2: edges (for grade)   │
  ┌─ build ───┐ ◄────────────────────────────┘
  │build-graph│  computes grade per edge — NOT embedded
  └───────────┘
```

**The boundary condition.** The trap is to call edge-splitting
"chunking." It isn't: chunks are retrieval units that get embedded and
matched by similarity; edges are physics units that get a grade and feed
a graph search. No embedding ever touches an edge. If you described
flattr as "chunking the map," you'd be importing RAG vocabulary onto a
deterministic geometry step.

### Move 3 — the principle

Chunking exists to make text retrievable at the right granularity — the
chunk is both the storage unit and the recall unit, and its size trades
precision against context. flattr's split has a different governing
constraint (DEM resolution / grade sanity), so it lands at a different
size for a different reason. The principle: segmentation granularity
follows the *consumer*. For RAG the consumer is a similarity search; for
flattr it's elevation math — so the two are unrelated despite the shared
shape.

## Primary diagram

```
  Two segmentations, two purposes

  ┌─ RAG (NOT BUILT in flattr) ──────────────────────────────┐
  │ document → chunks (200–500 tok) → embed → retrieve        │
  │ size tuned for: retrieval precision vs context            │
  └──────────────────────────────────────────────────────────┘
  ┌─ flattr (BUILT) ─────────────────────────────────────────┐
  │ OSM way → ~90m edges [split.ts] → grade → A* graph         │
  │ size tuned for: elevation-DEM physics (run-build.ts:33)   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Chunking is where a lot of RAG quality is won or lost — bad boundaries
fragment meaning and wreck retrieval. You've tuned this for real in
**AdvntrCue**, where chunk strategy directly moved retrieval quality.
flattr's edge-splitting is the look-alike that isn't: a deterministic
geometry cut governed by elevation resolution, with no retrieval
downstream. Recognizing that "splitting a big input into units" is
necessary but not sufficient to be chunking — there has to be a retrieval
consumer — is the distinction worth carrying.

## Interview defense

**Q: What's flattr's chunking strategy?** Answer: it has none, because it
has no text corpus. The look-alike is edge-splitting in `split.ts`, which
cuts OSM ways to ~90m — but that's tuned for elevation-DEM physics
(`run-build.ts:33–37`), not retrieval, and the edges feed the A* router,
never an embedding step. Chunking requires a retrieval consumer; flattr's
split has a graph-search consumer. Same shape, different purpose.

```
  edges = physics units (grade) ≠ chunks = retrieval units (similarity)
```

Anchor: *"flattr splits geometry for grade math, not text for retrieval —
there's no corpus and no embedding step, so it's not chunking."*

## See also

- [01-embeddings.md](01-embeddings.md) — no embedding step follows the split.
- [10-incremental-indexing.md](10-incremental-indexing.md) — the graph.json rebuild analog.
- [11-rag.md](11-rag.md) — why flattr's context is structured, not retrieved.
