# The problem brief

The discipline here is to state the problem so a reviewer can tell, line by line, what you *know* from what you *assume*. Most problem pitches blur the two and collapse the moment someone asks "how do you know?" This brief keeps them separate on purpose.

```
  flattr — the problem, decomposed

  WHO          self-powered travelers for whom a hill is a real cost:
               kick-scooter riders, wheelchair / mobility-aid users,
               cargo-bike and stroller commuters, anyone walking who
               wants to avoid a climb

  WHAT PAIN    mainstream routers optimize for FAST (distance/time).
               The shortest route over a steep hill is the WORST route
               if you're pushing a scooter or a chair. There's no
               mainstream "flattest comfortable route" mode.

  THE PREMISE  routing can optimize for grade-effort instead of
               distance, off one knob — userMax, the steepest uphill
               you'll accept — and downhill should be free, not just
               un-penalized (direction matters).
```

## 1. The user / operational problem

The shortest path and the *most comfortable* path diverge whenever terrain has grade. For someone on foot with full mobility, a hill is a minor cost folded into "time." For a kick-scooter rider, a wheelchair user, or someone pushing a stroller or cargo bike, a steep block isn't a minor cost — it's the difference between a route they'll take and one they won't. Mainstream routing apps don't expose a "flattest" mode; grade is invisible in the product even when the data exists.

## 2. Evidence vs inference — stated plainly

**Evidence (provable from this repo):**
- The technical premise is real and shipped: `features/routing/` implements directional, grade-aware A\* over an elevation-annotated graph, and the route from A→B genuinely differs from B→A because uphill is penalized and downhill is free (`cost.ts`, `graph.ts` `directedGrade`).
- Grade data is obtainable for free at neighborhood scale (OSM via Overpass + Open-Meteo elevation in `pipeline/`).

**Inference (plausible, NOT proven by this repo):**
- That a meaningful number of people actively avoid hills and would switch routers for a flat-first mode. This is reasonable — accessibility and micromobility are real — but there is **no user research, usage data, or market signal in the repo**. Label it inference and don't oversell it.

> Honesty rule applied: the repo establishes that the problem is *technically solvable* and *cheaply prototyped*. It does **not** establish demand. That's the gap, and it's in `05` and in the discovery questions below.

## 3. Why now

Two things are true now that weren't always: free, no-key elevation data (Open-Meteo's Copernicus DEM) and free street data (OSM/Overpass) make a grade-aware router buildable by one person with no data budget — the historical blocker was elevation data cost/access. And micromobility (scooters, e-bikes) and accessibility-aware routing have both grown as categories. Neither is repo-proven demand; both are why the *timing* for a prototype is reasonable.

## 4. Beneficiaries and exclusions

```
  IN SCOPE (who this is for)        OUT OF SCOPE (deliberately not)
  ──────────────────────────       ───────────────────────────────
  pedestrians avoiding hills        car / transit routing (fast wins)
  kick-scooter / e-scooter riders   turn-by-turn voice navigation
  mobility-aid users (flat-first)   multi-modal trip planning
  stroller / cargo-bike commuters   global coverage (it's a neighborhood)
```

The exclusions matter: flattr is explicitly *not* a Google Maps competitor. It does one thing fast routers don't.

## 5. Constraints visible from the repo

- **No data budget:** free tiers only — Open-Meteo (rate-limited, ~90m DEM), Overpass, Nominatim. This shapes everything downstream (caching, degradation).
- **Hand-rolled engine, by mandate:** the project context names "no Valhalla/OSRM/GraphHopper" — the graph work is the point. So the router can't lean on a library's city-scale machinery.
- **Offline-capable client:** no backend, graph ships as a static artifact — a deliberate constraint that rules out a live-updating data story.
- **Single developer, AI-assisted:** scope must fit one person; no team to absorb a large surface.

## Discovery questions (answer before betting real resources)

Because demand is inferred, not proven, these are the questions a responsible investment would answer first:

1. How many people, in a target city, regularly choose routes to avoid grade today (survey / interviews)?
2. Would they switch from their current app for a flat-first mode, or is grade a "nice to have" they won't change habits for?
3. Is the 90m-DEM grade accuracy good enough that the routes feel *right* to a real scooter rider, or does it need finer elevation?
4. Accessibility angle: do mobility-aid users find the routes trustworthy enough to rely on (a wrong "flat" claim is worse than no claim)?

▸ The strongest problem pitch names the gap before the reviewer does. "Here's what I can prove, here's what I'm assuming, here's what I'd discover first."

## One-page summary

**Core claim:** Grade-aware "flattest comfortable" routing is a real, underserved problem for self-powered travelers — and this repo proves it's *technically* solvable cheaply, while being honest that *demand* is inferred, not measured.

- **Who:** scooter riders, mobility-aid users, stroller/cargo commuters, hill-averse pedestrians.
- **Evidence:** directional grade-aware A\* over free elevation data, shipped and working.
- **Inference (not proven):** that enough people would switch for a flat-first mode.
- **Why now:** free elevation + street data make it buildable solo; micromobility/accessibility are growing.
- **Constraints:** free-tier data, hand-rolled engine, offline client, single developer.
- **Before investing:** run the four discovery questions — demand, switching, accuracy, accessibility trust.
