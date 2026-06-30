# Chapter 4 — The Scale Story

"What breaks first at 10x?" is the systems-thinking question, and for flattr
it has a twist most candidates miss: **flattr doesn't scale on users.** There
is no server. A million people running the app is a million independent
on-device computations that never touch each other. So the usual "10x users"
framing doesn't apply — and saying that, clearly, is itself the strong
answer.

The axes that *do* scale flattr are three: how big the graph gets, how much
elevation quota the build burns, and how much work each query does. This
chapter walks each, names the first bottleneck and the second, and — most
importantly — names how you'd *measure* to know. Forward-looking systems
thinking is the whole point here, and you have a real first bottleneck to
point at: `nearestNode` is O(N).

---

## The scale-bottleneck chart

This is the chapter's spine. Three axes that actually scale flattr, the
first thing that breaks on each, and what you'd reach for. Note that "users"
is deliberately crossed out — that's the insight.

```
  flattr scale — the axes that matter (and the one that doesn't)

  ┌───────────────────────────────────────────────────────────────┐
  │  ✗ USERS  ─────────────────────────────────────────────────   │
  │     No server. Each app routes on-device, in isolation.        │
  │     10x users = 10x independent computations. Nothing shared,  │
  │     nothing contended. This axis does not bottleneck.          │
  └───────────────────────────────────────────────────────────────┘

  AXIS 1 — GRAPH SIZE (N nodes, E edges)
    now: 1621 nodes / 1879 edges (one Seattle slice)
    10x → 16k nodes      first break:  nearestNode O(N) linear scan
    100x → 160k nodes    second break: graph.json bundle size / memory
    fix order: k-d tree for nearest  →  on-demand tile loading (already
               partially built: useTileGraph)

  AXIS 2 — ELEVATION QUOTA (build time only)
    now: free Open-Meteo, retries on 429
    bigger graph → more elevation calls → 429s sooner
    first break:  build throttled, degrades to flat-fallback
    fix: paid provider behind a seam, or cache elevation by tile

  AXIS 3 — PER-QUERY WORK (one route)
    now: A* over ~1600 nodes, sub-millisecond
    bigger graph / longer routes → more nodes expanded
    first break:  A* expansion cost grows with search radius
    fix: bidirectional search (built, bidirectional.ts) → contraction
         hierarchies if it ever reached continental scale
```

The first sentence of your scale answer should be the crossed-out box: "the
interesting thing is flattr doesn't scale on users — there's no server."
That reframe shows you understand your own architecture.

---

## The framing question — "what breaks first at 10x?"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What breaks first if this got 10x bigger?"            │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Do you know where YOUR system's pressure points are,   │
│   specifically — or do you reach for generic answers     │
│   (add caching, add a load balancer) that don't apply?   │
│   Can you name the FIRST bottleneck, not just a list?    │
│   And do you know how you'd measure to confirm it?       │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice — lead with the reframe:

> "The first thing I'd say is flattr doesn't scale on users, which is the
> usual axis. There's no server — every app routes on-device over its own
> copy of the graph, so a million users is a million isolated computations.
> Nothing's shared, so nothing contends. That axis just doesn't bottleneck.
>
> What scales is the graph. Right now it's about 1600 nodes for one Seattle
> slice. If I grew that 10x, the first thing to break is `nearestNode` — when
> you tap the map, I snap your tap to the closest graph node by scanning
> *every* node and computing haversine distance. That's O(N), a linear scan,
> in nearest.ts:5. At 1600 nodes it's free. At 160,000 it's a real cost on
> every tap. So the first optimization is a spatial index — a k-d tree — to
> make nearest-node O(log N) instead of O(N).
>
> The second bottleneck, further out, is the bundle itself: `graph.json` ships
> with the app and loads into memory, so a city-scale graph is a download-size
> and memory problem. I've already started on that — `useTileGraph` loads
> graph tiles on demand and merges them, so the whole city doesn't have to be
> resident at once.
>
> How I'd know: I'd measure nearest-node time and route time per query as N
> grows. I don't have to guess which breaks first — I instrument it and
> watch the linear scan's slope versus the A* expansion's slope."

The k-d tree as "the first bottleneck" is the load-bearing claim. It's
specific, it's real (nearest.ts:5 is genuinely O(N)), and it shows you can
identify *the* pressure point rather than reciting a menu.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'd add caching and    │ "It doesn't scale on    │
│ probably a load balancer │ users — there's no      │
│ and maybe shard the      │ server. It scales on    │
│ database to handle more  │ graph size. First break │
│ traffic."                │ is nearestNode: it's an │
│                          │ O(N) scan over every    │
│                          │ node, nearest.ts:5. Fix │
│                          │ is a k-d tree. I'd       │
│                          │ measure nearest-node     │
│                          │ time as N grows to       │
│                          │ confirm."                │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Generic. There's no DB   │ Reframes off the wrong  │
│ and no traffic to load-  │ axis, names the FIRST   │
│ balance — none of it     │ bottleneck with a       │
│ applies. It proves you   │ file:line, gives the    │
│ have buzzwords, not that │ fix, and says how to    │
│ you understand THIS      │ measure. Specific to    │
│ system.                  │ THIS system.            │
└─────────────────────────┴─────────────────────────┘
```

The weak answer is the trap this whole chapter exists to defuse. It's not
wrong in the abstract — caching and load balancers are real tools. It's wrong
*here*, because flattr has no database and no shared traffic. Reaching for
generic scale answers on a system they don't fit is the surest sign you don't
understand your own architecture.

```
┃ "flattr doesn't scale on users. It scales on graph size.
┃  If you don't know that, you don't know the architecture."
```

---

## The bottleneck order — what you add, when

When the interviewer drills in, walk the sequence. The order matters more
than the list — it shows you'd fix the *binding* constraint first.

```
  Graph grows.  Which optimization, in what order?
        │
        ▼
  1. nearestNode O(N) → k-d tree O(log N)
        │   the FIRST thing that hurts: it runs on every tap
        ▼
  2. graph.json memory/bundle → on-demand tiles (useTileGraph, started)
        │   load only the corridor between start and end, not the city
        ▼
  3. A* expansion cost on long routes → bidirectional search
        │   already built (bidirectional.ts) — meet in the middle,
        │   expand far fewer nodes
        ▼
  4. continental scale (hypothetical) → contraction hierarchies
            the OSRM move — precomputed shortcuts. I haven't built
            this; it's where I'd READ before I claimed a design.
```

Two of these four are already partially built — `useTileGraph` for tiling and
`bidirectional.ts` for the meet-in-the-middle search. Point at them. "I've
already started on bottleneck 2 and 3" is a much stronger sentence than "I'd
add these someday."

---

## How you'd measure — the part most candidates skip

The question isn't really "what breaks" — it's "how would you *know* what
breaks." Have the measurement answer ready.

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "How would you know the nearest-node scan is the       │
│    bottleneck and not the A* search?"                    │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Do you optimize by guessing, or by measuring? A junior │
│   engineer optimizes what feels slow. A senior one       │
│   profiles, finds the real hot spot, and fixes THAT.     │
└─────────────────────────────────────────────────────────┘
```

> "I wouldn't guess — I'd instrument. flattr already has a benchmark harness
> under `bench/` that records search metrics: nodes expanded, heap pushes,
> pops, per algorithm stage. My `SearchResult` type carries
> `nodesExpanded`, `pushes`, `pops` (types.ts:46) precisely so I can compare
> stages — Dijkstra vs A* vs directional vs bidirectional — on the same
> query. To answer the nearest-node-vs-A* question, I'd time each
> independently as N grows and watch the slopes. The linear scan grows with
> N; A* with haversine pruning grows much slower. The one whose curve bends
> up first is the binding constraint, and I'd fix that one."

The fact that `SearchResult` already carries instrumentation fields is your
proof you think this way — you built the measurement in from the start.

---

## When the scale question goes past your depth

The scale conversation is the single most likely place to get pulled into
your real gap: distributed serving.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They push: "Forget on-device. You're serving routing for    ║
║   every city in the US from a backend. How do you scale the    ║
║   graph storage and the query layer?"                         ║
║                                                               ║
║   This is the horizontal-scale distributed-systems question,  ║
║   and it's the honest center of your gap. You've shipped five  ║
║   system shapes, but none of them is horizontal scale under    ║
║   sustained load, multi-region replication, or hot-path queue  ║
║   infrastructure. Do not fake it.                             ║
║                                                               ║
║   Say:                                                        ║
║   "This is the part I'd flag as outside what I've built. I     ║
║    can reason about it: routing requests are stateless, so     ║
║    the query layer scales horizontally by adding instances.    ║
║    The hard part is the graph — a US-wide road graph is too    ║
║    big for one instance's memory, and it doesn't shard         ║
║    cleanly because routes cross any regional boundary you      ║
║    draw. I know that's where the real engineering is —         ║
║    partitioning a graph that doesn't partition, and handling   ║
║    cross-partition queries. I haven't solved that in           ║
║    production. If this were the job, that's the first thing    ║
║    I'd go deep on, and I'd start by reading how OSRM and the   ║
║    real routing engines handle it rather than inventing a      ║
║    scheme on a whiteboard."                                   ║
║                                                               ║
║   What this signals: you can reason to the EDGE of your        ║
║   knowledge precisely (stateless query layer = easy; graph     ║
║   partitioning = the real problem), you name the gap without   ║
║   flinching, and you have a concrete plan to close it. An       ║
║   interviewer trusts that far more than a confident-but-wrong  ║
║   sharding scheme.                                            ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "I'd shard by city and replicate across regions with        ║
║    eventual consistency." — every clause of that invites a     ║
║   follow-up you can't survive (what about routes between       ║
║   cities? what consistency model? why eventual?). Confidence   ║
║   you can't back is worse than honesty you can.               ║
╚═══════════════════════════════════════════════════════════════╝
```

For the systems-level treatment of scale, boundaries, and where state lives,
point yourself at **`.aipe/study-system-design/`**.

```
┃ "I'd measure, not guess. The SearchResult type carries
┃  nodesExpanded, pushes, and pops because I built the
┃  instrumentation in from day one."
```

---

## What you'd change

The one scale decision I'd revisit now, before being forced to, is
`nearestNode` staying O(N). It's correct and it's fine at 1600 nodes, but it's
the first thing that bends under growth, and a k-d tree is a well-understood
swap. I'd build it before the graph grew, not after the taps got slow —
because the spatial index is the kind of thing that's cheap to add early and
annoying to retrofit once the call sites multiply.

---

## One-page summary — read this the night before

**Core claim:** flattr doesn't scale on users — there's no server. It scales
on graph size, elevation quota, and per-query work. Lead with the reframe,
then name the first bottleneck (O(N) nearest-node) with a fix and a
measurement.

**Questions covered:**
- *"What breaks first at 10x?"* → not users. Graph size. First break:
  `nearestNode` O(N) scan (nearest.ts:5) → k-d tree.
- *"What's the bottleneck order?"* → nearest-node index → on-demand tiles
  (started) → bidirectional search (built) → contraction hierarchies (not
  built).
- *"How would you know?"* → instrument. `SearchResult` already carries
  `nodesExpanded`/`pushes`/`pops` (types.ts:46); the `bench/` harness records
  them. Measure slopes as N grows.
- *"Serve it for every US city"* → stateless query layer scales easily; graph
  partitioning is the real problem, and it's outside what I've shipped.

**Pull quotes:**
- "flattr doesn't scale on users. It scales on graph size."
- "I'd measure, not guess — the instrumentation was built in from day one."

**What you'd change:** Build the k-d tree for nearest-node before the graph
grows, not after the taps get slow.
