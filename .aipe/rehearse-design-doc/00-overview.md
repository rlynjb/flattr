# Design Docs — flattr

At staff level the bottleneck usually isn't the code — it's writing the decision down so a room aligns behind it before the code gets written. These are the design docs flattr's significant decisions deserved: the written artifact you'd put in front of a reviewer or a promo committee, leading with the decision, owning the tradeoff, and surfacing the open questions. They're not invented — each one is a real, non-obvious call the codebase actually made, written up the way it should have been.

A design doc is expensive attention, so it's only spent where the decision was both **significant** (hard to reverse, cross-cutting) and **non-obvious** (a real alternative existed, someone will ask "why this way?"). flattr made three that clear the bar.

```
  WHICH DECISIONS GOT A DOC — ranked by "someone will ask why"

  ┌─ 01  BUILD-TIME GRAPH ARTIFACT (no database) ────────────┐
  │   hard to reverse: the whole runtime assumes a static     │
  │   read-only graph. real alternative: a routing server +    │
  │   spatial DB. cross-cutting: defines offline + no-backend. │
  └───────────────────────────────────────────────────────────┘
  ┌─ 02  PARAMETRIC DIRECTIONAL ROUTER ──────────────────────┐
  │   non-obvious: one search() = Dijkstra/A*/grade/directed;  │
  │   real alternative: a routing library. the directional     │
  │   cost (A→B ≠ B→A) is the product's differentiator.        │
  └───────────────────────────────────────────────────────────┘
  ┌─ 03  HONEST DEGRADATION UNDER A THROTTLED FREE API ──────┐
  │   non-obvious + lived: how to behave when elevation 429s.  │
  │   real alternative: fail the build, or silently fake flat. │
  │   chose: degrade but MARK it; the failure path is a design. │
  └───────────────────────────────────────────────────────────┘
```

Decisions deliberately *not* given a doc: which test runner (Vitest — a default nobody questions), file layout, the slider-vs-presets UI tweak (local, reversible). A doc for those would be wasted attention.

## The three docs

| Doc | The decision | Why it warranted writing down |
|-----|--------------|-------------------------------|
| `01-build-time-graph-artifact.md` | Ship the graph as a static, bundled, read-only artifact; no backend or DB. | Defines the entire runtime shape (offline, no server). Hard to reverse. |
| `02-parametric-directional-router.md` | Hand-roll one parametric `search()` with a directional grade cost and a finite `BLOCKED` sentinel. | The engine *is* the project; the directional cost is non-obvious and load-bearing. |
| `03-honest-degradation.md` | Best-effort flat elevation when the free API throttles — marked degraded, excluded from display, retried, cached. | The failure path is a deliberate design, not an afterthought; it was iterated under real 429s. |

## The doc template

Every doc follows the canonical RFC spine: **title + one-line summary → context/problem → goals & non-goals → the decision (with a mandatory diagram) → alternatives considered → tradeoffs accepted → risks & mitigations → rollout/migration → open questions.** Lead with the decision, never the suspense; own the cost without apology; surface what's still undecided.

## How to use these

Read them when you're about to *communicate or defend* a decision — a design review, a written proposal, a promo packet. They pair with the interview-defense book (`.aipe/rehearse-interview-defense/`): the defense book is the spoken version under follow-up pressure; these are the written version a reviewer reads before the meeting. The transferable rep is RFC-writing itself — lead with the decision, show the alternatives, own the tradeoff.
