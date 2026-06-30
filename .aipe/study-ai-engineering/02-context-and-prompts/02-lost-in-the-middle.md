# Lost-in-the-middle — and flattr's "surface few, not many" instinct

**Industry name(s):** lost-in-the-middle / positional attention bias.
**Type:** Industry standard.

## Zoom out — N/A to flattr's prompts, but the underlying instinct is everywhere in it

flattr has no long context to bury anything in, so the literal
phenomenon — a model attending strongly to the start and end of a long
prompt and missing the middle — never fires here. But the *design
principle that mitigates it* — surface the few items that matter, don't
dump everything — is already how flattr's UI presents a route. The
`RouteSummary` shows `steepCount`, not every steep edge. That's the same
instinct, applied to a human reader instead of a model.

```
  Zoom out — the "surface few" instinct in flattr's output layer

  ┌─ engine (features/routing/) ────────────────────────────┐
  │  Path has every edge; routeSummary() distills to 3 nums  │ summary.ts:11
  │    {distanceM, climbM, steepCount}  ← steepCount, not the│
  │                                       list of steep edges │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ UI (mobile/) ─────────────▼─────────────────────────────┐
  │  RouteSummaryCard shows the 3 numbers (MapScreen.tsx:368) │
  │  ★ "few relevant items" — the lost-in-the-middle fix,    │
  │     applied to a human, not a model                       │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** full path (many edges) → distilled struct (3 fields) → UI.
- **Axis — how much detail reaches the consumer?** In a long-context LLM
  prompt: everything reaches the model, and the middle gets ignored. In
  flattr: the engine distills first, so only the salient signal
  (`steepCount`) reaches the UI. The axis (volume of detail surfaced)
  flips at `routeSummary()`.
- **Seam:** `summary.ts:11`. Above it, the `Path` carries every edge;
  below it, three numbers. That distillation *is* the lost-in-the-middle
  mitigation, done upstream so there's no middle to lose.

## How it works

### Move 1 — the mental model

You know how a code reviewer skims a 40-line diff and reads the
top and bottom carefully but glazes over the middle? LLMs do exactly
that with long context — empirically strong attention to the start and
end, weak through the middle. Stuffing 20 docs in and asking a question
buries the relevant one in the dead zone. The fix is the same one you'd
give the reviewer: surface the three things that matter, not all twenty.

```
  Pattern — attention falls off in the middle of long context

  position:   start ────────────── middle ────────────── end
  attention:  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████████
                      ▲ relevant doc buried here = missed

  the fix: retrieve few, place the best at the edges
  flattr's version: distill BEFORE display — no middle exists
```

### Move 2 — the walkthrough

**Where flattr distills (so there's no middle to lose).** The engine
hands the UI a `Path` with every edge in it, but `routeSummary()`
collapses that to three numbers — `summary.ts:11`:

```ts
export function routeSummary(graph: Graph, path: Path, _userMax: number): RouteSummary {
  let climbM = 0;
  for (let i = 0; i < path.edges.length; i++) {     // walks EVERY edge
    const edge = edgeById(graph, path.edges[i]);
    const fromNode = path.nodes[i];
    const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
    if (directedRise > 0) climbM += directedRise;
  }
  return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
}
```

It iterates the whole path internally, then returns `steepCount` — a
single number — not the list of steep edges. The UI never sees the long
list, so there's no long list to bury the important part in. That's the
lost-in-the-middle fix applied upstream: distill, then display.

```
  Layers-and-hops — distill before display

  ┌─ engine ──┐ hop1: Path (every edge)   ┌─ routeSummary() ─────┐
  │astar.ts   │ ─────────────────────────►│ collapse to 3 fields │ summary.ts:11
  └───────────┘                            └──────────┬───────────┘
                        hop2: {distanceM,climbM,steepCount}
  ┌─ UI ──────┐ ◄──────────────────────────────────────┘
  │SummaryCard│  shows steepCount, NOT the steep-edge list
  └───────────┘
```

**The boundary condition — where flattr could regress.** If a future
route-describe prompt fed the model the *full edge list* instead of the
struct, flattr would manufacture a lost-in-the-middle problem it doesn't
have: a steep block in the middle of a long edge list could get ignored
by the model exactly the way doc 3 gets ignored. The discipline that
prevents it is the one already in `routeSummary()` — hand over the
distilled signal, not the raw sequence.

### Move 3 — the principle

Lost-in-the-middle is a special case of a general rule: relevance beats
volume. A model (or a person) does better with three salient items than
twenty where three are salient. flattr never hits the LLM version because
it distills upstream — `steepCount`, not the edge list. The principle
travels: surface the few items that matter, and you never have to worry
about what attention does to the middle.

## Primary diagram

```
  Distill upstream so there's no middle to lose

  ┌─ Core engine ───────────────────────────────────────────┐
  │ Path (every edge) → routeSummary() [summary.ts:11]        │
  │   walks all edges, returns {distanceM, climbM, steepCount}│
  └────────────────────────────┬─────────────────────────────┘
              the long list NEVER leaves the engine
  ┌─ UI ───────────────────────▼─────────────────────────────┐
  │ RouteSummaryCard shows 3 numbers (MapScreen.tsx:368)      │
  │ "few relevant items, not many" — the lost-in-middle fix   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Lost-in-the-middle came out of long-context retrieval research: as
context windows grew, teams found that more retrieved docs *hurt* recall
past a point, because the model stopped reading the middle. The mitigation
is retrieval + reranking — surface the best few, place them at the edges.
You've handled the retrieval-quality side of this in **AdvntrCue** (rerank
so the right chunk lands where the model reads). flattr never reaches the
problem because its engine distills facts before they're displayed — the
same "few salient signals" instinct, one layer earlier.

## Project exercises

### B-LITM.1 — keep the describe prompt distilled, not raw

- **Exercise ID:** B-LITM.1
- **What to build:** ensure the route-describe prompt (if added) consumes
  `RouteSummary` only, with a test asserting the full edge list never
  enters the prompt — encoding "distill, then describe."
- **Why it earns its place:** it pins the one regression that would import
  a lost-in-the-middle problem into a codebase that doesn't have one.
- **Files to touch:** new `features/routing/describe.ts`;
  `features/routing/summary.ts:11` (the distillation it must not bypass).
- **Done when:** a test fails if the prompt is built from `path.edges`
  instead of the summary struct.
- **Estimated effort:** an hour.

## Interview defense

**Q: Does lost-in-the-middle affect flattr?** Answer: not literally —
there's no long context. But the mitigation principle is already in the
code: `routeSummary()` (`summary.ts:11`) distills the full path to
`steepCount` rather than surfacing every steep edge, so the UI shows few
salient signals, not many. Load-bearing point: if a describe prompt ever
fed the model the raw edge list, *that* would create the problem — so the
fix is to keep handing over the distilled struct.

```
  Path (many edges) → routeSummary → 3 nums → UI. No middle to bury.
```

Anchor: *"flattr distills before it displays — steepCount, not the
edge list — which is the lost-in-the-middle fix applied one layer up."*

## See also

- [01-context-window.md](01-context-window.md) — the same "structure upstream" instinct.
- [../03-retrieval-and-rag/07-reranking.md](../03-retrieval-and-rag/07-reranking.md) — the LLM-side fix (place the best few at the edges).
- [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) — the route-describe seam.
