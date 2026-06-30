# The Problem Brief

The 10-point brief, in order. This is the document you'd put in front of
a staff engineer or a hiring panel and defend line by line. Every claim
is tagged **EVIDENCE** (a `file:line` you can open) or **INFERENCE**
(plausible, but about humans, and not in the repo). Don't let the two
blur.

---

## Where the problem sits

Before the points, put the problem on the map. flattr is a routing
problem that lives between three free data providers and one phone.

```
  Zoom out — where the problem lives

  ┌─ User layer ──────────────────────────────────────────┐
  │  someone on foot / kick scooter / wheels who can't     │
  │  comfortably climb a hill   ←★ THE PROBLEM LIVES HERE ★ │
  └─────────────────────────┬──────────────────────────────┘
                            │  "route me somewhere flat"
  ┌─ App layer (mobile/) ───▼──────────────────────────────┐
  │  Expo app: address bar → directedAstar() → colored     │
  │  path + climb number     (offline, no network in route)│
  └─────────────────────────┬──────────────────────────────┘
                            │  reads bundled graph.json
  ┌─ Build layer (pipeline/) ─▼────────────────────────────┐
  │  OSM/Overpass streets + Open-Meteo elevation →          │
  │  grade-annotated graph (BUILD-TIME ONLY)               │
  └────────────────────────────────────────────────────────┘
```

The technical machinery (bottom two bands) is built and tested. The
top band — the human with the pain — is asserted, not measured. Keep
that asymmetry in view through all ten points.

---

## 1. User or operational problem — who experiences what pain

**The claimed pain (INFERENCE, from `docs/flattr-spec.md` §1):** Google
Maps minimizes distance/time and buries per-block grade inside a
smoothed elevation curve. Tools that *do* expose grade (AccessMap) use
fixed pedestrian thresholds not tuned to how the specific rider travels.
So a kick-scooter commuter and a hill-avoiding walker share one unmet
need: a route that avoids what *they personally* can't comfortably
climb, plus a map showing where the flat is at a glance.

**Who (INFERENCE, spec §3):** three personas —

```
  Three asserted personas — none validated by a real user

  ┌──────────────────────┬───────────────────────────────────┐
  │ kick-scooter / push  │ wants blocks they can kick without │
  │ commuter             │ dismounting on the steep ones      │
  ├──────────────────────┼───────────────────────────────────┤
  │ hill-avoiding        │ older adults, fatigue, heat — flat │
  │ pedestrian           │ over fast                          │
  ├──────────────────────┼───────────────────────────────────┤
  │ wheelchair / stroller│ hard grade ceiling, non-negotiable │
  │ / rolling luggage    │                                    │
  └──────────────────────┴───────────────────────────────────┘
```

**The honest line you say out loud:** "These are personas I wrote, not
people I interviewed. The repo proves I can *route* for them. It does
not prove they exist in numbers or would switch tools." That sentence is
the spine of the whole brief.

## 2. Evidence and current cost — repo vs inference

This is the point that matters most. Split it cleanly.

```
  The split — what's grounded vs what's asserted

  EVIDENCE (file:line)              INFERENCE (about humans)
  ──────────────────────            ────────────────────────
  router works        ✓             pain is real           ?
  oracle: A*==Dijkstra ✓            pain is widespread      ?
  bench numbers       ✓             users would switch      ?
  honest fallback     ✓             presets beat AccessMap  ?
  shipped on a city   ✓             grade is trusted        ?
       │                                    │
       ▼                                    ▼
  "I can build it"                  "they want it built"
  PROVEN                            UNPROVEN — the gap
```

**EVIDENCE — the technical premise is solid:**

- The grade-aware router runs and is correct. `features/routing/astar.ts:22-78`
  is one parametric `search()`; `directedAstar` (lines 155-162) wires the
  signed-grade cost to the admissible haversine heuristic.
- The directional penalty is real and tested:
  `features/routing/cost.ts:16-22` — flat/downhill is free, moderate
  uphill is linear (`k1=0.4`), steep uphill is quadratic (`k2=1.0`), over
  `userMax` is `BLOCKED`.
- **The oracle is your single strongest piece of evidence.**
  `features/routing/astar.test.ts:38-44` asserts A* returns the *same*
  optimal cost as Dijkstra to 6 decimals; lines 47-52 assert A* expands
  ≤ Dijkstra. That's a correctness proof, not a vibe.
  → walk the mechanics in `../study-testing/01-optimality-oracle.md`.
- The bench produces hard numbers (`bench/run.ts`): on a grid30 interior
  pair, Dijkstra expands **203** nodes, A* expands **32** — ~6.3× fewer.
  On grid40 mid-interior, **1079 → 276**, ~3.9×.
  → see `../study-performance-engineering/01-heuristic-pruning.md`.

**The current cost of the problem (INFERENCE):** the spec asserts a
walker takes a hillier route than they'd choose because no tool exposes
*their* threshold. There is no measured cost — no time lost, no trips
abandoned, no user complaint in the repo. State it as the hypothesis it
is.

## 3. Why now — what changed or compounds

**EVIDENCE that the build is newly cheap:** the three data inputs are
free and keyless today —

```
  Why the build is feasible now — free-tier stack

  ┌─ OSM via Overpass ─┐  ┌─ Open-Meteo DEM ─┐  ┌─ Nominatim ─┐
  │ street network     │  │ 90m elevation    │  │ geocoding   │
  │ pipeline/          │  │ pipeline/        │  │ pipeline/   │
  │ overpass.ts:4-48   │  │ elevation.ts:85+ │  │ geocode.ts  │
  │ free, retried      │  │ free, no key     │  │ free, ~1rps │
  └────────────────────┘  └──────────────────┘  └─────────────┘
```

A grade-annotated street graph used to need paid elevation data and a
routing license. The free tier makes a single developer able to build
the whole thing — and the repo proves it (`data/graph.json` exists).

**The honest counterweight:** "why now" for the *technology* is real and
provable. "Why now" for the *demand* is not in the repo. Don't claim a
market timing you can't show.

## 4. Beneficiaries and exclusions

```
  In scope vs out — who this is and isn't for

  BENEFITS (asserted)            EXCLUDED (by design — see ch. 02)
  ──────────────────             ─────────────────────────────────
  self-powered travelers in      • drivers (it's not a car router)
  one bundled neighborhood:      • transit / multi-modal trips
   - on foot                     • anyone outside the bundled bbox
   - kick scooter                  (Capitol Hill, ~0.35 km²)
   - mobility aids / wheels       • users needing turn-by-turn nav
                                  • users needing accounts / history
```

**EVIDENCE for the in-scope boundary:** the shipped graph covers exactly
one bbox — `[-122.3284, 47.6181, -122.3214, 47.6241]`, a Capitol Hill
slice (`pipeline/config.ts`), 1621 nodes / 1879 edges. Everyone outside
that box is excluded *today* by the artifact itself, not by a roadmap
promise.

## 5. Constraints

Four hard constraints, all visible in the repo. They bound every option
in chapter 03.

```
  ┌─ free-tier data ──────────► no paid budget; Open-Meteo │
  │                             429s under heavy testing    │
  ├─ hand-rolled engine ──────► no Valhalla/OSRM/GraphHopper│
  │   (spec §14)                the graph + router IS the    │
  │                             point — portfolio repo       │
  ├─ offline client ──────────► graph is a bundled static    │
  │   (loadGraph.ts:1-11)       asset; no net in route path  │
  └─ single developer ────────► no team, no PM, no users     │
```

These aren't excuses. They're the frame. A reviewer who hears "I
hand-rolled the router *on purpose* because the algorithm is the
artifact" reads a deliberate constraint, not a gap.

## 6. Options — including DO NOTHING

Full treatment with opportunity cost is in
`03-options-and-opportunity-cost.md`. The headline: **`do nothing` is a
real, ranked option** — the engine is already built and tested, so
walking away loses very little and avoids pouring more single-developer
time into an unvalidated demand. Any option that *adds* scope must beat
that bar.

## 7. Smallest useful scope — the validating slice

The narrowest thing that tests the premise is **already built**, which
is the cheapest possible position to be in.

```
  The smallest validating slice — and it ships today

  ┌────────────────────────────────────────────────────────┐
  │  ONE bundled neighborhood (Capitol Hill, ~0.35 km²)     │
  │  + set two endpoints (address bar)                      │
  │  + a grade-routed, color-coded path                     │
  │  + the climb number on a summary card                   │
  │                                                          │
  │  = enough to put in front of one real walker and ask:   │
  │    "is this the route you'd actually take?"             │
  └────────────────────────────────────────────────────────┘
```

**EVIDENCE it exists:** `mobile/src/MapScreen.tsx:150-162` calls
`directedAstar(graph, startId, endId, userMax)` client-side;
`mobile/src/RouteSummaryCard.tsx:26-27` renders distance + rounded climb;
the colored path and legend key off `userMax`. The validating
experiment is not a thing to build — it's a thing to *run*. Detailed in
chapter 02.

## 8. Non-goals and cuts

Explicit, in `02-scope-cuts-and-non-goals.md`. Headline non-goals:
**city-wide coverage, turn-by-turn navigation, user accounts, and
multi-modal/transit routing.** Each is a deliberate cut, not a missing
feature.

## 9. Success metrics — available-now vs needs-users

Full treatment in `04-success-metrics-and-feedback-loop.md`. The split
is the whole point:

```
  Two metric classes — don't confuse them

  AVAILABLE NOW (repo)           NEEDS USERS (can't fake)
  ────────────────────           ─────────────────────────
  oracle: A*==Dijkstra ✓         adoption / installs
  bench expansions ✓             switching from Google Maps
  route plausibility (eyeball)   trust in the grade colors
                                 retention / repeat use
```

You can prove the left column today. The right column requires the one
experiment in chapter 02. Never report a left-column metric as if it
answered a right-column question.

## 10. Risks and objections

The skeptical review room is `05-skeptical-reviewer-questions.md`. The
sharpest objections, previewed: *AccessMap already does hill-avoidance*;
*90m DEM smooths the short steep pitches that matter most*; *you dropped
your own central slider (b24797c) before any user asked*; *one
0.35 km² neighborhood proves nothing about generality.* Each has an
answer that holds — go read them.

---

## The brief in one frame

```
  flattr problem brief — the whole thing, one picture

  ┌─ PROVEN (EVIDENCE) ────────────────────────────────────┐
  │  technically solvable: grade-aware A*, oracle-correct,  │
  │  bench-measured, honest fallback, shipped on one city   │
  │  → astar.ts, cost.ts, *.test.ts, bench/, graph.json     │
  └────────────────────────┬───────────────────────────────┘
                           │  but
  ┌─ UNPROVEN (INFERENCE) ─▼───────────────────────────────┐
  │  worth solving: demand, switching, trust, generality    │
  │  → zero users, zero telemetry, zero research in repo    │
  └────────────────────────┬───────────────────────────────┘
                           │  so
  ┌─ THE MOVE ─────────────▼───────────────────────────────┐
  │  run the already-built slice on ONE real walker before  │
  │  investing another hour. do-nothing is a live option.   │
  └────────────────────────────────────────────────────────┘
```

Next: `02-scope-cuts-and-non-goals.md`.
