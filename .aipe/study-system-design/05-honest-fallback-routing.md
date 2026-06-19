# 05 — Honest Fallback Routing

*Industry names: graceful degradation in pathfinding · soft constraint vs hard
failure · "return the best bad answer, flagged." Type: Project-specific (a
graph-state distinction, not a UI patch).*

---

## Zoom out, then zoom in

You know the difference between a form field that's *invalid but submittable with
a warning* and one that *blocks submit entirely*. flattr makes the same
distinction at the graph level: "there's a route but it has a steep block you
asked to avoid" is a warning, not a failure — and it's a *different graph state*
from "there is no route at all."

Here's where the decision lives — in the cost function and how A\* interprets its
result, then surfaced honestly at the UI:

```
  Zoom out — where the honesty distinction is made

  ┌─ COST LAYER (features/routing/cost.ts) ─────────────────────┐
  │  penalty(): over userMax ⇒ BLOCKED (large FINITE, not ∞)     │ ← we are here
  └────────────────────────────────┬────────────────────────────┘
                                    │  feeds edge cost
  ┌─ SEARCH LAYER (astar.ts) ───────▼───────────────────────────┐
  │  A* returns a path (with steepEdges) OR null (disconnected)  │
  └────────────────────────────────┬────────────────────────────┘
                                    │  path | null + steepCount
  ┌─ UI LAYER (RouteSummaryCard) ───▼───────────────────────────┐
  │  "Flat all the way" · "⚠ Flattest available" · "No route"    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **soft-constraint pathfinding** — a constraint (don't
exceed `userMax`) that the router *prefers* to honor but will *violate and flag*
rather than refuse to answer. The question it answers is *"when the user's
preference can't be met, do you lie, refuse, or tell the truth?"* flattr tells
the truth, and the mechanism is one deliberate choice: `BLOCKED` is a large
finite number, not `Infinity`.

---

## Structure pass

**Layers.** Three, and one value threads through all of them:

```
  cost.ts        — penalty maps grade → cost; over-max ⇒ BLOCKED (1e9, finite)
  astar.ts       — A* sums costs; flags directed-grade > userMax as steepEdges
  RouteSummaryCard — renders the three states from (found, steepCount)
```

**Axis — failure semantics (what does "can't" mean at each layer?).**

| Layer | What "can't comfortably climb" becomes |
|---|---|
| cost | a huge-but-finite penalty (the edge is *expensive*, not *forbidden*) |
| search | a path that A\* still finds (because finite costs are summable) |
| UI | a warning with the steep count, not an error |

The flip that defines the pattern: at the cost layer, "too steep" is *expensive*,
not *impossible*. If it were `Infinity`, A\* would treat an only-steep route as
*no route* — collapsing two distinct truths into one. Keeping it finite is what
keeps "no flat way" separate from "no way."

**Seams.** The load-bearing seam is the boundary between `null` and a `Path`
coming out of A\*. `null` means *genuinely disconnected* — the graph has no edges
linking start to goal. A non-null `Path` with non-empty `steepEdges` means
*connected, but the best route violates your preference*. The UI keys entirely
off which side of that seam the result lands on.

---

## How it works

### Move 1 — the mental model

The shape is a cost ramp, not a wall. As a segment's uphill grade rises toward
your max, its cost climbs — gently at first (linear), then sharply (quadratic) —
and *just past* your max it jumps to a huge value. But "huge" isn't "infinite":
A\* can still add it up and return a route built from huge edges if that's the
only way through. The router strongly prefers gentle detours, but it never
refuses to answer when a route physically exists.

```
  Pattern — the penalty ramp (signed grade → cost multiplier)

  penalty
    │                                  ┌── BLOCKED (1e9, FINITE)
    │                                  │   ← over userMax: a wall you
    │                            ______│      CAN climb if forced
    │                       ____/  quadratic (steep band)
    │                  ____/
    │             ____/  linear (moderate band)
    │  __________/
    └──┴──────────┴──────────┴─────────┴────────► directed grade
      g<=0      0.5*max      max
     (free,    (yellow)    (red)     (grey, blocked-but-finite)
      downhill)
```

### Move 2 — the load-bearing skeleton

The kernel here is small: **one finite constant** and **one flag**. Everything
else is the ramp shape, which is tuning.

#### Kernel part 1 — `BLOCKED` is finite

```
  BLOCKED = 1e9            // large, but a real number
  penalty(g, max):
    if g <= 0:   return 0           // downhill/flat: free
    if g > max:  return BLOCKED     // over max: huge, NOT Infinity
    ... (ramp in between)
```

What breaks if you change `1e9` to `Infinity`: a route that's the *only* way from
A to B but crosses one over-max block would cost `Infinity`. A\* compares
tentative costs with `<`, and `Infinity < Infinity` is false, so that path never
relaxes — A\* returns `null`. The user sees "no route" for a route that exists.
The finite constant is the entire difference between "no flat way" and "no way."
**Load-bearing — this is the part the spec (§14.4) and the project constraints
both call out by name.**

#### Kernel part 2 — the steep flag

```
  while reconstructing the path:
    for each traversed edge:
      if directedGrade(edge, from) > userMax:    // exceeded the preference?
        steepEdges.push(edge.id)                 // flag it, don't hide it
```

What breaks if removed: the route still returns, but the UI can't tell a clean
route from a forced-steep one — it'd show "Flat all the way" over a block you
explicitly can't climb. The flag is what makes the honesty *visible*. Without it
the finite `BLOCKED` would let A\* return the steep route silently — worse than
useless, because it lies.

#### The three states, decided

Put the two kernel parts together and A\*'s output encodes three distinct graph
truths:

```
  Pattern — the three honest states

  directedAstar(graph, start, goal, userMax)
        │
        ├─ path, steepEdges empty   ─► CLEAN     "Flat all the way"        (green)
        │
        ├─ path, steepEdges nonempty ─► STEEP    "⚠ Flattest available,    (yellow)
        │                                          N steep blocks"
        │
        └─ null                      ─► NO ROUTE "No route between points" (red)
```

#### Why the heuristic stays valid through all this

A\* only stays optimal if its heuristic never *overestimates* remaining cost.
flattr's cost is `length * (1 + penalty)` and `penalty >= 0`, so cost is always
`>= length`. The heuristic is straight-line haversine distance, which is always
`<= true path length <= true path cost`. So the heuristic is admissible — it
never overshoots — and A\* returns the genuine optimum, including when the
optimum is a flagged-steep route. The finite `BLOCKED` doesn't break this: it's a
large but finite cost, and the heuristic underestimates it just fine.

```
  Layers-and-hops — how a steep result flows to the user

  ┌─ cost.ts ─────────┐ hop: edge cost   ┌─ astar.ts ─────────────┐
  │ penalty → BLOCKED │ ───────────────► │ A* sums; flags steep    │
  │ (finite)          │                  │ edges; returns Path     │
  └───────────────────┘                  └───────────┬─────────────┘
                                  hop: { found, steepCount, summary }
                                                      ▼
                                          ┌─ RouteSummaryCard ──────┐
                                          │ green / yellow / red     │
                                          └──────────────────────────┘
```

### Move 3 — the principle

A constraint the user *prefers* is not the same as a constraint that's
*physically required* — model the soft one as cost, not as a wall, so the solver
can violate it under duress and report the violation. The one-line mechanism
(finite penalty instead of infinite) preserves the distinction between "I
couldn't satisfy your preference" and "the problem is unsolvable." Conflating
those two is the most common way routing and constraint systems lie to users.

---

## Primary diagram

The whole honesty path, one frame.

```
  Honest fallback routing — full recap

  signed directed grade g, userMax
        │
        ▼
  penalty(g, max)  ──  g<=0: 0 │ g<=0.5max: linear │ g<=max: quadratic │ g>max: BLOCKED(1e9)
        │                                                                      finite!
        ▼
  edge cost = lengthM * (1 + penalty)
        │
        ▼
  A* (admissible haversine h, penalty>=0 ⇒ optimal)
        │
        ├── path + steepEdges=[]      ─► CLEAN
        ├── path + steepEdges=[...]   ─► STEEP-BUT-ROUTABLE (flagged)
        └── null (disconnected)        ─► NO ROUTE
        │
        ▼
  RouteSummaryCard: "Flat all the way" / "⚠ Flattest available · N steep" / "No route"
```

---

## Implementation in codebase

**Use cases.** This fires on every route on Capitol Hill, which is the whole
point: from downtown there's often *no* gentle approach up the hill (spec §12).
The router must return the flattest available path and say "still has 2 steep
blocks" rather than either faking a flat route or refusing. Set a strict
`userMax` (kick-scooter, ~5%) and most uphill routes become flagged-steep; that's
honest, not broken.

**The finite BLOCKED — `features/routing/cost.ts` (lines 5-22).**

```
  export const BLOCKED = 1e9;   // Large but FINITE, so an only-steep path is still returned and flagged.
  ...
  export function penalty(g, max, k1=0.4, k2=1.0): number {
    if (g <= 0) return 0;                       ← downhill/flat: free to route
    if (g > max) return BLOCKED;                ← over max: huge, NOT Infinity (the whole trick)
    const half = 0.5 * max;
    if (g <= half) return k1 * g;               ← moderate uphill: linear
    return k2 * (g - half) ** 2 + k1 * half;    ← steep uphill: quadratic (continuous at half)
  }
       │
       └─ line 5's comment IS the design decision. 1e9 vs Infinity is the
          difference between "no flat way" and "no way" (spec §14.4).
```

**The flag + the optimal-path summary — `features/routing/astar.ts` (lines
110-131).**

```
  export function summarizePath(nodes, edges, userMax, costFn): Path {
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]; const from = nodes[i];
      cost += costFn(edge, from, userMax);            ← total routing cost (incl. any BLOCKED)
      lengthM += edge.lengthM;
      if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax)
        steepEdges.push(edge.id);                     ← flag every over-max edge (kernel 2)
    }
    return { nodes, edges: edgeIds, cost, lengthM, steepEdges };
  }
       │
       └─ steepEdges is the honesty payload. directedGrade (signed by travel
          direction) means a descent is never flagged even on a steep block.
```

**null only when disconnected — `features/routing/astar.ts` (lines 48-77).**

```
  while (!open.isEmpty()) {
    const current = open.pop()!;
    if (current === goalId) return { path: summarizePath(...), ... };  ← found (maybe steep)
    ...relax neighbors with finite costs...
  }
  return { path: null, ... };    ← open emptied WITHOUT reaching goal ⇒ genuinely disconnected
       │
       └─ null is reachable ONLY when the frontier drains before hitting the
          goal — i.e. no edge path exists. A steep-only path never gets here
          because its finite cost keeps it in the running.
```

**The three states rendered — `mobile/src/RouteSummaryCard.tsx` (lines 15-42).**

```
  if (!found || !summary) {
    if (found) return null;                          ← no endpoints yet
    return <Card bad>"No route between those points."</Card>;   ← null path (disconnected)
  }
  const clean = summary.steepCount === 0;
  return <Card ok|warn>
    {clean ? "Flat all the way" : "⚠ Flattest available"}       ← steepEdges empty? clean
    {!clean && `${steepCount} steep block(s) (>${userMax}%)`}    ← surface the violation honestly
    {km} km · +{climb} m climb
  </Card>;
       │
       └─ three branches = three graph states. found=false ⇒ red; steepCount>0 ⇒
          yellow warn; steepCount=0 ⇒ green ok. No state is hidden.
```

The `routeSummary` (`features/routing/summary.ts:11-20`) computes `steepCount`
from `path.steepEdges.length` and `climbM` from positive *directed* rise only —
so the card shows real uphill effort in the travel direction.

---

## Elaborate

This is the soft-constraint vs hard-constraint distinction from constraint
solving and operations research, applied to pathfinding. A hard constraint
removes options from the search space (an edge you literally cannot use — set its
cost to `Infinity` or omit it). A soft constraint penalizes options but leaves
them reachable (a high finite cost). flattr models grade as *soft* because the
product promise is "flattest *available*," and "available" means "return
something real even when it's not ideal." The spec is emphatic about this
(§14.4): the flat-vs-disconnected distinction is "a graph problem, not a UI
patch" — the honesty is baked into the cost constant, not bolted on at the view.

The reason the finite constant works and is correct: A\* relaxes an edge only
when the new tentative cost is strictly less than the known best (`astar.ts:69`).
With `Infinity`, an over-max edge can never improve any node's cost (`Inf < Inf`
is false), so the only-steep path is invisible to the search — indistinguishable
from a missing edge. With `1e9`, the steep path has a finite, comparable,
summable cost; A\* will pick it if and only if nothing cheaper exists, which is
exactly "flattest available."

The one subtlety to respect: `BLOCKED` must stay large enough that any
all-non-steep route always beats any route containing a steep edge. At `1e9` per
steep edge versus a few hundred meters of normal edge cost, that holds with huge
margin for any realistic city graph. If you ever shrank it, a long flat detour
could accidentally cost more than a short steep shortcut and the router would
stop preferring flat — a tuning trap worth knowing.

Read next: `06-elevation-provider-fallback.md` — the *other* honest-degradation
move, where bad elevation data degrades to flat rather than failing the build.

---

## Interview defense

**Q: Why is `BLOCKED` `1e9` and not `Infinity`?**
> Because `Infinity` would erase the difference between "no flat route" and "no
> route at all." A\* relaxes an edge only when a new cost is strictly less than
> the best known — and `Infinity < Infinity` is false, so an over-max edge could
> never be part of any path, and an only-steep route would come back as `null`,
> i.e. "no route." With a large finite `1e9`, the steep route has a real,
> summable cost: A\* returns it if it's the only way and flags the steep blocks.
> `null` then means *only* a genuinely disconnected graph. One constant, two
> honest states.

```
  Infinity: over-max edge never relaxes ─► only-steep route = null = LIE ("no route")
  1e9:      over-max edge has finite cost ─► returned + flagged = TRUTH
```

**Q: How does A\* stay optimal with these penalties?**
> Cost is `length * (1 + penalty)` and penalty is always `>= 0`, so cost is
> always at least the segment length. The heuristic is straight-line haversine
> distance, which is always less than or equal to the true path length, which is
> less than or equal to the true cost. So the heuristic never overestimates —
> it's admissible — and A\* returns the true optimum, including when that optimum
> is a flagged-steep route. The finite `BLOCKED` is just a large cost; it doesn't
> break admissibility.

```
  penalty >= 0  ⇒  cost >= length
  haversine h   <=  length  <=  cost   ⇒  h never overestimates ⇒ optimal
```

**Q: What's the load-bearing part people forget?**
> The steep *flag*. The finite `BLOCKED` makes the steep route *returnable*, but
> without `steepEdges`, the UI can't tell a clean route from a forced one — it'd
> cheerfully say "Flat all the way" over a block you can't climb. The finite
> constant and the flag are a pair: one keeps the route, the other keeps it
> honest.

```
  finite BLOCKED → route survives    steepEdges → route is HONEST
              (need both, or it returns a route that lies)
```

---

## Validate

1. **Reconstruct.** Draw the penalty ramp (free / linear / quadratic / BLOCKED)
   and mark where `BLOCKED` is finite (`cost.ts:5,16-22`). State the three A\*
   output states.
2. **Explain.** Trace why `Infinity` collapses "no flat way" into "no way" using
   the relaxation check at `astar.ts:69`.
3. **Apply.** A kick-scooter user sets `userMax=5` and routes up Capitol Hill
   where every approach exceeds 5%. What does `directedAstar` return, what's in
   `steepEdges` (`astar.ts:126-128`), and what does the card show
   (`RouteSummaryCard.tsx:28-41`)?
4. **Defend.** Justify modeling grade as a soft (finite-cost) constraint rather
   than a hard (omit-the-edge) one, grounded in the product promise and spec
   §14.4. When would a hard constraint be correct instead (hint: wheelchair ADA
   ceiling)?

---

## See also

- `04-tile-merge-stitch.md` — the graph A\* runs over; disconnected seams cause
  the genuine `null` state.
- `06-elevation-provider-fallback.md` — the sibling honest-degradation pattern.
- `00-overview.md` — where routing sits in the runtime.
- `audit.md` §6 (failure handling).
- `.aipe/study-dsa-foundations/` — A\* relaxation, heuristic admissibility,
  optimality proof.
- `.aipe/study-data-modeling/` — signed `gradePct` vs `absGradePct`,
  `directedGrade`.
