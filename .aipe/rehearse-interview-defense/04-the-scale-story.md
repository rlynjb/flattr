# Chapter 4 — The scale story

"What breaks first at 10x?" is the question where most candidates either freeze
or bluff. They reach for the answer they think the interviewer wants — load
balancers, sharding, Redis — and walk straight into territory they haven't
built. You're not going to do that. flattr's scale story is unusual and *that's
the strength*: there's no server, so the scale axes aren't users. They're graph
size, elevation quota, and per-query work. This chapter teaches you to redirect
the scale conversation onto the axes you can actually defend with code.

The single most important move in this chapter: when someone says "scale,"
**clarify which axis** before you answer. flattr has no users-axis to break,
because it has no server. Saying that out loud — and then naming the axes that
*do* exist — is the senior move.

---

## The chapter-opening diagram — the real scale axes

The usual scale chart has "users" on one axis. flattr's doesn't. Here are the
three axes that actually exist, with what breaks first on each.

```
  flattr scale — three axes, NONE of them is "users"

  AXIS 1: GRAPH SIZE (N nodes)        current: 1,621 nodes
  ────────────────────────────────────────────────────────────
   1k ──── 10k ──── 100k ──── 1M nodes
    │        │         │          │
    fine   fine    nearestNode  A* working set
                   O(N) scan    grows; whole
                   hurts ◄──    graph in memory
                   1st BREAK    2nd BREAK

  AXIS 2: ELEVATION QUOTA (build time only)
  ────────────────────────────────────────────────────────────
   small area ──── city ──── metro
       │             │          │
      fine        429s from   build can't
                  Open-Meteo  finish in one
                  free tier   quota window
                  ◄── BREAK   (paid provider)

  AXIS 3: PER-QUERY WORK (runtime, per tap)
  ────────────────────────────────────────────────────────────
   nearestNode O(N)  +  A* search
        │                  │
        scan EVERY node    expands a cone
        on every tap       toward goal
        ◄── dominates as N grows; k-d tree first

  ┌────────────────────────────────────────────────────────┐
  │  THE FIRST BOTTLENECK, ranked:                          │
  │   1. nearestNode O(N) linear scan   → k-d tree          │
  │   2. whole-graph-in-memory          → spatial tiling    │
  │   3. elevation 429 at build         → paid provider     │
  │  Users are NOT on this list. There is no server.        │
  └────────────────────────────────────────────────────────┘
```

That box is the whole chapter. Three axes, ranked bottlenecks, and the explicit
absence of a users-axis.

---

## "What breaks first as this scales?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What breaks first as this scales up?"                         │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Do you know YOUR system's actual bottlenecks, or do you        │
│   recite generic ones? Can you reason about Big-O in your own    │
│   hot path? Do you measure, or guess? And — do you notice that   │
│   "scale" usually means users, and that your system doesn't      │
│   have that axis?                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Step one is the redirect. Then the ranked answer.

> "First I'd clarify what's scaling, because flattr doesn't have the usual
> users-axis — there's no server. Routing runs on-device over a static graph, so
> 'more users' just means more phones each doing their own local search. Nothing
> shared breaks.
>
> The axes that *do* scale are graph size and per-query work. So: what breaks
> first is `nearestNode` (nearest.ts). When you tap, I snap the tap to the
> closest graph node with a linear scan over every node — O(N), haversine
> distance, keep the minimum. At 1,621 nodes that's instant. At 100k or a
> million nodes, that scan runs on *every tap and every endpoint re-snap*, and
> it starts to dominate. The fix is a spatial index — a k-d tree — to make
> nearest-neighbor O(log N) instead of O(N). That's the first thing I'd add.
>
> Second bottleneck is memory. The whole graph is in memory at once. A* itself
> scales fine — it expands a cone toward the goal, not the whole graph — but
> holding a metro-scale graph resident becomes the limit. The fix is the spatial
> tiling I already have at runtime (`useTileGraph.ts`): load only the bbox
> around the route corridor, not the whole city.
>
> And I'd measure, not guess — I have a benchmark harness (`bench/run.ts`) that
> records nodes-expanded, heap push/pop counts, and wall-clock per algorithm.
> That's how I'd confirm where the time actually goes before optimizing."

```
┃ "flattr doesn't have a users-axis — there's no server.
┃  More users just means more phones doing their own
┃  local search."
```

The `nearestNode` O(N) → k-d tree answer is the centerpiece. It's specific
(real file, real complexity), it's correct, and it names the exact data
structure that fixes it. That's what "I understand my hot path" sounds like.

---

## The bottleneck, traced — why nearestNode is first

Here's the per-tap work, so you can see why the linear scan dominates before A*
does.

```
  Per-tap work — what runs on every route request

  tap coordinate
       │
       ▼
  ┌─ nearestNode(graph, point) ──────────── nearest.ts:5 ─┐
  │  for EVERY node in graph.nodes:                       │
  │     d = haversine(point, node)                        │   O(N)
  │     if d < best: best = d                             │   ← scans
  │  → runs for BOTH endpoints, re-runs as tiles load     │     all N
  └──────────────────────┬─────────────────────────────────┘
                         │ startId, endId
                         ▼
  ┌─ directedAstar(graph, startId, endId, userMax) ── astar.ts:156
  │  expands a CONE toward the goal (heuristic prunes)     │  O(E log N)
  │  does NOT touch every node — that's the whole point    │  but only
  │  of the heuristic                                      │  the cone
  └─────────────────────────────────────────────────────────┘

  As N grows, the O(N) scan that touches EVERY node beats the
  A* cone that touches only the relevant ones. So the snap,
  not the search, breaks first.
```

The non-obvious insight — and a great one to volunteer — is that the *search*
isn't the first thing to break. The heuristic already keeps A* from touching
every node. It's the *snap* that still touches every node. Naming that
ordering correctly is a strong signal.

---

## Weak vs strong — the scale answer

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                   │ STRONG ANSWER                 │
├──────────────────────────────┼──────────────────────────────┤
│ "At scale I'd add a load      │ "There's no server, so 'more  │
│ balancer and shard the data   │ users' isn't an axis. What    │
│ and probably cache hot routes │ breaks first is nearestNode — │
│ in Redis, and use a CDN for   │ an O(N) scan on every tap. At │
│ the static assets..."         │ 100k nodes I'd add a k-d tree │
│                               │ for O(log N) snapping. Then   │
│                               │ memory — I'd lean on the tile │
│                               │ loading I already have. And   │
│                               │ I'd measure with my bench     │
│                               │ harness first."               │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:                │ Why it works:                  │
│ Generic distributed-systems   │ Reasons about THIS system's    │
│ shopping list. None of it     │ actual hot path, in Big-O,     │
│ applies — there's no server   │ names the real file and the    │
│ to load-balance. Invites a    │ exact fix (k-d tree), and      │
│ follow-up that exposes the    │ leads with measurement. No     │
│ hand-wave instantly.          │ generic terms that don't fit.  │
└──────────────────────────────┴──────────────────────────────┘
```

```
        ▸ When they say "scale," clarify the axis before
          you answer. Half the wrong answers come from
          solving the wrong axis.
```

---

## Where the scale conversation goes next

```
  You named nearestNode O(N) as the first bottleneck.
        │
        ├─► IF THEY ASK "how does a k-d tree fix it?"
        │     "It partitions space so nearest-neighbor
        │      queries skip most of the tree — O(log N)
        │      average instead of O(N). I'd build it once at
        │      load over graph.nodes, query it per tap. I've
        │      built BSTs and heaps from scratch, so the tree
        │      mechanics are familiar."
        │
        ├─► IF THEY ASK "what about the elevation build?"
        │     "That's the build-time axis. Open-Meteo's free
        │      tier 429s on a big area — I've hit it. I handle
        │      it with caching + dedup by DEM cell + retry
        │      backoff (elevation.ts). At metro scale you need
        │      the paid provider to finish in one window."
        │
        ├─► IF THEY ASK "does A* itself scale?"
        │     "Better than the snap. The heuristic keeps it
        │      to a cone toward the goal — it doesn't touch
        │      every node. The benchmark shows A* expanding
        │      far fewer nodes than Dijkstra for the same
        │      path. Memory is the real A*-side limit, fixed
        │      by tiling."
        │
        └─► IF THEY ASK "what about 10x latency-sensitive
            │   requests / real-time?"
            "Each route is independent and local, so there's
             no shared contention — it parallelizes trivially
             across devices. The per-device limit is the snap
             + search, which I just covered."
```

---

## The "I don't know" box — the distributed-systems push

This chapter is exactly where an interviewer will try to drag you into
horizontal-scale distributed systems. This is your single biggest gap (`me.md`
is explicit about it). Lean into it.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "OK, say you DID make this a server — how would   ║
║   you horizontally scale the routing service? Sharding        ║
║   strategy, load balancing under sustained traffic,           ║
║   multi-region, the works."                                   ║
║                                                               ║
║   This is the gap. You have shipped five system shapes, but   ║
║   NONE of them is distributed systems at horizontal scale,    ║
║   hot-path queue infra, multi-region replication, or load     ║
║   balancing under sustained traffic. Do not fake it.          ║
║                                                               ║
║   Say:                                                         ║
║   "I'm going to be straight with you: horizontal-scale        ║
║    distributed serving is the part of system design I         ║
║    haven't built. My projects are local-first and             ║
║    single-node by design. I can reason about the shape — a    ║
║    routing service is mostly stateless per query, so it       ║
║    fans out cleanly; I'd probably shard the graph             ║
║    geographically since most routes are local; cross-shard    ║
║    routes are the hard case. But sharding strategy and load   ║
║    balancing under sustained real traffic is something I'd    ║
║    be designing for the first time, not recalling from        ║
║    something I shipped. I'd want to pair with someone who's    ║
║    operated it, or build a small version and measure."        ║
║                                                               ║
║   What this signals: you know the shape (stateless fan-out,   ║
║   geographic sharding, cross-shard as the hard case) AND      ║
║   you're honest that you haven't operated it. That            ║
║   combination — informed, not bluffing — is a stronger        ║
║   senior signal than a confident wrong answer.                ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "Sure — consistent hashing, three replicas per shard,       ║
║    leader election with Raft..." reciting terms you can't     ║
║   defend on the second follow-up. The interviewer WILL ask    ║
║   the second follow-up.                                        ║
╚═══════════════════════════════════════════════════════════════╝
```

Deeper on horizontal scale, sharding, and the patterns you'd study to close
this gap → `.aipe/study-distributed-systems/` and
`.aipe/study-system-design/`. The k-d tree and spatial-index mechanics →
`.aipe/study-dsa-foundations/`.

```
┃ "Horizontal-scale distributed serving is the part of
┃  system design I haven't built. I can reason about the
┃  shape; I can't claim I've operated it."
```

---

## What you'd change for scale

The one concrete thing I'd add before any scale push is the k-d tree for
`nearestNode`. It's the first real bottleneck, it's a self-contained change
(build once at load, query per tap), and I've already built the tree primitives
it needs. Everything else on the scale path — tiling, paid elevation — is either
already partly there or a build-time concern. The honest bigger picture: flattr
is built to be single-node and local, so the "real" scale story (distributed
serving) is a *different project*, and I'd say that rather than pretend this one
grows into it.

---

## One-page summary — Chapter 4

**Core claim:** flattr's scale axes are graph size, elevation quota, and
per-query work — *not* users, because there's no server. Clarify the axis before
answering.

**The ranked bottlenecks:**
1. `nearestNode` O(N) linear scan (nearest.ts) — runs every tap → **k-d tree** for O(log N).
2. Whole graph in memory — A* itself is fine (cone, not flood) → **spatial tiling** (already in `useTileGraph.ts`).
3. Elevation 429 at build time — Open-Meteo free-tier → **paid provider** at metro scale.

**Key insight:** the *snap* breaks before the *search*, because the heuristic already keeps A* off most nodes.

**Questions covered:**
- "What breaks first?" → redirect to axes; nearestNode O(N) → k-d tree.
- "Does A* scale?" → yes, cone not flood; memory is the A*-side limit.
- "Horizontal scale / sharding?" → name the gap; reason about shape; don't bluff distributed systems.

**Pull quotes:**
- ┃ "flattr doesn't have a users-axis — there's no server."
- ▸ When they say "scale," clarify the axis before you answer.
- ┃ "Distributed serving is the part of system design I haven't built."

**What you'd change:** Add the k-d tree for `nearestNode` — first real bottleneck, self-contained, and you already have the tree primitives. And say plainly that distributed scale is a different project, not a growth path for this one.
