# flatr — spec

> Routing for people who travel by their own effort. Optimized for flat, not fast.

Working name: `flatr` (flat-router). Placeholder — rename freely.

---

## 1. Problem

Google Maps minimizes distance/time and hides per-block grade inside a smoothed
elevation curve. Tools that *do* expose grade (e.g. AccessMap) use fixed
pedestrian thresholds and aren't tuned to how the rider actually travels.

A kick-scooter commuter and a walker-avoiding-hills have the same unmet need:
**a route that avoids what *they* can't comfortably climb, and a map that shows
where the flat is at a glance.**

## 2. Differentiator

Two features that reinforce each other:

1. **Grade-aware router** — A → B that penalizes steep segments instead of just
   minimizing distance.
2. **Grade heatmap** — the map tinted green / yellow / red by grade, so flat
   reads instantly and steep is visible *before* committing.

The wedge vs. existing tools: **personalization by a user-set max grade.** Same
slider for everyone; each user sets where "red" begins. A kick scooter's red
starts far lower than a hiker's. Everything (router cost + map colors) keys off
that one number.

## 3. Users

| User | Needs |
|---|---|
| Kick-scooter / push commuter | Routes they can kick without walking the steep blocks |
| Pedestrians avoiding hills | Flat walking routes (older adults, fatigue, heat) |
| Wheelchair / stroller / rolling-luggage | Hard grade ceiling, non-negotiable |

One slider serves all three; only the threshold differs.

---

## 4. Data model (canonical)

Everything routes off a **grade-annotated graph**. Build it once per city,
offline; the app only reads it.

```
City
 └─ Graph
     ├─ Node          (intersection / path vertex)
     │    id, lat, lng, elevation_m
     │
     └─ Edge          (a walkable/rollable segment between two nodes)
          id, from_node, to_node,
          geometry: [lat,lng][],        // polyline
          length_m,
          rise_m,                        // elev(to) - elev(from)
          grade_pct,                     // rise_m / length_m * 100  (signed, from->to)
          abs_grade_pct,                 // |grade_pct|  (steepness; overview heatmap only)
          surface?, kind?                // sidewalk | footway | residential ...
```

```ts
type Node = {
  id: string;
  lat: number;
  lng: number;
  elevationM: number;
};

type Edge = {
  id: string;
  fromNode: string;
  toNode: string;
  geometry: [number, number][]; // [lat, lng]
  lengthM: number;
  riseM: number;        // signed, direction from->to
  gradePct: number;     // signed, direction from->to (reverse traversal negates it)
  absGradePct: number;  // |gradePct| — steepness only, for the overview heatmap
  kind?: "sidewalk" | "footway" | "residential" | "path" | "crossing";
};

type Graph = {
  city: string;
  bbox: [number, number, number, number]; // minLng,minLat,maxLng,maxLat
  nodes: Record<string, Node>;
  edges: Edge[];
  adjacency: Record<string, string[]>; // nodeId -> edgeIds incident to it (A* derives direction)
};
```

**Grade is the derivative of elevation.** For an edge:
`grade_pct = (elev(to) - elev(from)) / length_m * 100`. Long edges should be
**split** at sampled points so a single edge doesn't average away a short steep
pitch (this is the accuracy crux — see §11).

**Zones (v3, derived not stored raw):** area shading is computed *from* edges,
not a separate source. Tile the bbox into a grid; each cell's color = aggregate
(e.g. 85th-percentile `absGradePct`) of edges intersecting it.

---

## 4.1 Direction — grade is signed by travel direction

A segment isn't steep in the abstract; it's steep *the way you're going*. The
same edge is a descent one way and a climb the other.

- Edges are stored **once** (undirected geometry) with a signed `gradePct`
  measured `from -> to`.
- Traverse **forward** (from->to): `directedGrade = +gradePct`.
- Traverse **reverse** (to->from): `directedGrade = -gradePct`.
- A* already expands directionally, so it computes `directedGrade` at each
  expansion. No duplicate edge records needed (see fork F to materialize two).

```ts
// direction-aware grade at traversal time
function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
}
```

Rule (your call):
- **Downhill / flat → easy (green), free to route.**
- **Uphill → moderate (yellow) or steep (red) by magnitude.**
- Uphill beyond `userMax` → impassable.

So routing cost and route coloring use **`directedGrade`** (signed). The
standalone overview heatmap — where there's no travel direction yet — uses
**`absGradePct`** (pure steepness). One graph, two readings.

---

## 5. Architecture

Two phases: a **build-time pipeline** (heavy, offline, run rarely) and a
**thin runtime** (reads the prebuilt graph).

```
BUILD TIME (offline Node script, per city)
────────────────────────────────────────────────────────────
[OSM extract]      [Elevation source]
  walk/bike net      DEM tiles / API
      │                   │
      ▼                   │
 parse to nodes+edges     │
      │                   ▼
      ├──────────► sample elevation at every node
      │                   │   (+ split long edges, resample)
      ▼                   ▼
 compute length, rise, grade per edge
      │
      ▼
 build adjacency  ──►  graph.json  +  tiles/  ──►  [Netlify Blobs]


RUN TIME (Next.js on Netlify)
────────────────────────────────────────────────────────────
 client (MapLibre GL)
   │  fetch graph/tiles for bbox  ◄── Blobs (via API route)
   │
   │  render segments colored by absGradePct  (heatmap)
   │
   │  A→B request ──► A* over grade-weighted graph
   │                    (client-side for MVP, see fork D)
   ▼
 draw route + per-segment color + "honesty" notes
```

Build-time vs. runtime split matches the solo-dev principle: no live DB, no
server state. The graph is a static artifact in Blobs; the app is mostly static
+ one or two functions.

---

## 6. Routing algorithm (the core)

Grade-weighted **A\*** over the graph. Cost is distance inflated by a grade
penalty that climbs sharply as a segment approaches the user's max.

```
cost(edge, fromNode, userMax) =
    edge.lengthM * (1 + penalty(directedGrade(edge, fromNode), userMax))

penalty(g, max):                    // g is the SIGNED directed grade
    if g <= 0:        return 0                                  // downhill/flat: free
    if g <= 0.5*max:  return k1 * g                             // moderate uphill: linear
    if g <= max:      return k2 * (g - 0.5*max)^2 + k1*0.5*max  // steep uphill: quadratic
    else:             return BLOCKED                            // uphill exceeds max

heuristic(node, goal) = haversine(node, goal)     // admissible (penalty >= 0, so flat dist is a lower bound)
```

- `BLOCKED` = very large constant, *not* infinity — so if the *only* path
  exceeds max, the router still returns it and flags it honestly (§ "honesty").
- `k1`, `k2` tunable; quadratic in the red band makes the router strongly prefer
  a longer gentle detour over a short steep pitch — exactly the Summit/Melrose
  zig-zag a local would pick.
- Direction is first-class: the same segment is **free downhill, penalized
  uphill**, so A* naturally prefers routes that descend or stay flat. Cost
  depends on which way you traverse it, so the expansion passes `fromNode`.
- Optional (off by default, fork G): a mild penalty for *very* steep descents,
  for brake/control comfort on a kick scooter.

## 7. Grade classification (colors)

All derived from the single `userMax`. Classification takes the **signed
directed grade**, so the same edge is green one way and red the other:

```
direction / band   directedGrade range     color   routing
──────────────────────────────────────────────────────────────
downhill or flat   g <= 0                   green   free
moderate uphill    0      .. 0.5*max        yellow  mild penalty
steep uphill       0.5*max .. max           red     heavy penalty
too steep uphill   g > max                  grey    blocked (fallback only)
```

- **Route segments** color by `directedGrade` — the direction you actually
  travel them. A loop shows green going down, red coming back up.
- **Overview heatmap** (no route, no direction) colors by `absGradePct`
  (steepness), since you don't yet know which way anyone's going.
- Optional: carve a gentle-uphill green band (e.g. `g <= 0.2*max`) if pure
  "any uphill = yellow" feels too aggressive. Tunable, same single knob.

Defaults for `userMax` by preset (user can override the slider):

| Preset | userMax (abs grade) |
|---|---|
| Kick scooter | ~5% |
| Walking (avoid hills) | ~8% |
| Wheelchair / strict | ~5% (ADA ramp max) |
| Walking (don't care) | ~15% |

---

## 8. Tech stack

Built on the standard solo stack, plus map + geo pieces:

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) |
| UI | React + Tailwind |
| Language | TypeScript (strict) |
| Map render | MapLibre GL JS (open, no token) — see fork B |
| Deploy | Netlify |
| Storage | Netlify Blobs (prebuilt graph + tiles, per city) |
| Build pipeline | standalone Node/TS script (not deployed; run locally) |
| Routing | hand-rolled A* in TS — see fork D |

No LLM layer in v1. (A natural later add: a "describe my route" or
natural-language destination parse — out of scope now.)

## 9. Directory structure (feature-first)

Tags: `[GRAPH]` = your hand-rolled graph code (the point of the project).
`[LIB]` = third-party plumbing you consume, don't build. `[GLUE]` = thin wiring.

```
flatr/
  app/
    page.tsx                 # [GLUE] map + search UI (thin wrapper)
    api/
      graph/route.ts         # [GLUE] serve graph/tiles for a bbox from Blobs
      route/route.ts         # [GLUE] (optional) server-side A* entry — fork D
  features/
    map/                     # [LIB]   MapLibre setup, layers, color scale
    routing/
      graph.ts               # [GRAPH] Graph struct, adjacency, directed traversal
      astar.ts               # [GRAPH] grade-weighted A* (frontier, g/f, reconstruct)
      pqueue.ts              # [GRAPH] binary-heap priority queue (hand-rolled)
      cost.ts                # [GRAPH] penalty() over signed directed grade
      alternatives.ts        # [GRAPH] k flattest/shortest/balanced routes (v2+)
      bidirectional.ts       # [GRAPH] bidirectional A* for speed (stretch)
      types.ts               # [GRAPH] Node, Edge, Graph (co-located)
    grade/
      classify.ts            # [GRAPH] signed directed grade -> band -> color
      zones.ts               # [GRAPH] roll per-edge grade up into area cells (v3)
      slider.tsx             # [GLUE]  userMax control + presets
  pipeline/                  # BUILD-TIME ONLY, not shipped
    osm.ts                   # [LIB]   parse OSM extract (osmium/overpass) -> raw ways
    elevation.ts             # [LIB]   sample DEM/API for point elevations
    split.ts                 # [GRAPH] split long edges, resample, build nodes/edges
    grade.ts                 # [GRAPH] compute signed per-edge grade
    build-graph.ts           # [GRAPH] assemble graph + adjacency -> graph.json -> Blobs
  lib/
    geo.ts                   # [GLUE]  haversine, bbox, polyline math
```

Everything tagged `[GRAPH]` is yours — that's roughly two-thirds of the modules
and ~all of the hard logic. The `[LIB]` set is deliberately small: render the
map, read the streets, read the elevation. You never write a renderer, a tile
server, or a routing engine.

---

## 10. Build plan (phased)

**Phase 0 — pipeline + ground truth.**
Pick a small bbox (suggest: downtown + Capitol Hill, your actual commute area).
OSM walk network → elevation → grade-annotated graph. Validate grade output
against AccessMap / a phone clinometer spot-check on Pine St. *No app yet.*
Done when: `graph.json` exists and grades look right on known-steep blocks.

**Phase 1 — heatmap only.**
MapLibre map rendering edges colored by `absGradePct` (fixed thresholds first).
Ship the visual. Done when: you can see green/yellow/red Seattle on screen.

**Phase 2 — grade-aware routing.**
A→B with the A* + `userMax` slider. Draw the route, color its segments.
Done when: Pike Place→Broadway returns a gentler path than the straight Pine line.

**Phase 3 — honesty + zones.**
"Flattest available, still has 1 steep block" messaging when no clean route.
Add the green/yellow/red **zone** choropleth (derived from edges).

**Phase 4 — generalize.**
Vehicle presets, multi-city pipeline, saved routes.

---

## 11. Open decisions (pick or correct)

**A. Elevation source** — the make-or-break for accuracy.
- (1) Free DEM (SRTM/30m): easy, but 30m smooths short steep pitches → bad for
  exactly the blocks you care about.
- (2) USGS 3DEP / LIDAR (1m, Seattle has coverage): best accuracy, heavier
  pipeline.
- (3) Google Elevation API: decent, simple, but rate limits + cost + ToS.
- *Lean: (2) for Seattle MVP since it's the differentiator; (3) as a fast bootstrap.*

**B. Map renderer**
- (1) MapLibre GL (open, free, no token) — *lean.*
- (2) Mapbox GL (nicer defaults, needs token + billing).

**C. Edge splitting granularity**
- How short to resample long edges (e.g. every 10m vs 25m). Finer = truer steep
  pitches, bigger graph. *Lean: 10–15m in hilly areas.*

**D. Routing location** — note: *hand-rolled A* either way* (locked, see §14).
- (1) Client-side A* over a downloaded bbox graph: no server state, fits
  serverless; cost = graph download size. *Lean for MVP* (small bbox).
- (2) Server-side A* in an API route, graph cached from Blobs: scales to bigger
  cities; cold-start + memory cost.

**E. MVP scope**
- (1) Single small bbox (your commute) — *lean, ships fastest.*
- (2) All of Seattle up front.

**F. Directed edges: derive vs materialize**
- (1) One undirected edge, derive `directedGrade` at traversal (DRY) — *lean.*
- (2) Materialize two directed edges per segment (explicit, simpler A* loop,
  ~2x graph size).

**G. Steep-descent penalty**
- (1) Downhill always free (your rule) — *lean / default.*
- (2) Mild penalty for very steep descents (brake/control comfort on a scooter).

---

## 12. Risks / honest caveats

- **Grade accuracy is the whole product.** Coarse elevation = a map that lies
  about the steep blocks, i.e. worse than nothing. Decision A is load-bearing.
- **No flat route sometimes exists.** Capitol Hill has no gentle approach from
  downtown. The router must say so, not fake it. (`BLOCKED` as large finite, not
  infinite, + a flag.)
- **Graph size in Blobs.** A full-city walk graph at 10m resampling is large;
  tile it, or keep MVP to a bbox.
- **Overlap with AccessMap.** A generic grade map duplicates it. The
  personalized `userMax` + point-to-point router + self-powered framing is what
  makes `flatr` its own thing — keep that front and center.

## 13. Out of scope (v1)

Turn-by-turn voice nav, live traffic, transit integration, crowdsourced
hazards, accounts/sync, the LLM destination parser. All later.

---

## 14. Graph algorithm core (the centerpiece — hand-rolled, no engine)

**Decision (locked): build the graph and the router yourself.** No Valhalla /
GraphHopper / OSRM. Those would reduce `flatr` to tuning someone else's cost
weights and hide the graph behind a config file. The whole point is the graph
work, so the only third-party code is map render + raw data I/O (§9 `[LIB]`).

### 14.1 What "graph work" means here

| Module | Graph problem |
|---|---|
| `pipeline/split.ts` | mesh construction: ways → nodes/edges, split long edges, dedupe shared vertices |
| `routing/graph.ts` | adjacency representation, directed traversal over undirected storage |
| `routing/pqueue.ts` | binary-heap priority queue (decrease-key or lazy-delete) |
| `routing/astar.ts` | A*: frontier, g/f scores, came-from, path reconstruction |
| `routing/cost.ts` | domain cost: signed directed-grade penalty |
| `routing/alternatives.ts` | k-shortest / plateau or penalty method for distinct routes |
| `routing/bidirectional.ts` | bidirectional A* with a consistent heuristic (stretch) |
| `grade/zones.ts` | spatial aggregation: edges → grid cells (union/bucketing) |

### 14.2 A* core (sketch)

```ts
// astar.ts — grade-weighted, direction-aware
function aStar(graph: Graph, startId: string, goalId: string, userMax: number): Path | null {
  const open = new PQueue<string>();              // your binary heap, keyed by f
  const g = new Map<string, number>();            // best known cost to node
  const came = new Map<string, { edge: Edge; prev: string }>();

  g.set(startId, 0);
  open.push(startId, heuristic(graph.nodes[startId], graph.nodes[goalId]));

  while (!open.isEmpty()) {
    const current = open.pop();
    if (current === goalId) return reconstruct(came, goalId);

    for (const edgeId of graph.adjacency[current]) {
      const edge = edgeById(graph, edgeId);
      const next = otherEnd(edge, current);                 // directed step
      const step = cost(edge, current, userMax);            // uses directedGrade
      const tentative = g.get(current)! + step;

      if (tentative < (g.get(next) ?? Infinity)) {
        g.set(next, tentative);
        came.set(next, { edge, prev: current });
        const f = tentative + heuristic(graph.nodes[next], graph.nodes[goalId]);
        open.pushOrDecrease(next, f);
      }
    }
  }
  return null; // disconnected — distinct from "exists but steep" (see 14.4)
}
```

`cost()` and `directedGrade()` are defined in §6 / §4.1. `heuristic` is
haversine straight-line distance: admissible because the per-meter penalty is
`>= 0`, so flat distance never overestimates true cost.

### 14.3 Things to get right (the actual graph rigor)

- **Heuristic admissibility.** Cost is `length * (1 + penalty)`, penalty `>= 0`,
  so `cost >= length`. Straight-line distance `<= true path length`, so it never
  overestimates → A* stays optimal. If you ever scale the heuristic up for
  speed, you trade optimality (weighted A*); decide knowingly.
- **Priority queue.** Start with lazy-deletion (push duplicates, skip stale
  pops) — simplest correct heap. Upgrade to decrease-key only if profiling says.
- **Node identity.** Snap coincident vertices in `split.ts` or you get a
  disconnected graph (two "same" corners that don't share a node — classic
  mesh-construction bug).
- **Edge splitting is graph-shaping.** Where you split changes both grade
  fidelity and the node set the router can turn at. It's not just preprocessing.

### 14.4 Honest fallback (a graph problem, not a UI patch)

"Flattest route" and "route exists at all" are different graph queries:

1. Run A* with `userMax`. If it returns a path with no edge over `userMax`, done.
2. If every path crosses a too-steep edge, A* still returns one (because
   `BLOCKED` is large-finite, not `Infinity`) — flag the offending segments.
3. `null` only when the graph is genuinely **disconnected** between A and B.

So you distinguish "no flat way" (steep flagged) from "no way" (disconnected) —
two real graph states, surfaced honestly.

### 14.5 Stretch graph goals (if you want more surface area)

- **Bidirectional A\*** — search from both ends; needs a consistent heuristic
  and a correct meeting-point stopping rule. Good, classic graph difficulty.
- **k alternative routes** — flattest vs shortest vs balanced, via the penalty
  method (inflate cost of already-used edges and re-run) or plateau detection.
- **Contraction hierarchies / A\* landmarks (ALT)** — real speedup techniques
  for big graphs; substantial graph-theory depth if you want to go there.
- **Zone aggregation** — `grade/zones.ts` rolls per-edge grades into grid cells;
  a spatial-bucketing + summary problem, and the basis for the area heatmap.

> Build order for the graph centerpiece: `pqueue` → `graph`/adjacency →
> plain Dijkstra (sanity) → add heuristic to make it A* → add the grade cost →
> add directional cost → alternatives/bidirectional as stretch.

---

## 15. Portfolio framing + benchmarkable algorithm progression

### 15.1 How to position it (honest, not overclaimed)

This is the same machine Google Maps / Uber / delivery routers run: a weighted
directed graph + shortest-path, where the intelligence is the **cost function**,
not the search. Same skeleton, novel weights (directional grade-effort).

- **Pitch:** "A routing engine built from the graph up — custom A* with a
  domain-specific *directional* cost function, plus the speedup techniques
  production routers use — to learn how Maps/Uber-class routing actually works."
- **Don't say:** "I built Google Maps." The DSA depth is real; the *scale*
  (billions of edges, sub-ms, live traffic, distributed serving) is scoped.
  Name the gap before a reviewer does — it reads as senior, not as a weakness.
- **The senior signal** here isn't "it works," it's that you can *reason* about
  it: invariants, optimality, edge cases (see 15.3). That beats "I configured a
  library" by a wide margin.

### 15.2 The progression IS the story (benchmark it)

Implement shortest-path in stages and **measure each**. The progression shows
you understand not one algorithm but *why each refinement exists* — the exact
thing that separates DSA depth from a single trick.

```
stage            algorithm             what it proves            metric to show
──────────────────────────────────────────────────────────────────────────────
1  baseline      Dijkstra              correct shortest path     nodes expanded, ms
2  informed      A* (haversine h)      heuristics prune search   nodes expanded ↓, ms ↓
3  domain        A* + grade cost       cost modeling, optimality same correctness, new routes
4  directional   A* + signed grade     directed graphs           A→B ≠ B→A (show both)
5  speedup       bidirectional A*      meet-in-middle search      nodes expanded ↓↓
6  scale (opt)   contraction hier.     preprocessing for speed    query ms ↓↓↓ (vs 1)
```

Each stage is independently testable and returns the **same optimal path** as
Dijkstra on stages 1–3 (that's your correctness gate). The win shows up as
*fewer nodes expanded* and *lower query time* for the same answer.

### 15.3 The benchmark harness (a real artifact)

```
bench/
  fixtures.ts     # [GRAPH] fixed (start, goal) pairs across the bbox
  run.ts          # [GRAPH] run each algorithm, record metrics
  report.ts       # [GLUE]  table/chart: nodes expanded + ms per algorithm
```

Per (start, goal) pair, per algorithm, record: **nodes expanded**, **queue
push/pop count**, **wall-clock ms**, **path cost** (must match Dijkstra's for
the optimal ones). Output a comparison table — that table is a portfolio
centerpiece, concrete proof the refinements pay off.

```
A* vs Dijkstra, Pike Place → Broadway:
  Dijkstra        expanded 4,812   12.3 ms   cost 1.000x
  A*              expanded 1,107    3.1 ms   cost 1.000x   (same path, 4.3x less work)
  bidirectional   expanded   631    1.9 ms   cost 1.000x
```
*(illustrative numbers — yours come from the harness.)*

### 15.4 Make the search visible (you're visual-first)

Render **which nodes each algorithm expanded** on the map — Dijkstra floods
outward in a circle, A* drives a narrow cone toward the goal, bidirectional
grows two cones that meet. One screenshot communicates "I understand
heuristics" faster than any paragraph, and it's a genuinely compelling demo.

### 15.5 What to write up (the README / case study)

1. Problem (self-powered travel, grade matters, direction matters).
2. Model (graph + directional cost) — with the ASCII from §4 / §6.
3. Algorithm progression + the benchmark table (15.2 / 15.3).
4. A correctness argument: heuristic admissibility, optimality, node-snapping,
   the flat-vs-disconnected distinction (§14.3 / §14.4).
5. Honest limits (scale) + what you'd do for production (CH, tiling,
   live-traffic-style dynamic edge weights).

That structure — problem → model → measured progression → correctness → honest
limits — is the case study reviewers remember.
