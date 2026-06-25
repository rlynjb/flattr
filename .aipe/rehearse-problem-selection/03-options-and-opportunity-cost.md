# Options and opportunity cost

Every problem has more than one response, and "build the thing I already wanted to build" is not automatically the right one. The staff move is to lay the real options side by side — *including doing nothing* — and name what each one costs you, including the cost of the path you picked. A brief that only describes the chosen solution hasn't made a decision; it's rationalized one.

```
  THE OPTIONS — and what each one costs

  A. DO NOTHING
     cost: the problem stays unsolved; but you also don't spend
     weeks on unproven demand. The honest baseline.

  B. WRAP AN EXISTING ROUTER (OSRM/Valhalla/GraphHopper)
     cost: fast to a route; but grade-as-directional-cost fights
     their cost models, AND you learn ~nothing about graph search.

  C. ★ HAND-ROLL A GRADE-AWARE ROUTER  (chosen)
     cost: no city-scale machinery (no contraction hierarchies);
     but you own the cost model AND the algorithm depth.

  D. BUY/USE A GRADE API (e.g. a commercial elevation-routing SDK)
     cost: money + a key + vendor lock; overkill for a prototype
     whose whole point is the build.
```

The chosen option, C, only makes sense once you're honest that its cost — no city scale — is real. The reason it still wins is the project's actual goal, which isn't "ship a routing product" but "demonstrate I can build a real graph engine." For that goal, the opportunity cost of *not* hand-rolling is the entire learning value.

## Option A — Do nothing

The real baseline. Doing nothing costs the unsolved problem, but it also costs zero weeks on demand that isn't proven. For a *product* decision, "do nothing until discovery validates demand" would be defensible. flattr exists because the goal is different — it's a portfolio/learning bet where the build itself is the return — so "do nothing" loses not on the problem's merits but on the project's actual purpose. Naming that distinction is the honest framing.

## Option B — Wrap an existing routing engine

OSRM, Valhalla, and GraphHopper are production routers; bolting flattr's UI onto one would produce routes fast. Two costs sink it for this project. First, technical: the directional grade cost (uphill penalized, downhill free, so A→B ≠ B→A) doesn't slot cleanly into their distance/time cost models — you'd be fighting the engine. Second, and decisive: it removes the entire learning goal. You'd have a routing app and no graph-search depth to show for it.

## Option C — Hand-roll the router (chosen)

Build the engine: a parametric A\* (`features/routing/`) where Dijkstra, A\*, and the grade variants are one function with different cost/heuristic arguments, a lazy-deletion heap, an admissible heuristic proven optimal against a Dijkstra oracle, and a directional cost model. **Opportunity cost, owned:** no contraction hierarchies, no spatial index, so it's neighborhood-scale, not city-scale. For the project's goal — own the algorithm, prove it correct — that cost is acceptable and the alternative (city scale) wouldn't teach more.

## Option D — Buy a grade/elevation routing SDK

A commercial elevation-aware routing SDK would handle grade out of the box. Costs: money, an API key, vendor lock-in, and — same as B — it guts the learning goal. It's the right call for a funded product on a deadline; it's the wrong call for a prototype whose entire point is the build.

## The opportunity cost of the chosen path

Say this part without flinching: choosing to hand-roll means flattr **cannot route across a city today**, and a reviewer who wants a deployable product will see that as a miss. The trade was deliberate — neighborhood scale validates the premise and maximizes the learning, city scale does neither — but the cost is real and the honest brief states it rather than hiding behind "it's a prototype."

▸ Naming the cost of the path you *chose* is more convincing than listing the flaws of the paths you rejected.

## One-page summary

**Core claim:** Four real options existed including *do nothing*; hand-rolling won not because it's the only way to route, but because the project's goal is owning the algorithm — and that makes "wrap a library" and "buy an SDK" lose the entire learning value.

- **A. Do nothing:** honest baseline; loses to the project's learning purpose, not the problem's merits.
- **B. Wrap OSRM/Valhalla:** fast routes, but directional grade fights their cost model and removes the learning goal.
- **C. Hand-roll (chosen):** own the cost model + algorithm depth; cost = no city scale.
- **D. Buy an SDK:** out-of-box grade, but money + lock-in + no learning.
- **Owned cost of C:** can't route city-wide today — deliberate, correctly sequenced after validation.

┃ "Wrapping a library would give me a routing app and no graph-search depth to show for it."
