# Chapter 3 — The choices

This is the chapter interviewers use to separate people who *made* decisions from people who *accepted defaults*. Every "why X?" is really "did you consider the alternatives, and can you name the cost you're paying?" The trap is answering with a benefit ("it's fast," "it's popular") instead of a *decision criterion plus a tradeoff*. A benefit is marketing. A criterion-plus-cost is engineering.

flattr has four load-bearing choices worth defending: hand-rolling the router, Expo/React Native, Open-Meteo for elevation, and shipping the graph as a static artifact instead of standing up a database. The trivial ones — Vitest, tsx, which box-drawing tool — skip. Spend your breath on the four that shaped the system. And on a couple of these, the honest defense includes "this is what I'd reconsider" — that's not weakness, it's the senior move.

```
  THE LOAD-BEARING CHOICES — alternative vs picked (★)

  ROUTER ENGINE
    Valhalla / OSRM / GraphHopper ──┐
    ★ hand-rolled A* (features/routing) ◄── the point of the project
                                    └─ cost: no CH, no city scale (yet)

  FRONTEND
    Next.js web (what the spec proposed) ──┐
    ★ Expo / React Native + MapLibre ◄── mobile-first, offline
                                       └─ cost: diverged from the spec

  ELEVATION SOURCE
    Google Elevation (paid, reliable) ──┐
    ★ Open-Meteo (free, ~90m DEM) ◄── free default
                                    └─ cost: rate limits, coarser grades

  PERSISTENCE
    Postgres + PostGIS routing server ──┐
    ★ static graph.json, read-only ◄── no backend, offline
                                    └─ cost: no live updates, rebuild to change

  HEAP STRATEGY
    decrease-key (you've built one in reincodes) ──┐
    ★ lazy deletion (pqueue.ts) ◄── simpler, correct
                                 └─ cost: bigger heap, pops > expanded
```

Each branch above is a section below. The pattern is identical every time: name the alternative, name the criterion, name the cost. Never just the benefit.

## Why hand-roll the router?

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Why build your own A\* instead of using OSRM    │
│    or a routing library?"                         │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you reinvent wheels for ego, or for a        │
│   reason? Can you justify the build-vs-buy call,  │
│   and do you know what the library would've       │
│   given you that you gave up?                     │
└─────────────────────────────────────────────────┘

> "Two reasons. First, the directional grade cost — A→B ≠ B→A because uphill is penalized and downhill is free — isn't something the off-the-shelf engines expose cleanly; you'd be fighting their cost model. Second, and honestly the bigger one: the graph algorithm *is* the point of this project. I wanted to own the search, not call it. So I built one `search()` function that's Dijkstra, A\*, and the grade variants by argument, with a lazy-deletion heap and an admissible heuristic I can prove optimal against a Dijkstra oracle. The cost I'm paying is real: OSRM has contraction hierarchies and answers continent-scale queries in microseconds. Mine doesn't — no preprocessing layer, so it's neighborhood-scale. For what this is, that's the right trade."

The tell that you're senior: you volunteered what OSRM gives you that you gave up (contraction hierarchies, city scale) *before* they asked. That's owning the cost.

┃ "The graph algorithm is the point of the project — I wanted to own the search, not call it."

## Why Expo / React Native, when the spec said Next.js?

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Why React Native? I see the spec describes a   │
│    web app."                                      │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   When you diverge from a plan, was it deliberate │
│   or drift? Can you defend changing your own      │
│   spec? (And: are you honest that it changed?)    │
└─────────────────────────────────────────────────┘

This one is interesting because the divergence is documented — the spec proposes Next.js + MapLibre GL JS on Netlify, and you built Expo/RN instead. Own the change directly.

> "The spec I wrote first proposed a Next.js web app. I changed it deliberately: this is a *mobility* product — you use it on a phone, outdoors, walking — so a native app with real GPS and offline support is the honest platform. React Native with Expo got me there fastest given my background; I've shipped RN before with buffr and contrl. MapLibre has a native binding, so the map layer carried over. The cost is that I diverged from my own written spec, which I keep noted in the project context so it's not silent drift — and Expo's native-module story means I read the versioned docs before touching anything in `mobile/`."

The reason this lands: you didn't hide that you changed the plan. You named *why* (it's a phone product), named that you have the RN reps to do it (buffr, contrl), and named the cost (spec divergence, tracked).

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "I just went with React Native because I'm more comfortable with mobile and it's cross-platform." | "It's a phone-first mobility product — native GPS and offline matter — so I deliberately moved off the web spec to Expo/RN, which I've shipped before. The cost is a tracked divergence from my own spec." |
| **Why it's weak:** "more comfortable" is a personal-convenience reason, and it doesn't acknowledge the spec said otherwise. Reads as drift. | **Why it works:** product-driven criterion, prior evidence you can do it, and explicit ownership of the divergence. Deliberate, not accidental. |

## Why Open-Meteo for elevation, not Google?

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "How do you get elevation? Why that source?"    │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Did you think about cost, limits, and data      │
│   quality — the operational realities of an       │
│   external dependency — or just grab the first    │
│   free API?                                       │
└─────────────────────────────────────────────────┘

> "Open-Meteo's elevation API — free, no key, Copernicus 90-meter DEM. The decision criterion was: free by default, paid only if the product needed it. Google's Elevation API is more reliable and finer-grained but it's paid and keyed, and for a portfolio router that's overkill. The costs I took on are concrete and I hit both: the 90-meter DEM is coarse, so grades get a little spiky — steepness concentrates on the segments that cross a DEM cell boundary — and the free tier rate-limits hard. I designed around the rate limit: I dedup elevation requests to one sample per ~90m cell, batch them, retry with backoff, fall back to flat if it's throttled, and cache results to disk so a fetched cell never gets re-requested. The provider is behind an interface, so swapping in Google later is a one-file change."

This is your strongest "I understood the operational reality" answer, because it's *true* — you lived the 429 throttling. The interface-behind-it detail (`ElevationProvider`) shows you isolated the dependency.

```
  IF THEY PUSH ON THE ELEVATION CHOICE

  "Open-Meteo, free DEM."
        │
        ├─► "What happens when it rate-limits?"
        │     "Best-effort: build the region flat rather than fail,
        │      mark it degraded, retry quietly, and the route card
        │      says 'grades approximate.' Failure 5 is the whole story."
        │
        ├─► "Isn't 90m too coarse for street grades?"
        │     "Yes, it's the real fidelity cost. Grades read spiky.
        │      The fix is a finer DEM or the paid Google source —
        │      it's a provider swap, the interface is already there."
        │
        └─► "How do you avoid hammering a free API?"
              "Dedup to one sample per ~90m cell, batch the request,
               and a persistent AsyncStorage cache so revisits cost
               zero requests."
```

## Why no database — a static graph artifact?

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Why ship the graph as a file instead of        │
│    putting it in a database?"                     │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you reach for infrastructure reflexively, or │
│   do you match storage to access pattern? Knowing  │
│   when NOT to add a database is senior signal.    │
└─────────────────────────────────────────────────┘

> "The access pattern is read-only and whole-graph: the router loads the entire graph once and traverses it in memory. There are no writes, no per-row queries, no concurrent mutation — so a database would buy me nothing and cost me a server, a connection, and a network hop on the hot path. Instead the graph is a static `graph.json` bundled in the app, parsed once at startup. The adjacency map *is* my index — it makes each node expansion O(1). The cost is honest: the data is frozen at build time, so updating the map means rebuilding and reshipping the artifact, and there's no schema version on it, which is a real gap I'd close. But for read-only routing, a file beats a database."

That last criterion — "match storage to the access pattern" — is the line that reads as experienced. You didn't avoid a database out of laziness; you avoided it because the workload is all reads.

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They go deep on a routing engine you named as    ║
║   an alternative — "how do contraction            ║
║   hierarchies actually work?" You know they exist  ║
║   and what they buy, but you haven't implemented   ║
║   one.                                            ║
║                                                   ║
║   Say:                                            ║
║   "At a high level CH precomputes shortcut edges   ║
║    so query-time search skips huge chunks of the   ║
║    graph — that's how OSRM hits microseconds. I    ║
║    haven't implemented one; it's the documented    ║
║    stage-6 stretch in my spec. If you want to go   ║
║    into the preprocessing, walk me through where    ║
║    you'd start."                                   ║
║                                                   ║
║   What this signals: you know the concept and its  ║
║   payoff, you're honest you haven't built it, and  ║
║   you can keep the conversation going.            ║
║                                                   ║
║   Do NOT say:                                      ║
║   "Yeah, it's like caching the paths…" — vague     ║
║   hand-waving over a named algorithm you don't     ║
║   own is worse than a clean "I haven't built       ║
║   that."                                           ║
╚═══════════════════════════════════════════════════╝

▸ Every choice defense has the same skeleton: the alternative, the criterion, the cost. If you only said the benefit, you haven't defended it yet.

## What you'd change

The choice I'd most reconsider is Open-Meteo as the *only* elevation path. Free-by-default was right, but the 90-meter DEM makes grades coarse enough that the heatmap reads mostly green even when the data is real — which undercuts the product's whole premise of showing terrain honestly. I wouldn't rip it out; I'd keep it as the free tier and add the paid Google provider behind the same `ElevationProvider` interface as an opt-in for fidelity. The interface already exists precisely so this is a small change. The lesson I'd carry: when a free dependency's *quality* (not just its uptime) is load-bearing for the product, plan the upgrade path on day one, not after the heatmap looks flat.

## One-page summary

**Core claim:** Defend every choice with the same skeleton — the alternative, the decision criterion, the cost you're paying. A benefit alone is not a defense.

- **Hand-rolled router:** directional cost the libraries don't expose + the algorithm is the point. Cost: no contraction hierarchies, neighborhood scale.
- **Expo/RN over the Next.js spec:** phone-first mobility product, native GPS + offline; I've shipped RN before. Cost: deliberate, tracked spec divergence.
- **Open-Meteo elevation:** free-by-default, paid-if-needed. Cost: coarse 90m grades + hard rate limits — designed around with dedup, batch, backoff, flat fallback, disk cache.
- **Static graph, no DB:** read-only whole-graph access pattern; adjacency is the index, O(1) expansion. Cost: frozen data, rebuild to update, no schema version.
- **Lazy-deletion heap:** simpler and correct; upgrade to decrease-key only if `pops ≫ nodesExpanded` in the bench.

┃ "Match the storage to the access pattern — read-only routing wants a file, not a database."
┃ "The provider's behind an interface, so swapping it is a one-file change."

**What you'd change:** Keep Open-Meteo as the free tier but add the paid Google provider behind the existing `ElevationProvider` interface, because the DEM's *quality* is load-bearing for the product, not just its uptime.
