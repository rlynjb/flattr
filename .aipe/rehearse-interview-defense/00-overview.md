# Interview Defense — flattr

> A book for defending **flattr** in a senior-engineering interview.
> Eight chapters, read in order at least once. The night before, read
> only the one-page summary at the end of each chapter.

flattr is a grade-aware pedestrian/scooter router — "optimized for flat,
not fast." You hand-rolled a parametric A* search over a build-time static
graph. No backend, no database, no LLM in the product. This book teaches
you to walk an interviewer through that, hold ground under follow-ups, and
own — out loud — the one place you're genuinely thin (distributed systems
at horizontal scale).

---

## The system at a glance — the master diagram

This is the picture you re-anchor to all book long. Every chapter is a
zoom into one band of it.

```
  flattr — the whole system in one frame

  ┌─ BUILD TIME (pipeline/, runs on your machine, offline) ──────────────┐
  │                                                                       │
  │   OSM streets ──► split ──► Open-Meteo elevation ──► grade ──► graph  │
  │   (overpass.ts)  (split.ts)  (elevation.ts, free)   (grade.ts)  .json │
  │                                                                       │
  │   output: ONE static artifact — mobile/assets/graph.json             │
  │           seattle-mvp · 1621 nodes · 1879 edges                      │
  └───────────────────────────────┬───────────────────────────────────────┘
                                  │  bundled into the app, read-only
  ┌─ RUNTIME (mobile/, Expo ~56 / RN 0.85 / React 19) ─────────▼──────────┐
  │                                                                       │
  │  ┌─ UI ──────────────┐   ┌─ ENGINE (features/, pure TS) ──────────┐  │
  │  │ MapScreen.tsx     │   │ nearestNode()   snap tap → node id      │  │
  │  │ GradeSlider userMax│──►│ directedAstar() ONE search() engine     │  │
  │  │ MapLibre render   │◄──│   cost.ts  signed directed-grade penalty │  │
  │  │ RouteSummaryCard  │   │   pqueue.ts hand-rolled binary heap      │  │
  │  └───────────────────┘   └─────────────────────────────────────────┘  │
  │                                                                       │
  │  NO server · NO DB · NO network in the routing hot path               │
  └───────────────────────────────────────────────────────────────────────┘

  the one knob:  userMax  (max comfortable uphill grade %)
  the one hook:  cost A→B  ≠  cost B→A   (uphill costs, downhill is free)
```

The two-band split — build time vs runtime — is the spine of the whole
defense. Almost every hard question resolves to "which band are we in?"

---

## The eight chapters

| # | Chapter | The question it answers | Covered |
|---|---------|------------------------|---------|
| 01 | The pitch | "Tell me about a project you built" | 10s / 30s / 90s pitch; the directional-cost hook |
| 02 | The architecture | "Walk me through the system" | build/runtime split, one request traced end-to-end, why no backend |
| 03 | The choices | "Why this stack?" | hand-rolled vs OSRM, Expo vs the spec's Next.js, Open-Meteo vs Google, static graph vs DB |
| 04 | The scale story | "What breaks first at 10x?" | the three real axes (graph size, elevation quota, per-query work) — NOT users |
| 05 | The failure story | "What happens when things go wrong?" | elevation 429, BLOCKED steep-vs-disconnected, the unvalidated graph load |
| 06 | The hard parts | "Hardest bug? Proudest? Least confident?" | disconnected-components "no route", one search() / admissible A*, the bidirectional proof |
| 07 | The counterfactuals | "What would you do differently?" | validate the graph load, an ElevationProvider seam, design the data seam up front |
| 08 | The AI question | "Did you use AI to build this?" | the calibrated-honest answer; three modes of decision-making |

---

## How to use this book

```
  FIRST READ            REVIEW                 NIGHT BEFORE
  ──────────            ──────                 ────────────
  chapters in order     skim the chapter        read only the
  one per sitting       diagrams + pull         one-page summary
  front to back         quotes + boxes          at each chapter end
```

The six visual treatments recur in every chapter, so the eye finds them on
re-read:

- **Chapter-opening diagram** — the chapter's visual spine
- **"WHAT THEY'RE REALLY ASKING" callouts** (single-line box) — before every question
- **Strong vs weak side-by-sides** — the contrast does the teaching
- **"WHEN YOU DON'T KNOW" boxes** (double-line box) — at least one per chapter, leaning into the distributed-systems gap
- **Follow-up decision trees** — where the conversation goes next
- **Pull quotes** — the lines you carry into the room

---

## The honest spine of this defense

You did not build a distributed system. You built a graph algorithm and a
mobile client around it. The strength of this project is *depth in a narrow
place*: a hand-rolled, provably-admissible, directional-cost A* with real
tests. The weakness is *breadth*: there is no server, no horizontal scale,
no queue, no replication — and you have not shipped those anywhere yet.

Strong candidates own both. This book teaches you to lead with the depth,
and to name the breadth gap before the interviewer corners you into it.

```
  ▸ Lead with the thing you built deeply.
    Name the thing you haven't built before they make you.
```

---

## Cross-links — where to go deeper

This book is the **project-level** opener — the wide walk-through. For the
**concept-level** deep dives, when an interviewer drills into one mechanism:

- Algorithm internals (A* admissibility, heaps, bidirectional, graph
  traversal): **`.aipe/study-dsa-foundations/`**
- Architecture, boundaries, scale, failure handling at the system level:
  **`.aipe/study-system-design/`**

Use both. The concept files prepare the deep dive; this book prepares the
wide opener.
