# Chapter 1 — The pitch

In the first ten minutes of every interview, someone says "tell me about a
project you built." This is the question you cannot afford to ramble through —
it sets the frame for everything after. If you fumble the pitch, the
interviewer spends the rest of the loop deciding whether you actually
understand your own code. If you nail it, they spend it exploring with you.

This chapter gives you the pitch at three lengths — 10 seconds, 30 seconds, 90
seconds — and the one hook that makes flattr memorable: **directional cost.**
The discipline here is compression. Most candidates know too much about their
project and dump all of it. You're going to say less, on purpose, and lead with
the one thing nobody expects.

---

## The chapter-opening diagram — flattr at a glance

Here is the whole project on one card: what it does, what's in it, the numbers,
and the hook. If you can redraw this from memory, you can pitch flattr at any
length.

```
  flattr — "optimized for flat, not fast"

  ┌──────────────────────────────────────────────────────────────┐
  │  WHAT          grade-aware router for pedestrians / scooters   │
  │                one knob: userMax = max comfortable uphill %    │
  ├──────────────────────────────────────────────────────────────┤
  │  THE HOOK      cost is DIRECTIONAL — A→B ≠ B→A                 │
  │                uphill is penalized, downhill is free           │
  │                gradeCostDirected, cost.ts:32                   │
  ├──────────────────────────────────────────────────────────────┤
  │  THE ENGINE    ONE hand-rolled search() — no OSRM/Valhalla     │
  │                Dijkstra → A* → grade → directed, all the same  │
  │                function with different (costFn, heuristicFn)   │
  │                astar.ts:22                                      │
  ├──────────────────────────────────────────────────────────────┤
  │  THE DATA      static graph.json, baked at build time          │
  │                1,621 nodes / 1,879 edges  (Seattle)            │
  │                no backend · no database · no LLM               │
  ├──────────────────────────────────────────────────────────────┤
  │  THE SHELL     Expo ~56 / RN 0.85 / React 19 / MapLibre 11    │
  │                tap two points → one search() → colored route   │
  └──────────────────────────────────────────────────────────────┘
```

Everything you say about flattr is a zoom into one row of that card. The pitch
is just choosing how many rows you have time for.

---

## The 90-second answer — "tell me about a project you built"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Tell me about a project you built."                            │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Can you compress? Do you lead with what's interesting, or       │
│   bury it under setup? Do you know what the hard part of your     │
│   own project actually is — or do you think the hard part was     │
│   "wiring up the map"? The pitch is a proxy for judgment.         │
└─────────────────────────────────────────────────────────────────┘
```

Here's the 90-second version, in your voice. Read it aloud — it should sound
like you talking, not a paragraph you memorized.

> "flattr is a routing app for people who travel under their own power —
> walking, scooters, wheelchairs — where the thing you care about isn't the
> fastest route, it's the *flattest* one. You give it one number: the steepest
> uphill grade you're comfortable with. It finds you a route that respects
> that.
>
> The interesting part is the cost function. In a normal router, the cost of an
> edge is the same in both directions — distance is distance. In flattr, cost is
> *directional*: going uphill is penalized, going downhill is free. So the cost
> from A to B is not the cost from B to A. That one change means I'm searching a
> directed graph where the weights depend on travel direction.
>
> Under the hood it's one hand-rolled search function. I deliberately didn't use
> OSRM or Valhalla, because then the project would just be tuning someone else's
> cost weights. I wrote the priority queue, the graph, and the A* myself, and I
> built it as a progression — plain Dijkstra first, then A* with a heuristic,
> then the grade cost, then the directional cost — all the *same* function, just
> swapping in different cost and heuristic arguments.
>
> There's no backend. The street graph is baked into a static file at build time
> — that's where I spend the elevation-API budget — and at runtime the app just
> loads it and routes locally. So routing has no network in the hot path at
> all."

That's it. You named the what, the hook, the engineering decision, and the
architecture — in four short beats. Notice what you *didn't* say: nothing about
MapLibre, nothing about the address-bar autocomplete, nothing about Expo
versions. Those are rows you skip unless asked.

```
┃ "Cost is directional: uphill is penalized, downhill is
┃  free. The cost from A to B is not the cost from B to A."
```

That single sentence is your hook. It's concrete, it's slightly surprising, and
it tells the interviewer you understand graphs at a level beyond "I called a
routing library." Lead with it every time you have more than 10 seconds.

### The 30-second hallway version

> "I built flattr — a router that optimizes for flat routes instead of fast
> ones, for walking and scooters. You set your max comfortable uphill grade and
> it routes around the steep stuff. The fun part is the cost is directional —
> uphill costs, downhill is free — so A-to-B isn't the same as B-to-A. It's a
> hand-rolled A* over a graph I bake at build time. No backend."

### The 10-second elevator version

> "A walking router that optimizes for *flat*, not fast. Hand-rolled A* with a
> directional grade cost — uphill costs, downhill's free."

---

## Weak vs strong — the same 90 seconds, two ways

The failure mode here is real and common: candidates pitch the *framework* and
the *features* instead of the *idea* and the *hard part*. Here's the contrast.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK PITCH                    │ STRONG PITCH                  │
├──────────────────────────────┼──────────────────────────────┤
│ "It's a React Native app      │ "It's a router that optimizes │
│ with MapLibre. You type in    │ for flat instead of fast. The │
│ two addresses and it draws a  │ cost function is directional — │
│ route on the map. I used      │ uphill costs, downhill's free, │
│ Expo for the build and there's│ so A→B ≠ B→A. Hand-rolled A*  │
│ a slider for the grade and an │ over a graph I bake at build   │
│ autocomplete search bar. It   │ time. No backend in the        │
│ also has a heatmap of the     │ routing path."                 │
│ street grades."               │                                │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:                │ Why it works:                  │
│ Leads with the framework and  │ Leads with the idea and the    │
│ a feature tour. Nothing here  │ one genuinely interesting      │
│ separates it from a tutorial. │ technical decision. The        │
│ The interviewer learns you    │ interviewer immediately has a  │
│ can wire a map — not that you │ thread to pull ("wait, why is  │
│ understand a graph. The hook  │ A→B different from B→A?") and  │
│ (directional cost) is missing │ you've signaled graph depth in │
│ entirely.                     │ one sentence.                  │
└──────────────────────────────┴──────────────────────────────┘
```

The strong version is *shorter* and says *more*. That's the whole skill.

```
        ▸ Pitch the idea and the hard part. The
          framework is the least interesting true
          thing you can say about your project.
```

---

## Where the pitch conversation goes next

Your hook is bait — on purpose. Here's what the interviewer asks after the
directional-cost line, and where you steer each branch.

```
  You drop the "A→B ≠ B→A" hook.
        │
        ├─► IF THEY ASK "why is it directional?"
        │     "Because uphill effort and downhill effort
        │      aren't the same. directedGrade flips the
        │      sign by travel direction (graph.ts:17), and
        │      the penalty only applies to positive grade
        │      (cost.ts:16). Going down a hill is free."
        │     → leads into Chapter 3 (the choices) and the
        │       cost model.
        │
        ├─► IF THEY ASK "did you use a routing library?"
        │     "No, deliberately. One hand-rolled search().
        │      If I'd used OSRM this project would be config,
        │      not graph work." → Chapter 3.
        │
        └─► IF THEY ASK "walk me through the architecture"
              You're now in Chapter 2 territory. Draw the
              build-time / runtime split, trace one tap.
```

You want every one of these. Each pulls you toward content you can defend
deeply. That's why the hook leads.

---

## When they push on scale — the first "I don't know" box

The pitch invites one trap immediately: the interviewer hears "router" and
reaches for the Google-Maps comparison. Don't take that bait — name the gap
before they make it a weakness.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They hear "router" and ask: "So how would this handle       ║
║   millions of users? Live traffic? Distributed serving?"      ║
║                                                               ║
║   You have NOT built distributed systems at horizontal        ║
║   scale. Don't improvise a sharding story you can't defend.   ║
║                                                               ║
║   Say:                                                         ║
║   "I scoped this to be a graph-algorithms project, not a       ║
║    scale project. There's no server — routing runs            ║
║    on-device over a static graph. The DSA depth is real:      ║
║    the cost model, the admissible heuristic, the              ║
║    progression. The distributed-serving side — sharding the   ║
║    graph, live traffic, load balancing under sustained        ║
║    traffic — I haven't built, and I'd be guessing if I        ║
║    sketched it. Happy to reason through it with you, but I'd   ║
║    flag that it's outside what I've shipped."                  ║
║                                                               ║
║   What this signals: you know exactly where your project's    ║
║   edge is. Naming the gap first reads as senior. The spec     ║
║   itself says this (flattr-spec.md §15.1): name the gap        ║
║   before a reviewer does.                                      ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "Oh I'd just add a load balancer and shard by region        ║
║    and cache the hot routes in Redis..." — a hand-wave        ║
║    through territory you haven't built collapses on the        ║
║    first real follow-up. Chapter 4 makes the scale axes you   ║
║    CAN defend explicit.                                        ║
╚═══════════════════════════════════════════════════════════════╝
```

```
┃ "I scoped this to be a graph-algorithms project,
┃  not a scale project." — say this before they decide
┃  the scale gap is a weakness.
```

---

## What you'd change about the pitch

If I were re-pitching flattr today, I'd add one quantified line to the 90-second
version: the benchmark result. "A* expands roughly 4x fewer nodes than Dijkstra
for the same path" (from `bench/run.ts`) turns the progression from a claim into
a measured fact, and measured facts are what senior interviewers remember. The
pitch as written is solid; adding one number would make it stick.

---

## One-page summary — Chapter 1

**Core claim:** Lead with the idea and the hook (directional cost), not the
framework. Compression is the skill being tested.

**The pitch, three lengths:**
- **10s** — "A walking router optimized for flat, not fast. Hand-rolled A* with a directional grade cost — uphill costs, downhill's free."
- **30s** — add: you set max uphill grade; A→B ≠ B→A; baked at build time; no backend.
- **90s** — add: the engine is one `search()` you wrote (not OSRM); built as a progression Dijkstra→A*→grade→directed.

**Questions covered:**
- "Tell me about a project you built" → 90-second answer, hook first.
- "Why directional / did you use a library / walk me through it" → the follow-up tree.
- "How does it scale to millions?" → name the gap (no server, scoped to DSA), don't improvise distributed systems.

**Pull quotes:**
- ┃ "Cost is directional: uphill is penalized, downhill is free. A→B is not B→A."
- ▸ Pitch the idea and the hard part. The framework is the least interesting true thing.
- ┃ "I scoped this to be a graph-algorithms project, not a scale project."

**What you'd change:** Add one benchmark number to the 90-second pitch (A* ~4x fewer node expansions than Dijkstra) — turn the progression claim into a measured fact.
