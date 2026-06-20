# Chapter 4 — The scale story

This chapter is where a distributed-systems interviewer will try to find your ceiling, and you need to be honest about where it is. flattr is a client-side app with no server, so the usual scale story — more users, more QPS, more replicas — *doesn't directly apply*, and pretending it does is the fastest way to get caught. The senior move here is to redirect to the scale axes that are actually real for this system: the **graph size**, the **elevation API quota**, and the **per-query work on the device**. Name those, walk the bottlenecks in order, and when they push into multi-region-load-balancer territory, own that it's outside what this system — and your portfolio — has done.

The thing to internalize before this chapter: "what breaks first" is a sequence, not a single answer. For each scale axis, there's a first bottleneck, then a second one that the fix for the first exposes. Walking that sequence is the skill.

```
  SCALE AXES FOR A CLIENT-SIDE ROUTER — what breaks, in order

  AXIS 1: GRAPH SIZE  (neighborhood → city → region)
    now: ~1621 nodes, in-memory, fine
     │ 10x  ── nearestNode O(N) linear scan starts to bite
     │ 100x ── whole graph in memory + search latency on JS thread
     ▼ fix order: k-d tree for snapping → off-thread search →
                  tiling + don't hold the whole graph at once

  AXIS 2: ELEVATION API QUOTA  (the real production wall)
    now: free Open-Meteo, dedup + cache
     │ more area ── 429 throttling (already hit this in testing)
     ▼ fix order: persistent cache (done) → paid provider →
                  precompute elevation at build time for whole cities

  AXIS 3: PER-QUERY WORK  (latency-sensitive: live reroute)
    now: search in a useMemo, single-digit ms, debounced
     │ bigger graph ── search blocks the render thread
     ▼ fix order: bidirectional A* (built) → contraction
                  hierarchies (preprocess) → worker thread

  AXIS 4: CONCURRENT USERS  ◄── DOESN'T APPLY. No server.
    "this is an offline client; there's nothing to load-balance."
```

That fourth row is the most important line in the chapter. Say it out loud: flattr has no concurrency axis because it has no server. Don't invent one.

## "What breaks first as the graph grows to a whole city?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Right now it's a neighborhood. What breaks      │
│    when you scale to a city or a region?"          │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Can you find the FIRST bottleneck specifically, │
│   and the second one behind it? Or do you just    │
│   say 'I'd add caching'?                           │
└─────────────────────────────────────────────────┘

> "The first thing that breaks is node snapping. `nearestNode` is a linear O(N) scan over every node to find the closest one to a coordinate — fine at 1600 nodes, a real cost at a million. So the first fix is a spatial index, a k-d tree, to make snapping O(log N). The second bottleneck the fix exposes is the search itself and memory: holding a whole city's graph in memory and running A\* on the render thread starts to show up as latency. That's where two things I already have help — bidirectional A\* cuts the explored area, and the tiling system means I don't have to hold the entire region at once. Past that, the real answer is contraction hierarchies — a preprocessing layer that adds shortcut edges so query-time search skips most of the graph. That's the documented stretch goal, not built."

The structure is the win: first bottleneck (snapping → k-d tree), second bottleneck (search/memory → bidirectional + tiling), then the real scale tool (CH). You named the sequence and which pieces already exist.

┃ "What breaks first is node snapping — `nearestNode` is an O(N) scan. The fix is a k-d tree."

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "I'd add caching and optimize the algorithm, and maybe shard the graph if needed." | "First bottleneck is `nearestNode`'s O(N) scan — fix with a k-d tree. Second is search latency and memory on a big graph — bidirectional A\* and tiling help, then contraction hierarchies as the real preprocessing answer." |
| **Why it's weak:** "add caching and optimize" is what people say when they haven't located the actual bottleneck. Caching doesn't help a cold shortest-path query. | **Why it works:** names a *specific* first bottleneck with a *specific* fix, then the second one the fix reveals. Shows you can profile in your head. |

## "How do you measure to know what to fix?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "How would you know which bottleneck to attack?"│
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you measure or guess? Senior engineers       │
│   instrument before optimizing.                   │
└─────────────────────────────────────────────────┘

> "I already have the instrumentation for the search itself — the bench harness counts nodes expanded, heap pushes, and pops per query, and I compare A\* against Dijkstra on fixed node pairs. That's how I know A\* expands roughly four to six times fewer nodes than Dijkstra here, not a guess. So for the search axis I'd extend that — measure expansions and wall-time as the graph grows, and watch the ratio of heap pops to nodes expanded, which tells me when lazy-deletion staleness starts to hurt and decrease-key becomes worth it. For snapping and memory I'd add timing around `nearestNode` and the graph load. The principle is: the bench is the source of truth, not my intuition."

This answer is strong because the measurement already exists in your repo (`bench/run.ts`). You're not promising to measure — you already do.

```
  IF THEY PUSH ON MEASUREMENT

  "I'd extend the existing bench harness."
        │
        ├─► "What does the bench measure today?"
        │     "nodesExpanded, pushes, pops per stage, over fixed
        │      interior node pairs — so A* vs Dijkstra is a real
        │      table, not a claim."
        │
        ├─► "When would decrease-key beat lazy deletion?"
        │     "When pops ≫ nodesExpanded — that ratio is the
        │      staleness overhead. I'd port the decrease-key PQueue
        │      I already built in reincodes only when the bench says so."
        │
        └─► "How do you measure on-device, not just in the bench?"
              "Honestly, I haven't — the on-device timing is the gap.
               I'd add timing spans around the search and graph load."
```

## "Could you serve this for a whole city, many users at once?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "How would you run this as a service for        │
│    thousands of concurrent users?"                │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   This is the trap. They want to see if you'll    │
│   fake distributed-systems experience or own the  │
│   boundary of what you've built.                  │
└─────────────────────────────────────────────────┘

This is the one to *not* bluff. flattr is offline-client by design; you have no server-scale war stories, and `me.md` is honest that horizontal-scale distributed systems is the gap in your portfolio. Redirect to what you can defend.

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They push into multi-region, load balancing      ║
║   under sustained traffic, hot-path queues,        ║
║   replica consistency. This is genuinely outside   ║
║   what flattr is and what you've built.           ║
║                                                   ║
║   Say:                                            ║
║   "flattr is an offline client — there's no        ║
║    server to scale, so I want to be straight that  ║
║    I haven't run this as a multi-user service.     ║
║    If I had to, the shape I'd reach for is:        ║
║    precompute the graph and elevation per city at  ║
║    build time, serve the routing as a stateless    ║
║    function so it scales horizontally behind a     ║
║    load balancer, and the heavy work — contraction ║
║    hierarchies — happens offline, not per request. ║
║    But running that under real sustained traffic   ║
║    is the part I haven't done, and I'd be learning ║
║    the failure modes on the job."                  ║
║                                                   ║
║   What this signals: you can reason about the      ║
║   shape, you're honest about the experience gap,   ║
║   and you don't fake scars you don't have.        ║
║                                                   ║
║   Do NOT say:                                      ║
║   "I'd just put it behind Kubernetes with          ║
║    auto-scaling and Redis…" — buzzword stacking    ║
║   over a system you've never operated is the       ║
║   clearest tell of faked seniority.               ║
╚═══════════════════════════════════════════════════╝

▸ The strongest scale answer for a client-side app is naming the axis that doesn't apply — "there's no concurrency axis, there's no server" — instead of inventing one.

## What you'd change

The scaling decision I'd revisit earliest is the O(N) `nearestNode` scan, because it's the cheapest fix with the highest ceiling — a k-d tree turns the first bottleneck into a non-issue and it's a self-contained change that doesn't touch the search at all. I deliberately left it linear because at 1621 nodes it's invisible, and a spatial index I don't need is just complexity — but I'd want it in before the graph crossed even a few tens of thousands of nodes. The broader thing I'd change in how I *think* about scale here: I treated "scale" as a someday concern because there's no server, but the elevation quota wall is a *today* concern that already bit me. The real first scale problem wasn't users — it was a free API's rate limit, and I should have planned the persistent cache before I hit the 429s, not after.

## One-page summary

**Core claim:** flattr's scale axes are graph size, elevation quota, and per-query work — not users, because there's no server. Walk each as a sequence of bottlenecks, and own that horizontal multi-user scale is outside what you've built.

- **Graph to a city:** first bottleneck is `nearestNode` O(N) → k-d tree; second is search latency/memory → bidirectional A\* + tiling; then contraction hierarchies as the real preprocessing answer.
- **How to measure:** the bench already counts expansions/pushes/pops and proves A\* beats Dijkstra; extend it, watch pops≫expanded for the decrease-key trigger.
- **Many concurrent users:** doesn't apply — it's an offline client. If forced: precompute per city, stateless routing function, CH offline. Honest that operating it under traffic is the gap.
- **The real today-scale wall:** the free elevation API's rate limit, which already bit during testing.

┃ "There's no concurrency axis, because there's no server."
┃ "First bottleneck is node snapping — and I can prove A\* beats Dijkstra, I don't guess it."

**What you'd change:** Add the k-d tree before the graph grows (cheapest fix, highest ceiling), and plan the elevation cache *before* hitting rate limits — the first real scale problem was a free API's quota, not users.
