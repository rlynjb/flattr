# Chapter 3 — The choices

This is the chapter that separates engineers from tutorial-followers. An
interviewer doesn't actually care that you chose A* — they care *whether you
chose it* or just used the first thing you found. Every load-bearing decision in
flattr has an alternative you rejected, a real criterion you decided on, and a
cost you're paying right now. This chapter arms you with all three for each one.

There are four choices that matter in flattr, and a bunch that don't. We'll
defend the four — hand-rolled engine vs OSRM, Expo vs the spec's Next.js, free
Open-Meteo vs paid Google elevation, static graph vs a database — and we'll
explicitly *not* spend time on the trivial ones (which test runner, which map
style). Naming which choices are load-bearing is itself a senior signal.

---

## The chapter-opening diagram — the decision tree

Here's every major choice as a fork, with the path you took highlighted. The
ones marked `◄── PICKED` are the four you defend; the criterion is on each
branch.

```
  flattr — the load-bearing choices

  ROUTING ENGINE
  ├── use OSRM / Valhalla / GraphHopper
  │     → project becomes "tune someone's cost weights"
  └── hand-roll graph + A*                      ◄── PICKED
        criterion: the graph work IS the project (spec §14)

  COST MODEL
  ├── undirected (absGradePct, A→B == B→A)
  │     → kept as gradeCostAbs for the heatmap
  └── directional (signed grade, A→B ≠ B→A)     ◄── PICKED
        criterion: uphill effort ≠ downhill effort (cost.ts:32)

  FRONTEND SHELL
  ├── Next.js web (what the spec proposed, §8)
  └── Expo / React Native mobile               ◄── PICKED
        criterion: a router is used outdoors, on a phone,
                   with GPS — native fits the actual use

  ELEVATION SOURCE
  ├── Google Elevation API (paid, sharp)
  │     → kept as googleProvider, gated on a key
  └── Open-Meteo free DEM (no key, 90m coarse)  ◄── PICKED
        criterion: free + good-enough to ship; behind an
                   interface so the upgrade is one swap

  DATA STORE
  ├── Postgres / SQLite (queryable, mutable)
  └── static graph.json baked at build time     ◄── PICKED
        criterion: data is read-only at runtime; no writes,
                   no queries beyond the search → no DB needed

  BLOCKED VALUE
  ├── Infinity (steep edge = impassable)
  └── 1e9 large-but-finite                       ◄── PICKED
        criterion: keep "no flat route" distinct from
                   "no route" (cost.ts:5, spec §14.4)
```

Every fork has a real reason on the picked branch. That's what you're rehearsing
to say out loud.

---

## Choice 1 — hand-rolled engine vs OSRM

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Why did you write your own router instead of using OSRM        │
│    or Valhalla?"                                                  │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Reinventing the wheel, or a deliberate scope choice? Do you     │
│   know what those engines actually do — and what writing it       │
│   yourself bought you? Or did you avoid them because you didn't   │
│   know how to integrate them?                                     │
└─────────────────────────────────────────────────────────────────┘
```

> "Deliberately. If I'd used OSRM or Valhalla, flattr would be a config file —
> I'd be tuning someone else's cost weights, and the graph would be hidden
> behind their API. The entire point of the project is the graph work: I wrote
> the binary-heap priority queue (`pqueue.ts`), the graph and directed traversal
> (`graph.ts`), and the A* (`astar.ts`) myself. And I built it as a measurable
> progression — Dijkstra, then A*, then grade cost, then directional cost — so I
> can show *why each refinement exists*, not just that one algorithm runs.
>
> The cost I'm paying: those engines are far faster and battle-tested at scale,
> with contraction hierarchies and all the production speedups. At my graph size
> (1,621 nodes) that doesn't matter. At a metro-scale graph it would, and that's
> where I'd reach for one — but then I'd have lost the thing I was building this
> to learn."

```
┃ "If I'd used OSRM, this would be config, not graph
┃  work. The graph IS the project."
```

The "cost I'm paying" sentence is what makes this answer senior. You're not
claiming hand-rolling was free — you named the speed and battle-testing you gave
up.

---

## Choice 2 — Expo / React Native vs the spec's Next.js

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Your spec says Next.js on the web. You built an Expo mobile    │
│    app. Why the divergence?"                                      │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Do you follow a plan blindly, or revise it for good reasons?    │
│   Can you justify a deviation from your own written design        │
│   without sounding like you just changed your mind?               │
└─────────────────────────────────────────────────────────────────┘
```

This one is interesting *because* it contradicts the written spec
(`docs/flattr-spec.md §8` proposes Next.js + MapLibre on Netlify). Own the
revision.

> "The spec proposed Next.js on the web. I changed it to Expo / React Native —
> currently Expo ~56, RN 0.85, React 19, with MapLibre via
> `@maplibre/maplibre-react-native`. The reason is the use case: a flat-route
> router is something you use *outdoors, on a phone, with live GPS*. The web
> version would be a demo; the mobile version is the actual product. I get
> location, tap-to-route, and a real on-device map.
>
> The core engine didn't care either way — it's pure TypeScript under
> `features/routing/`, no framework. There's a sync script
> (`mobile/scripts/sync-engine.mjs`) that copies it into the mobile app. So the
> divergence was only in the shell, not the graph work. The cost: a mobile
> toolchain is heavier than `next dev`, and I'm pinned to Expo 56's exact
> versioned APIs."

The move here: you revised your own plan and can say *why* without
defensiveness. Interviewers love a justified deviation — it shows the plan
served you, not the reverse.

---

## Choice 3 — free Open-Meteo vs paid Google elevation

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Why Open-Meteo for elevation and not Google's API?"           │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Did you think about cost and fidelity as a tradeoff, or just    │
│   grab the free one? Did you design for the upgrade, or hard-     │
│   wire the cheap choice in?                                       │
└─────────────────────────────────────────────────────────────────┘
```

> "Open-Meteo is free, needs no API key, and serves the Copernicus 90-meter DEM.
> That's good enough to ship and learn with. The cost I'm paying is fidelity —
> 90 meters is coarse, so it smooths out short steep pitches, which for a
> *grade* router is exactly the data I care most about.
>
> The important part is I designed for the upgrade. Elevation is behind an
> interface — `ElevationProvider` in `elevation.ts:7`, one method, `sample()`.
> There's already a `googleProvider` and an `openMeteoProvider` implementing it.
> Swapping to Google's paid, sharper data, or to LIDAR, is one line at the call
> site. So I took the free option knowing the seam to upgrade it is already
> there."

```
        ▸ "I took the free option, but the seam to
          upgrade it is already in the code." — naming
          the seam turns a cheap choice into a designed one.
```

This is the cleanest "evaluated-and-accepted" decision in the project — and a
preview of Chapter 8's three modes. You didn't default to free; you chose free
*and* built the off-ramp.

---

## Choice 4 — static graph.json vs a database

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Why a static JSON file instead of a database?"                │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Do you reach for a DB by reflex, or do you actually look at     │
│   the access pattern? Can you name what a DB would buy you here   │
│   — and correctly conclude it buys nothing?                       │
└─────────────────────────────────────────────────────────────────┘
```

> "Because the access pattern doesn't need one. At runtime the graph is
> read-only — there are no writes, no per-user data, no queries beyond the graph
> search itself, which walks an in-memory adjacency map, not a table. A database
> buys you mutability, concurrent writes, and rich queries. flattr needs none of
> those at runtime. The graph is computed once at build time and frozen into
> `graph.json` (1,621 nodes, 1,879 edges), which the app bundles and
> `loadGraph()` imports directly.
>
> The cost: the data is immutable until I re-run the build, and the whole graph
> loads into memory at once. At 1,621 nodes that's trivial. The point where I'd
> add a real store is when I need live updates — a street closes, construction —
> or when the graph is too big to hold in memory. Neither is true at this
> scope."

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                   │ STRONG ANSWER                 │
├──────────────────────────────┼──────────────────────────────┤
│ "A database felt like         │ "The runtime access pattern   │
│ overkill for a small project, │ is read-only with no queries  │
│ so I just used a JSON file."  │ beyond the in-memory graph    │
│                               │ search. A DB buys mutability  │
│                               │ and querying — I need neither │
│                               │ at runtime. I'd add one when  │
│                               │ I need live updates or the    │
│                               │ graph outgrows memory."       │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:                │ Why it works:                  │
│ "Overkill" and "small         │ Reasons from the access        │
│ project" are vibes, not       │ pattern, names what a DB would │
│ reasons. It signals you avoid │ actually provide, concludes it │
│ databases out of discomfort,  │ provides nothing here, and     │
│ not analysis.                 │ names the exact trigger to add │
│                               │ one. That's the analysis.      │
└──────────────────────────────┴──────────────────────────────┘
```

Data-modeling depth (why no schema, no indexes, no migrations) →
`.aipe/study-data-modeling/` and `.aipe/study-database-systems/`.

---

## Where the choices conversation goes next

```
  You've defended hand-rolling the engine.
        │
        ├─► IF THEY ASK "is your A* actually optimal?"
        │     "Yes — the heuristic is admissible. Cost is
        │      length*(1+penalty), penalty ≥ 0, so cost ≥
        │      length; haversine straight-line ≤ true path
        │      length, so it never overestimates. A* returns
        │      the same path as Dijkstra. Chapter 6 proves it."
        │
        ├─► IF THEY ASK "why directional cost specifically?"
        │     "Uphill effort and downhill effort aren't
        │      symmetric. directedGrade flips sign by travel
        │      direction (graph.ts:17); penalty only hits
        │      positive grade (cost.ts:16). Downhill is free."
        │
        └─► IF THEY ASK "what about the BLOCKED value?"
              "1e9, large-but-finite, not Infinity (cost.ts:5).
               That keeps 'a path exists but it's steep' (A*
               returns it, flags the steep edges) distinct from
               'no path at all' (null, disconnected). Two real
               graph states. Chapter 5."
```

---

## The "I don't know" box — when they push on the engine internals

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "How would OSRM's contraction hierarchies         ║
║   actually speed this up? Walk me through the preprocessing."  ║
║                                                               ║
║   You chose NOT to use these and you haven't implemented      ║
║   them. Don't fake the internals of a technique you skipped.  ║
║                                                               ║
║   Say:                                                         ║
║   "I know contraction hierarchies are a preprocessing         ║
║    speedup — you precompute shortcut edges so queries skip    ║
║    through dense regions — and that's the class of technique   ║
║    production routers use at metro scale. I deliberately       ║
║    didn't implement it; at 1,621 nodes my A* query is         ║
║    sub-millisecond, so the preprocessing cost wouldn't pay     ║
║    back. I haven't built one, so I can't walk you through      ║
║    the contraction ordering in detail. If you want, I can      ║
║    reason about where it'd fit in my pipeline."               ║
║                                                               ║
║   What this signals: you know what the technique IS and WHY   ║
║   you skipped it (the scale math), and you stop cleanly at    ║
║   the boundary of what you've built. That's the senior        ║
║   pattern — knowing the shape without faking the depth.       ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "Yeah, it like... contracts the nodes into a hierarchy      ║
║    and then it's faster" — vague restatement of the name is   ║
║    worse than admitting you skipped it.                       ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## What you'd change about the choices

The one I'd revisit is elevation. Open-Meteo's 90m DEM was the right call to
*ship*, but for a grade router, coarse elevation undermines the core value — it
literally smooths away the steep pitches I exist to route around. Since the
`ElevationProvider` seam is already there (Chapter 7 covers this), the change is
cheap: wire `googleProvider` behind a config flag, accept the cost and the API
key, and get sharp grades. Everything else I'd keep — hand-rolled engine, no DB,
directional cost, finite BLOCKED. Those were right and I'd make them again.

---

## One-page summary — Chapter 3

**Core claim:** Every load-bearing choice has an alternative, a criterion, and a
cost. Naming all three — especially the cost — is what reads as senior.

**The four choices:**
- **Hand-rolled vs OSRM** → the graph work is the project; cost = speed/battle-testing at scale.
- **Expo vs Next.js (spec divergence)** → a router is used outdoors on a phone; engine is framework-agnostic so only the shell changed.
- **Open-Meteo vs Google elevation** → free + good-enough; upgrade seam (`ElevationProvider`, elevation.ts:7) already built; cost = 90m coarseness.
- **Static graph.json vs DB** → runtime is read-only, no queries beyond the in-memory search; cost = immutable until rebuild.

**Plus:** finite `BLOCKED` (1e9) keeps "steep" distinct from "disconnected"; directional cost from signed grade.

**Pull quotes:**
- ┃ "If I'd used OSRM, this would be config, not graph work."
- ▸ "I took the free option, but the seam to upgrade it is already in the code."

**What you'd change:** Swap to the (already-implemented) paid `googleProvider` for sharp elevation — coarse 90m data undercuts the whole point of a grade router. Keep everything else.
