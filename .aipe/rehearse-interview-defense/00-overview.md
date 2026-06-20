# Interview Defense — flattr

This is the book you read to defend **flattr** in a senior-engineering interview. Not the concept files — those teach you the patterns one at a time, slowly, so you understand them. This is the other half: turning that understanding into speech, under pressure, when an interviewer says "walk me through what you built" and then keeps pushing.

flattr is a grade-aware pedestrian/scooter router: a hand-rolled A\* engine over an elevation-annotated street graph, wrapped in an Expo/React Native map app, optimized for *flat* instead of *fast*. Everything keys off one knob — `userMax`, the steepest uphill you'll tolerate. That's the whole pitch, and the rest of this book is how you hold it together when someone leans on it.

Here's the thing you have going for you: you didn't build a CRUD app with a database behind it. You built a real graph search engine — a lazy-deletion binary heap, an admissible-heuristic A\* proven optimal against a Dijkstra oracle, a directional cost model where A→B ≠ B→A. That is a *strong* interview project, and it sits right on top of your reincodes DSA portfolio (Graph, BinaryHeap, PriorityQueue with decrease-key). The graph work is the point. Lead with it.

## The system at a glance

This is the master diagram. Every chapter is a zoom into one part of it; come back here when you need to re-anchor.

```
  flattr — the whole system in one frame

  ┌─ BUILD TIME (offline, your machine) ───────────────────────────┐
  │  OSM via Overpass ─► split/densify ─► Open-Meteo elevation      │
  │       (overpass.ts)     (split.ts)        (elevation.ts)        │
  │                                │                                │
  │                                ▼  grade per segment (grade.ts)  │
  │                       build-graph.ts ─► graph.json  (~1621 nodes)│
  └────────────────────────────────┬───────────────────────────────┘
                                    │ bundled into the app
  ┌─ RUNTIME (on device, offline-capable) ──▼──────────────────────┐
  │  ENGINE (pure TS, no framework)         features/routing/       │
  │    pqueue.ts  ── lazy-deletion min-heap (the frontier)          │
  │    astar.ts   ── ONE search(): dijkstra│astar│grade│directed    │
  │    cost.ts    ── penalty(grade,userMax), BLOCKED=1e9            │
  │    graph.ts   ── directedGrade(): undirected store, directed walk│
  │    bidirectional.ts ── two frontiers, balanced potential       │
  │                                │                                │
  │  UI (Expo RN + MapLibre)       ▼        mobile/src/             │
  │    MapScreen ─ useTileGraph ─ single-flight pump:               │
  │       viewport fetch + route corridor fetch (re-runs pipeline)  │
  │       elevation cache → AsyncStorage (persists across launches) │
  │    AddressBar (geocode+debounce) · GradeSlider · RouteSummaryCard│
  └─────────────────────────────────────────────────────────────────┘

  no live backend · no database server · graph is a read-only artifact
```

## The 8 chapters

| # | Chapter | The question it defends |
|---|---------|-------------------------|
| 01 | **The pitch** | "Tell me about a project you built." (10s / 30s / 90s) |
| 02 | **The architecture** | "Walk me through the system." |
| 03 | **The choices** | "Why hand-rolled A\*? Why Expo? Why Open-Meteo? Why no database?" |
| 04 | **The scale story** | "What breaks first as this grows?" |
| 05 | **The failure story** | "What happens when the elevation API is down?" |
| 06 | **The hard parts** | "Hardest bug? Proudest part? Weakest spot?" |
| 07 | **The counterfactuals** | "What would you do differently?" |
| 08 | **The AI question** | "Did you use AI to build this?" |

## How to read this book

- **First pass:** in order, one chapter a sitting. Chapter 2 (architecture) is the spine — if you can redraw the master diagram from memory and walk it, half the interview is won.
- **Review pass:** skim the chapter-opening diagrams, the pull quotes, and the side-by-side answer tables. That's ~70% of the book.
- **Night before:** read only the one-page summary at the end of each chapter.

## Where you'll get pushed past your depth

Be honest with yourself about this now, not in the room. flattr's scale story (Chapter 4) and failure story (Chapter 5) are where an interviewer who does distributed systems will probe — multi-region, hot-path queues, load balancing under sustained traffic. That's the gap in your portfolio (`me.md` names it), and flattr is a *client-side* app, so the honest answer is "this never had a server to scale." The single question most likely to push you over your edge is **"how would you serve this for a whole city / many concurrent users?"** — Chapter 4's "I don't know" box is built for exactly that. Don't fake server-scale war stories. Own that this is an offline client and pivot to the scale axis that *is* real here: graph size and the free-tier elevation quota.

## How this pairs with the rest of the study system

This book is the **wide opener** — the whole project at once. The **deep dives** live in the concept files: `study-dsa-foundations/05-graphs-and-traversals.md` and `03-stacks-queues-deques-and-heaps.md` for the A\*/heap drills, `study-system-design/` for the build-time/runtime split, `study-distributed-systems/` and `study-performance-engineering/` for the API-boundary and benchmark depth. When this book says "have the admissibility proof ready," that proof is drilled in `05-graphs-and-traversals.md`. Read the concept files to *understand*; read this book to *perform*.
