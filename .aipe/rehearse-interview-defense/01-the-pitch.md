# Chapter 1 — The Pitch

In the first ten minutes of every senior interview, someone asks you to
walk through a project you built. Most candidates ramble — they narrate
the repo top to bottom and lose the room before they reach the point.
This chapter is about saying what flattr *is* in ten seconds, thirty
seconds, and ninety seconds, with a hook the interviewer remembers.

The discipline here is compression. You know this project cold — that's
the problem. You'll want to say everything. Don't. Pick the one idea that
makes flattr different from every other map app, lead with it, and let the
follow-ups pull the rest out of you.

---

## The project at a glance

This is the shape you're pitching. Memorize the three layers and the one
hook — everything in the pitch hangs off this picture.

```
  flattr — "optimized for flat, not fast"

  ┌──────────────────────────────────────────────────────────────┐
  │  THE PROBLEM                                                   │
  │  Maps route you the FASTEST way. On foot or scooter, the       │
  │  fastest way is often straight up a hill you didn't want.      │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌──────────────────────────────▼──────────────────────────────┐
  │  THE IDEA                                                      │
  │  Make GRADE the cost, not distance. One knob: userMax —        │
  │  the steepest uphill you'll accept. Route around the rest.     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌──────────────────────────────▼──────────────────────────────┐
  │  THE HOOK (this is what they remember)                         │
  │                                                               │
  │     cost( A → B )   ≠   cost( B → A )                          │
  │                                                               │
  │     uphill is penalized, downhill is free. So the route        │
  │     up the hill and the route back down are DIFFERENT routes.  │
  │     A symmetric router can't express that. Mine can.           │
  └──────────────────────────────────────────────────────────────┘

  built: hand-rolled A* over a static street graph (1621 nodes,
         1879 edges, Seattle). No backend, no DB. Expo / React Native.
```

That bottom box — directional cost — is the line that separates flattr from
"I made a map app." Open with it whenever you have more than ten seconds.

---

## The three pitches

### The 10-second version (the elevator)

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What's a project you've built?" (and they're          │
│    half-listening, waiting to decide if it's interesting)│
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Can you compress? Can you make me care in one breath?  │
│   The 10-second pitch is a filter — if it lands, they    │
│   lean in and ask for more. If it rambles, they've       │
│   already moved on.                                      │
└─────────────────────────────────────────────────────────┘
```

> "flattr is a walking and scooter router that optimizes for *flat*, not
> *fast*. You set the steepest hill you'll accept, and it routes you around
> everything steeper. I hand-rolled the A* search myself."

That's it. One sentence on the what, one clause on the differentiator, one
clause that signals you wrote the hard part. Stop talking. Let them ask.

```
┃ "Optimized for flat, not fast" is the whole product
┃  in four words. Lead with it every time.
```

### The 30-second version (the hallway)

You've earned a follow-up. Now add the hook and one concrete number.

> "Maps route you the fastest way — which on foot is often straight up a
> hill. flattr makes grade the cost instead of distance. There's one knob,
> `userMax`, the steepest uphill you'll tolerate, and the router finds the
> flattest path under that limit. The interesting part is the cost is
> *directional* — uphill is penalized, downhill is free — so A-to-B and
> B-to-A are genuinely different routes. I built it on a static street
> graph of Seattle, about 1600 nodes, and the routing engine is a
> hand-rolled A* — no OSRM, no Valhalla."

### The 90-second version (the real answer)

This is the answer to "tell me about a project." Four beats: problem,
idea, the hard part, the honest boundary.

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Tell me about a project you built." (the open-ended   │
│    one, 90 seconds of rope)                              │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Three things at once: Can you structure a narrative    │
│   under no constraints? Do you know what's actually      │
│   hard in your own project? Will you volunteer the       │
│   boundary, or pretend the project does more than it     │
│   does?                                                  │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice — read it aloud, it should sound natural:

> "flattr is a grade-aware router for people on foot or on a scooter. The
> premise is that normal maps optimize for speed, and the fastest path is
> usually the steepest — it doesn't care that you're walking up a 12%
> grade. flattr inverts that: it optimizes for flatness. There's a single
> knob, `userMax`, which is the steepest uphill you're willing to take, and
> the router returns the flattest route that stays under it.
>
> Under the hood it's a graph problem. I built a street graph annotated with
> grade per edge — about 1600 nodes for a Seattle slice — and I hand-rolled
> the search. It's one parametric A* engine where the cost function is
> pluggable, so the same `search()` function does plain Dijkstra, A*,
> grade-aware, and directional, depending on which cost and heuristic I pass
> it. The part I'm proudest of is that the cost is *directional* — uphill is
> penalized, downhill is free — so the route up a hill and the route back
> down are different routes. A symmetric router structurally can't do that.
>
> The honest boundary: there's no backend and no database. The graph is
> built offline and bundled into the app as a static file, and all the
> routing runs on-device. That was deliberate for the scope, but it means
> this isn't a distributed-systems project — it's a graph-algorithm project
> with a mobile client around it. If you want, I can walk you through the
> cost function or the architecture."

Notice the move at the end: you *hand them the next question*. You name the
boundary (no backend), frame it as deliberate, and offer two directions.
That's a senior tell — you're steering, not bracing.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "It's like Google Maps  │ "Maps optimize for fast.│
│ but for walking. It      │ flattr optimizes for    │
│ uses A* and has a slider │ flat. One knob —        │
│ for hills, and I used    │ userMax — and the cost  │
│ React Native and         │ is directional, so up   │
│ MapLibre, and it shows   │ and down are different  │
│ a heatmap of grades and  │ routes. I hand-rolled   │
│ has autocomplete and..." │ the A*; no backend, by  │
│                          │ design."                │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "Like Google Maps but    │ Leads with the          │
│ for X" makes you sound    │ differentiator, not the │
│ derivative. Then it       │ category. Names the     │
│ lists features flat —     │ hook. Names the         │
│ no hierarchy, no hook.    │ boundary before being   │
│ The interviewer can't     │ asked. Every clause     │
│ tell what was HARD.       │ earns its place.        │
└─────────────────────────┴─────────────────────────┘
```

The weak answer isn't *wrong*. It's just flat — it buries the one idea that
makes the project worth discussing under a feature list, and "like Google
Maps but for X" quietly tells the interviewer you didn't do anything new.

---

## Where the pitch goes next — the follow-up tree

The pitch is bait. Know which question your hook invites, and what you say
to each branch.

```
  You deliver the 90-second pitch, hook on directional cost.
        │
        ├─► IF THEY ASK "how does the directional cost work?"
        │     → Chapter 3 territory. One sentence: directedGrade()
        │       flips the sign by travel direction (graph.ts:17);
        │       penalty() returns 0 for g <= 0 (cost.ts:16). Free
        │       downhill falls straight out of that.
        │
        ├─► IF THEY ASK "why hand-roll the router?"
        │     → Chapter 3. "Because the directional, grade-aware cost
        │       isn't a knob you can pass to OSRM. The custom cost IS
        │       the project."
        │
        ├─► IF THEY ASK "why no backend?"
        │     → Chapter 2. "The graph is small and static. A server
        │       buys me nothing at this scale and costs me a network
        │       hop. Build offline, bundle, route on-device."
        │
        └─► IF THEY ASK "walk me through the architecture"
              → Chapter 2. Draw the build-time / runtime split.
```

```
┃ The pitch isn't a summary. It's a fishing line.
┃ You pick which follow-up you want, and bait it.
```

---

## When the pitch pushes past your depth

Even a clean pitch can get you pulled somewhere thin on the very first
follow-up. Lean into the gap honestly.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   You pitch flattr. They immediately ask:                     ║
║   "Cool — how would you serve this to a million users?"       ║
║                                                               ║
║   This is the distributed-systems pull, and it's your real    ║
║   gap. You have not built horizontal scale anywhere. Do not   ║
║   improvise a load-balancer-and-sharding answer you can't     ║
║   defend two follow-ups deep.                                 ║
║                                                               ║
║   Say:                                                        ║
║   "Honestly, I built this as an on-device, single-user        ║
║    system — there's no server today, so I haven't had to      ║
║    solve serving at scale. I can tell you what I'd reach for   ║
║    first — the graph would move server-side and routing would ║
║    become a stateless request — but I'd be reasoning from     ║
║    principles, not from something I've shipped. Distributed   ║
║    serving is the part of my background I'm actively building  ║
║    up. Want me to walk the on-device design I DID build,      ║
║    or reason through the serving version with you?"           ║
║                                                               ║
║   What this signals: you know exactly where your built        ║
║   experience ends, you can still reason forward, and you're   ║
║   honest about which is which. All three are senior signals.  ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "I'd just put it behind a load balancer and shard the       ║
║    graph and add Redis caching and..." — a fluent list of     ║
║   buzzwords you can't defend is the fastest way to turn a     ║
║   strong pitch into a failed loop.                            ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## What you'd change

If you were re-pitching flattr today, the one thing to tighten is the
"no backend" framing — say it as a *decision* up front rather than waiting
to be cornered on it. "No server, by design, because the graph is small and
static" is a strong sentence when you volunteer it, and a defensive one when
it's pried out of you. Lead with the boundary; don't get caught behind it.

---

## One-page summary — read this the night before

**Core claim:** Lead the pitch with the differentiator (flat not fast) and
the hook (directional cost), compress hard, and volunteer the boundary
(no backend) before being asked.

**The three pitches:**
- **10s:** "A walking/scooter router that optimizes for flat, not fast. One
  hill knob. I hand-rolled the A*."
- **30s:** add directional cost + "~1600 nodes, Seattle, no OSRM."
- **90s:** problem → idea (`userMax`) → hard part (one parametric `search()`,
  directional cost, free downhill) → honest boundary (no backend, by
  design) → hand them the next question.

**The hook:** `cost(A→B) ≠ cost(B→A)`. Uphill penalized, downhill free.
A symmetric router can't express it.

**The gap to own:** no server, no scale story shipped. Say so; reason
forward from principles; don't fake a serving architecture.

**Pull quotes:**
- "Optimized for flat, not fast" is the whole product in four words.
- The pitch isn't a summary — it's a fishing line.

**What you'd change:** Volunteer "no backend, by design" up front instead of
defending it after.
