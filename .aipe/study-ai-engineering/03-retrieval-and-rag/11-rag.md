# RAG — and the route-describe seam (no RAG here, but here's where AI attaches)

**Industry name(s):** Retrieval-Augmented Generation. **Type:** Industry
standard.

## Zoom out — flattr has no RAG, but it has the cleanest output→prompt seam in the repo

flattr does not retrieve anything semantic, does not embed text, does
not augment a prompt. There is no RAG. But this file earns its place
because the **route-describe seam** — the single most natural place to
bolt an LLM onto flattr — lives right next to where RAG would go, and
the structured-output discipline RAG depends on is exactly what that
seam needs. So: RAG taught as study material, then the real seam.

```
  Zoom out — flattr's output→prompt seam (the LLM that isn't there)

  ┌─ engine (features/routing/) ────────────────────────────┐
  │  astar.ts → Path → routeSummary() → RouteSummary        │
  │                                  {distanceM,climbM,steep}│ summary.ts:5
  └────────────────────────────┬─────────────────────────────┘
                              produced at MapScreen.tsx:159
  ┌─ UI (mobile/) ─────────────▼─────────────────────────────┐
  │  RouteSummaryCard renders text (MapScreen.tsx:368)       │
  │  ★ an LLM "describe my route" call would splice HERE     │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** engine produces a struct → UI renders it.
- **Axis — who writes the prose?** Today: deterministic code in
  `RouteSummaryCard` writes "Flat all the way" / "⚠ Flattest available".
  In a route-describe feature: an LLM writes it from the struct. The axis
  (who authors the user-facing text) flips at the
  `summary → RouteSummaryCard` boundary.
- **Seam:** `MapScreen.tsx:368`. Everything above it (the struct) is the
  prompt input; everything below (the card) is where generated prose
  lands. This is the seam, and it is load-bearing because it's the one
  spot where you can splice an LLM without touching the router.

## How it works

### Move 1 — the mental model (RAG, then the seam)

RAG is retrieve → augment → generate: pull relevant chunks, stuff them
into the prompt, let the model answer from them. flattr's would-be
feature is the *generate* step **without** the retrieve step — there's
no corpus to retrieve from. The "context" is one struct: `RouteSummary`.

```
  Pattern — RAG (general) vs flattr's degenerate case

  RAG:        query → retrieve chunks → augment prompt → generate
                         ▲ flattr has NO corpus here
  flattr:     RouteSummary ─────────► augment prompt → generate prose
              (the "retrieved context" is already in hand)
```

That's worth saying out loud in an interview: *flattr doesn't need RAG.*
The data the model needs (`distanceM`, `climbM`, `steepCount`) is
already computed and typed. Adding vector search here would be the
spec's "above-threshold" anti-pattern — RAG on a feature that works
without it.

### Move 2 — the walkthrough of the seam

**The struct that becomes the prompt.** `summary.ts:11`:

```ts
export function routeSummary(graph: Graph, path: Path, _userMax: number): RouteSummary {
  let climbM = 0;
  for (let i = 0; i < path.edges.length; i++) {
    const edge = edgeById(graph, path.edges[i]);
    const fromNode = path.nodes[i];
    const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
    if (directedRise > 0) climbM += directedRise;   // uphill only
  }
  return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
}
```

Three numbers, all derived, all typed. That's your entire prompt
context. A route-describe prompt templates them: *"Distance {distanceM}m,
climb {climbM}m, {steepCount} steep blocks over the user's max.
Describe this walk in one friendly sentence."*

**Where it's produced and consumed today.** `MapScreen.tsx:159`:

```ts
summary: routeSummary(graph, r.path, userMax),
```

and at `:368` it flows into `<RouteSummaryCard summary={routed.summary} … />`.

**The splice.** A route-describe feature inserts one call between those
two lines:

```
  Layers-and-hops — splicing the LLM at MapScreen.tsx:368

  ┌─ engine ──┐ hop1: RouteSummary   ┌─ (NOT BUILT) LLM ──┐
  │summary.ts │ ───────────────────► │ describeRoute()    │
  └───────────┘                      │ struct → prose     │
                                     └─────────┬──────────┘
  ┌─ UI ──────┐ hop2: {headline} ◄─────────────┘
  │SummaryCard│  renders generated prose instead of static text
  └───────────┘
```

**The boundary condition (two of them).** First: the prompt must be fed
a *typed* struct, and the output must be schema-validated
([structured outputs](../01-llm-foundations/04-structured-outputs.md)),
or `RouteSummaryCard` loses the typed contract it has today. Second — and
this is the one to flag — if the route name or any geocoded label ever
enters this prompt, it's untrusted OSM text and an injection vector
([prompt injection](../06-production-serving/03-prompt-injection.md)).

### Move 2.5 — current vs future state

```
  Comparison — what changes, what doesn't

  Phase A (now)                    Phase B (route-describe shipped)
  ───────────────                  ───────────────────────────────
  routeSummary() → struct          routeSummary() → struct  (UNCHANGED)
  RouteSummaryCard writes          describeRoute(struct) → prose
    static text                    RouteSummaryCard renders prose
  no model, no cost, offline       one LLM call per route, online
                                     (or on-device, dryrun-style)
```

The takeaway: the router, the cost function, the graph — **none of it
changes.** The seam is entirely in the UI handoff. That's why it's the
right first AI feature for flattr.

### Move 3 — the principle

RAG is for when the model needs knowledge it doesn't have. flattr's
model would need *no* external knowledge — the route facts are computed
and in hand. The general principle: don't reach for retrieval when the
context is already structured and local. The seam that matters is the
output → prompt handoff, not a vector store.

## Primary diagram

```
  The route-describe seam, fully labelled

  ┌─ Core engine ───────────────────────────────────────────┐
  │ A* (astar.ts) → Path → routeSummary() [summary.ts:11]    │
  │                          → RouteSummary {distanceM,...}   │
  └────────────────────────────┬─────────────────────────────┘
                  produced: MapScreen.tsx:159
  ┌─ (NOT BUILT) LLM layer ────▼─────────────────────────────┐
  │ describeRoute(summary) — struct→prose, JSON-mode output  │
  │ ⚠ if labels enter prompt → injection risk                │
  └────────────────────────────┬─────────────────────────────┘
                  consumed: MapScreen.tsx:368
  ┌─ UI ───────────────────────▼─────────────────────────────┐
  │ RouteSummaryCard — renders prose (was static text)       │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

RAG emerged to give frozen-training-data models fresh/private knowledge.
You shipped real RAG in **AdvntrCue** (pgvector + GPT-4). flattr is the
counter-example that proves you know *when not to use it*: the context is
already a typed struct, so the feature is a single chain, not retrieval.
Naming that restraint is stronger interview signal than bolting RAG onto
everything.

## Project exercises

### B2-RAG.1 — route-describe single chain (no retrieval)

- **Exercise ID:** B2-RAG.1
- **What to build:** `describeRoute(summary: RouteSummary): {headline,
  caution}` that templates the struct into a prompt and validates the
  output schema. Start with an on-device/stub model (dryrun-style) since
  flattr is local-first.
- **Why it earns its place:** it's the smallest real AI feature flattr
  can ship, and it exercises structured-output discipline end to end.
- **Files to touch:** new `features/routing/describe.ts`;
  `mobile/src/MapScreen.tsx:159–368`; `RouteSummaryCard.tsx`.
- **Done when:** the card renders generated prose, output is
  schema-validated, and a unit test pins the prompt-input shape.
- **Estimated effort:** half a day with a stub model.

## Interview defense

**Q: Would you add RAG to flattr?** Answer: **No.** The route facts are
already a typed struct (`RouteSummary`, `summary.ts:5`) — there's no
corpus to retrieve from. The right feature is a single chain at the
`MapScreen.tsx:368` seam, not retrieval. Adding a vector store would be
the "above-threshold" anti-pattern. Load-bearing point people miss: the
seam is the *output handoff*, and the prompt input is already structured.

```
  RouteSummary (already typed) → [single chain] → prose. No retrieval.
```

Anchor: *"flattr's context is local and structured, so RAG is the wrong
tool — the seam is output→prompt, not query→retrieve."*

## See also

- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — the output schema this seam needs.
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the input (geocode) seam.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — `display_name` risk if labels enter the prompt.
- [../ai-features-in-this-codebase.md](../ai-features-in-this-codebase.md) — all three seams in one place.
