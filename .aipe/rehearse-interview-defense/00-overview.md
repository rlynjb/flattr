# Interview Defense — flattr

> A book for defending **flattr** as a whole project in a senior interview.
> Eight chapters, read in order at least once. Coach voice throughout.
> Every defense is grounded in real files in this repo — no fabricated claims.

flattr is a grade-aware pedestrian/scooter router. It optimizes for **flat,
not fast**. The whole project is one hand-rolled parametric search engine —
`search()` in `features/routing/astar.ts:22` — running over a build-time static
graph (`mobile/assets/graph.json`, 1,621 nodes / 1,879 edges of Seattle).
There's no backend, no database, no LLM. The interesting part isn't the
search; it's the **cost function**: cost is directional, so A→B ≠ B→A, because
uphill costs and downhill is free.

This book teaches you to own that in a room, under pressure, without bluffing.

---

## The system at a glance — the master diagram

This is the diagram you return to whenever you lose the thread. Everything in
the book hangs off this picture: a build-time half that bakes `graph.json`, and
a runtime half that loads it and routes over it with zero server in between.

```
  flattr — the whole system, build-time vs runtime

  ┌─ BUILD TIME (pipeline/, run once per area) ───────────────────────┐
  │                                                                    │
  │  Overpass API ──► parseOsm ──► splitWays ──► sampleElevations ──┐  │
  │  (OSM streets)    osm.ts       split.ts      elevation.ts       │  │
  │                                              (Open-Meteo, free) │  │
  │                                                                 ▼  │
  │                                          computeGrades ──► buildGraph
  │                                          grade.ts          build-graph.ts
  │                                                                 │  │
  └─────────────────────────────────────────────────────────────────┼──┘
                                                                      │
                              graph.json  ◄────────────────────────────┘
                              1,621 nodes / 1,879 edges  (static artifact)
                                       │  bundled into the app
                                       ▼
  ┌─ RUNTIME (mobile/, Expo + RN + MapLibre) ─────────────────────────┐
  │                                                                    │
  │  loadGraph() ──► nearestNode(tap) ──► directedAstar() ──► route    │
  │  loadGraph.ts    nearest.ts           astar.ts            line     │
  │                       │                    │                       │
  │                       │                    └─ one search() with    │
  │                       │                       (costFn, heuristicFn)│
  │                       └─ O(N) linear scan ◄── FIRST bottleneck     │
  │                                                                    │
  │  No backend. No DB. No network in the routing hot path.            │
  └────────────────────────────────────────────────────────────────────┘
```

The seam between the two halves is `graph.json`. Build-time spends an
elevation API quota to bake grades in; runtime never touches that quota again.
That split is the answer to half the questions in this book.

---

## The eight chapters

| # | Chapter | The question it defends |
|---|---------|--------------------------|
| 01 | **The pitch** | "Tell me about a project you built." 10s / 30s / 90s. |
| 02 | **The architecture** | "Walk me through the system." Trace one request. |
| 03 | **The choices** | "Why this stack?" Hand-rolled vs OSRM, Expo vs Next.js, free vs paid elevation, static vs DB. |
| 04 | **The scale story** | "What breaks first at 10x?" Graph size, elevation quota, per-query work — *not* users. |
| 05 | **The failure story** | "What happens when things go wrong?" Elevation 429, steep-vs-disconnected, the unvalidated graph load. |
| 06 | **The hard parts** | Hardest bug, proudest part, least-confident defense. |
| 07 | **The counterfactuals** | "What would you do differently?" Validate on load, ElevationProvider seam, design the data seam up front. |
| 08 | **The AI question** | "Did you use AI to build this?" Three modes of decision-making, never bluff code. |

---

## How to use this book

```
  FIRST READ          one chapter per sitting, in order, front to back.
                      The chapters build: 02 sets the architecture that
                      04 and 05 stress-test.

  REVIEW              skim the chapter-opening diagrams and the pull
                      quotes (┃-marked). ~70% of the book is in the
                      visual treatments alone.

  NIGHT BEFORE        read only the one-page summary at the end of each
                      chapter. Eight pages total. That's your warm-up.
```

The six recurring treatments, so your eye learns them:

- **Chapter-opening diagram** — the spine of the chapter, 15-30 lines.
- **`THEY ASK` / `WHAT THEY'RE TESTING` callout** (single border) — before every question.
- **Weak / strong side-by-side** — the contrast does the teaching.
- **`WHEN YOU DON'T KNOW` box** (double border ╔╗) — at least one per chapter, leaning into the distributed-systems gap.
- **Follow-up decision tree** — where the conversation goes next.
- **Pull quotes** (┃ or ▸) — the lines you carry into the room.

---

## Where this book sits in your study system

This is the **project-level** defense — the wide opener, the "walk me through
your app" moment. It pairs with the deep-dive concept files already generated
under `.aipe/`:

- **Drill into the algorithm** (admissibility, lazy deletion, bidirectional
  consistency) → `.aipe/study-dsa-foundations/`
- **Drill into the system shape** (build/runtime split, no-backend, failure
  surfaces) → `.aipe/study-system-design/`

When an interviewer drills past the project level into *one* decision, that's
where the per-concept Interview-defense blocks live. This book gets you to the
drill confidently; those files get you through it.

---

## The one thing to remember walking in

Most candidates over-claim scale and under-own decisions. You do the reverse.
You scoped this deliberately: no server, no DB, no LLM, hand-rolled engine.
Every one of those is a *decision you can defend*, not a gap you have to hide.

```
        ▸ You didn't build a smaller Google Maps.
          You built the one part of Google Maps that's
          interesting — the cost function — and you
          can reason about it from the invariant up.
```
