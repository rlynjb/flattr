# Chapter 1 — The pitch

In the first ten minutes of every senior interview, someone asks you to tell them about a project. This is where most candidates lose the room — not because the project is weak, but because they ramble. They start at the OSM data, detour through the elevation API, mention a bug, and two minutes later the interviewer still doesn't know what the app *does*. Your job in the opening is the opposite of thorough: it's compression. Say what flattr is, who it's for, and the one technically interesting thing about it — then stop and let them pull.

You have three pitches, not one. The length you reach for depends on the moment: a hallway, a "tell me about yourself," the real project deep-dive. Same core, three depths. Get the 10-second one so tight you could say it asleep, because the 30 and the 90 are just that sentence with the layers added back.

```
  THE THREE PITCHES — same spine, growing depth

  10s ── WHAT + THE HOOK
  ┌──────────────────────────────────────────────────────┐
  │ "A walking/scooter router that optimizes for FLAT,    │
  │  not fast — hand-rolled A* over an elevation graph."  │
  └──────────────────────────────────────────────────────┘
            │  add: the knob + the platform
            ▼
  30s ── WHAT + HOW IT'S USED + WHAT'S UNDER IT
  ┌──────────────────────────────────────────────────────┐
  │ + one knob: userMax (steepest uphill you'll accept)   │
  │ + Expo/RN map app, works offline off a bundled graph  │
  │ + the cost is DIRECTIONAL — uphill penalized, down free│
  └──────────────────────────────────────────────────────┘
            │  add: the build/run split + why it's interesting
            ▼
  90s ── THE REAL ANSWER (pitch → architecture → the seam)
  ┌──────────────────────────────────────────────────────┐
  │ + build-time pipeline (OSM+elevation → graph.json)    │
  │ + runtime engine: one search() = Dijkstra/A*/directed │
  │ + the interesting bit: A→B ≠ B→A, and an honest        │
  │   fallback (BLOCKED is finite, not Infinity)          │
  └──────────────────────────────────────────────────────┘

  rule: each pitch ENDS on the hook, so they ask the next question.
```

The pitch isn't a summary you recite — it's bait. End on the most interesting hook and let them bite.

## The 10-second version

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "So what'd you build?" (hallway, casual)        │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Can you compress? Do you know what your own     │
│   project actually is, or do you only know its    │
│   parts? Rambling here predicts rambling later.   │
└─────────────────────────────────────────────────┘

Say this, in your voice:

> "It's a walking and kick-scooter router that optimizes for flat instead of fast. I hand-rolled the A\* search over a street graph annotated with elevation grades."

That's it. Two sentences. The first is the product; the second is the hook ("hand-rolled the A\*") that makes a senior interviewer lean in, because it tells them this isn't a Google Maps API wrapper.

┃ "Optimizes for flat, not fast" is the whole product in four words. Lead with it every time.

## The 30-second version

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Tell me about something you've worked on."     │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Can you describe a system at the right          │
│   altitude — what it does and how it's used —     │
│   without diving into implementation in the       │
│   first breath?                                   │
└─────────────────────────────────────────────────┘

> "flattr is a grade-aware router for self-powered travel — walking, kick scooters. The idea is that the shortest route isn't the best route if it goes over a hill; flattr finds the *flattest comfortable* one instead. Everything keys off a single knob, `userMax` — the steepest uphill you're willing to climb. It's an Expo/React Native app with a MapLibre map, and it works offline because the street graph ships bundled with the app. The part I find interesting is that the cost is *directional* — going up a block is penalized, coming down the same block is free — so the route from A to B isn't the reverse of B to A."

Notice the shape: product → who it's for → the knob → the platform → the hook. You land on directionality because that's the thing most routers skip, and it's true of your code (`cost.ts` reads a signed grade via `graph.ts`'s `directedGrade`).

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "It's a routing app I built with React Native and MapLibre. It uses A\* to find paths and has elevation data. I also did the data pipeline with OpenStreetMap and an elevation API, and there's a heatmap and address search and…" | "flattr routes walkers and scooters for *flattest*, not fastest, off one knob — max uphill grade. RN/MapLibre app, works offline off a bundled graph. The interesting part: the cost is directional, so A→B isn't the reverse of B→A." |
| **Why it's weak:** it's a parts list. Frameworks and features with no spine. The interviewer can't tell what's load-bearing, and you've already used your 30 seconds on plumbing. | **Why it works:** product first, one crisp hook, ends somewhere they want to follow. You've spent zero words on the test runner and every word on what's interesting. |

## The 90-second version

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Walk me through a project you're proud of."    │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Can you go from product to architecture to the  │
│   one genuinely hard thing — in a structured arc, │
│   not a brain-dump? This is the audition for the  │
│   whole interview's communication.                │
└─────────────────────────────────────────────────┘

This is the one to rehearse out loud until it's muscle. Three beats: **product (15s) → architecture (45s) → the seam (30s).**

> "flattr is a grade-aware router for walking and scooters — it optimizes for flat instead of fast, off one knob: the steepest uphill grade you'll accept.
>
> Architecturally it splits cleanly into build-time and runtime. At build time I run a pipeline — pull the street network from OpenStreetMap via Overpass, densify the segments, sample elevation from Open-Meteo, and compute a grade for every edge. That bakes into a static `graph.json` that ships inside the app. At runtime there's no server and no database — the app reads that graph and runs the search on-device, so it works offline. The frontend is Expo/React Native with a MapLibre map.
>
> The engine is the part I'm proud of: it's hand-rolled, not a routing library. There's one `search()` function that *is* Dijkstra, A\*, and the grade-aware variants — they're the same function with different cost and heuristic arguments. Dijkstra is just A\* with a zero heuristic. The cost function is where the domain lives: it reads a *directional* grade, so climbing a block costs more than descending it, which makes it a genuinely directed-graph problem. And the failure handling is deliberate — when every route has a steep block, I still return one and flag it, instead of saying 'no route.' I reserve 'no route' for a graph that's actually disconnected."

Then stop. You've given them five places to pull: the pipeline, the offline artifact, the one-function search, the directional cost, the honest fallback. Let them pick.

```
  WHERE THEY PULL AFTER THE 90s — map the branches

  You finish the 90s pitch.
        │
        ├─► "Why hand-rolled and not a routing library?"
        │     → Chapter 3. The graph work is the point of the
        │       project; I wanted to own the algorithm, not call one.
        │
        ├─► "How does the directional cost work?"
        │     → directedGrade(edge, fromNode) flips the sign by
        │       which end you entered. cost.ts penalizes positive grade.
        │
        ├─► "Walk me through the architecture."
        │     → Chapter 2. Go to the build-time/runtime diagram.
        │
        └─► "No backend at all? How does that work?"
              → The graph is a read-only artifact bundled in the app;
                tiles beyond it re-run the pipeline on-device.
```

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They open with "what's the product strategy /   ║
║   who are the users / what's the business model?"  ║
║   flattr is a portfolio/learning project — there  ║
║   is no user base or monetization, and pretending  ║
║   otherwise collapses instantly.                  ║
║                                                   ║
║   Say:                                            ║
║   "This is a project I built to go deep on graph  ║
║    search and an offline-first mobile             ║
║    architecture — it's not a product with users.  ║
║    The problem is real, though: grade-aware       ║
║    routing genuinely matters for scooters and     ║
║    accessibility, and it gave me a real reason to  ║
║    hand-roll A* with a directional cost."         ║
║                                                   ║
║   What this signals: you know the difference      ║
║   between a learning project and a product, and    ║
║   you're honest about which this is.              ║
║                                                   ║
║   Do NOT say:                                     ║
║   "Well, the target market is urban commuters     ║
║    and we'd monetize with…" — inventing a         ║
║    business for a portfolio project reads as       ║
║    insecure. Own that it's a craft project.       ║
╚═══════════════════════════════════════════════════╝

▸ Don't dress a learning project as a startup. "I built this to go deep on X" is a stronger sentence than a fake business model.

## What you'd change

If I were re-pitching this, I'd resist the urge to mention the elevation API and the offline caching in the opener — they're real engineering, but they're not the *hook*, and naming them early buries the directional-cost story under plumbing. The pitch got tighter every time I cut a true-but-secondary detail out of the first 30 seconds. The discipline isn't adding the best parts; it's removing the merely-accurate ones until only the hook is left.

## One-page summary

**Core claim:** Lead with the product in four words — "flat, not fast" — and end every pitch on a hook that makes them ask the next question. Compression is the skill being tested.

- **"What'd you build?" (10s):** "Walking/scooter router that optimizes for flat, not fast — I hand-rolled the A\* over an elevation graph."
- **"Tell me about a project." (30s):** product → the `userMax` knob → RN/offline → hook on directional cost (A→B ≠ B→A).
- **"Walk me through it." (90s):** product (15s) → build-time/runtime split (45s) → the seam: one `search()` for all variants, directional cost, honest BLOCKED fallback (30s). Then stop.
- **No business model?** Own that it's a craft/learning project with a real problem behind it. Don't fake a market.

┃ "Optimizes for flat, not fast." — the four words you never bury.
┃ "Dijkstra is just A\* with a zero heuristic" — the one line that signals you own the algorithm.

**What you'd change:** Cut the elevation-API and caching details out of the opener — they're true but they bury the hook. Pitch the seam, not the plumbing.
