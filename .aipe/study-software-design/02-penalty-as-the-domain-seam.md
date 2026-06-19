# Penalty as the domain seam
### Pure cost function behind an interface / the domain knob — Project-specific design move

## Zoom out, then zoom in

The entire reason flattr exists — "route for flat, not fast" — is one 7-line
function. Here's where it sits.

```
  Zoom out — where the grade product lives

  ┌─ UI layer ───────────────────────────────────────────────────┐
  │  GradeSlider → userMax (one number, the only product knob)    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ userMax flows down
  ┌─ Engine layer (features/routing) ▼───────────────────────────┐
  │  search() ── calls ──► CostFn seam ──► cost.ts                │
  │                                        ★ penalty(g, max) ★    │ ← we are here
  │                                        gradeCostDirected      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ same penalty shape, color side
  ┌─ Display ▼────────────────────────────────────────────────────┐
  │  grade/classify.ts classifyDirected (green/yellow/red/grey)   │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** You know how a sort takes a comparator and *that one function* is
where all the "what does smaller mean" lives? `penalty()` is flattr's
comparator for hills. Everything the product promises — downhill is free,
gentle uphill costs a little, steep uphill costs a lot, over-your-max is
effectively walled off — is encoded in one pure function from `(grade, max)` to
a multiplier. The pattern is **isolate the domain decision behind a clean
interface**: the search engine knows nothing about hills; it just multiplies
edge length by `1 + penalty(...)`.

## Structure pass

**Layers.** Three: the **knob** (`userMax`, set by the slider), the **cost
adapter** (`gradeCostDirected` turning an edge into a routing cost), and the
**curve** (`penalty`, the pure math). The product lives in the curve; the
adapter wires it to the engine's `CostFn` seam.

**Axis — "what does this layer know about grade?"**

```
  One question down the layers: "what does it know about hills?"

  ┌──────────────────────────────────────┐
  │ search() (astar.ts)                  │  → NOTHING. multiplies a number.
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ gradeCostDirected (cost.ts:32)   │  → knows length × (1 + penalty)
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ penalty(g, max) (cost.ts:16) │  → knows the ENTIRE curve shape
          └──────────────────────────────┘

  all the domain knowledge sinks to the bottom function. that's the point.
```

**Seam.** The `CostFn` type (`types.ts:40`) is the contract. Above it, the
engine. Below it, the domain. The trust axis flips: the engine *trusts* the
number; `penalty` is *where the product judgment lives*. Change the comfort
model — say, make it depend on edge surface — and you edit `penalty` (and maybe
its signature), nothing above the seam.

## How it works

### Move 1 — the mental model

The shape is a piecewise curve: flat below zero, linear in the middle,
quadratic when it gets steep, and a cliff at your max.

```
  Pattern — the penalty curve (signed grade → multiplier)

  penalty
    │                                    ╱ BLOCKED (1e9) ── cliff at max
    │                               ___╱  ← quadratic (steep band)
    │                         ___╱        ← continuous at 0.5*max
    │                   ___╱              ← linear (moderate band)
    │  ────────────────╱
    └───────────────────────────────────────────► signed grade g
       g≤0          0 .. 0.5max   0.5max .. max   g>max
       (free)        (linear k1)   (quad k2)      (walled off)
```

Downhill and flat are genuinely free (multiplier 0). The two uphill bands meet
*continuously* at `0.5*max` by construction — no jump. Over `max`, the cost
jumps to `BLOCKED`, a number so large the router treats those edges as
last-resort only.

### Move 2 — the walkthrough

**The curve, band by band.** Bridge from a CSS easing function: same idea, a
number maps to a number through a shaped curve.

```
  penalty(g, max, k1=0.4, k2=1.0):
      if g <= 0:        return 0                       // downhill/flat free
      if g >  max:      return BLOCKED                 // over comfort → walled
      half = 0.5 * max
      if g <= half:     return k1 * g                  // moderate: linear
      else:             return k2 * (g - half)^2       // steep: quadratic
                               + k1 * half             //   + offset → CONTINUOUS
```

The boundary that bites: the `+ k1 * half` offset on the steep branch. Drop it
and the curve *jumps* at `0.5*max` — a 4.9% grade and a 5.1% grade would have
wildly different costs, and the router would make jittery choices near the
boundary. The offset makes the linear and quadratic pieces meet at the same
value. That's the load-bearing line of the function.

**Wiring to the engine — the adapter.** `penalty` returns a *multiplier*, not a
cost. The adapter turns it into a cost the engine can sum:

```
  gradeCostDirected(edge, fromNodeId, userMax):
      g = directedGrade(edge, fromNodeId)     // signed, my direction of travel
      return edge.lengthM * (1 + penalty(g, userMax))
                            └─ length × multiplier; multiplier ≥ 1 always
```

Multiplying by `1 +` (not just `penalty`) guarantees a steep-but-short edge
never costs *less* than a flat edge of the same length — penalty only ever adds.
That's also what keeps the A* heuristic admissible (haversine ≤ real cost).

**One curve, two faces.** The same band structure shows up on the *color* side:
`classifyDirected` (`classify.ts:33`) maps the same `(grade, userMax)` to
green/yellow/red/grey using the same `0`, `0.5*max`, `max` breakpoints. So the
color you see and the cost the router pays come from *one shared mental model*.
This is APOSD self-similarity: name the band structure once, point at both
places it appears (cost and color).

### Move 3 — the principle

When a product has *one* core judgment — here, "how much do I dislike this
hill" — push it into a single pure function with the smallest possible
signature, and put it behind an interface the rest of the system already speaks
(`CostFn`). Then the product is *tunable in one place* and *testable in
isolation*. A pure `(numbers) → number` function is the easiest thing in a
codebase to reason about; making your domain core look like that is a win.

## Primary diagram

The full seam: one knob in, one curve, two consumers.

```
  penalty as the domain seam — full picture

  userMax (slider) ──────────────┬───────────────────────────┐
                                 ▼                            ▼
  ┌─ cost side (routing) ────────────────┐   ┌─ color side (display) ──────┐
  │ gradeCostDirected(edge, from, max)   │   │ classifyDirected(g, max)    │
  │   g = directedGrade(edge, from)      │   │   g≤0      → green           │
  │   return len * (1 + penalty(g,max))  │   │   ≤0.5max  → yellow          │
  │                  │                   │   │   ≤max     → red             │
  │                  ▼                   │   │   >max     → grey            │
  │      ┌── penalty(g, max) ──┐         │   └─────────────────────────────┘
  │      │ ≤0:0  lin  quad  cliff│        │      same breakpoints, one model
  │      └──────────────────────┘        │
  └───────────────┬──────────────────────┘
                  ▼ number
        search() sums it, knows nothing about hills
```

## Implementation in codebase

**Use cases.** Dragging the `GradeSlider` changes `userMax`; the next
`directedAstar` call re-costs every edge through `penalty`, and the route
re-bends to avoid newly-over-max hills (`MapScreen.tsx:52,147`). The heatmap and
route colors re-band through `classifyDirected`/`bandsForUserMax` off the same
number (`MapScreen.tsx:117,121`). One slider, two visible effects, one curve
behind both.

**The curve — `features/routing/cost.ts:16–22`.**

```
  cost.ts  (lines 16–22)

  export function penalty(g, max, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
    if (g <= 0) return 0;                  ← downhill/flat: genuinely free
    if (g > max) return BLOCKED;           ← over comfort: walled (line 5: 1e9)
    const half = 0.5 * max;
    if (g <= half) return k1 * g;          ← moderate band: linear in grade
    return k2 * (g - half) ** 2 + k1 * half;  ← steep: quadratic + offset
  }                                            └─ offset makes it CONTINUOUS at half
       │
       └─ k1, k2 default (line 8–9) so callers never pass them — complexity
          pulled down (audit Lens 5). 7 lines = the whole product.
```

**The adapter — `features/routing/cost.ts:31–33`.**

```
  cost.ts  (lines 31–33)

  export const gradeCostDirected: CostFn =
    (edge, fromNodeId, userMax) =>
      edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
       │              │     │
       │              │     └─ signed grade in MY travel direction (graph.ts:17)
       │              └─ 1 + … so penalty only ever ADDS; keeps heuristic admissible
       └─ multiplier × real length = a cost search() can sum
```

The sibling `gradeCostAbs` (line 28) does the same with `absGradePct` — the
undirected stage of the benchmark progression. Same `penalty`, different grade
input. Two cost models, one curve.

## Elaborate

This is **separation of policy and mechanism** at the function level, and it's
why the audit calls `cost.ts` the second-deepest module. The grade product is
"deep" in the APOSD sense: a tiny interface (`penalty: (number, number) →
number`) over real behaviour (a tuned piecewise curve that makes routing
choices). The `must-not-change` constraint in the project context — "penalty ≥
0, heuristic stays admissible" — is enforced *by the shape of this one
function*: every branch returns ≥ 0, so the constraint can't be violated
without editing these 7 lines.

Read next: `01-parametric-search-over-cost-fns.md` for the engine that calls
this; `05-blocked-as-large-finite.md` for why the over-max branch returns a
number instead of throwing; `03-directed-traversal-over-undirected-storage.md`
for `directedGrade`.

## Interview defense

**Q: Why is the grade logic a separate function instead of inlined in the
search?** Because the product *is* this function. Isolating it means: the
router stays a generic graph search reusable for non-grade routing (Dijkstra,
plain A*); the comfort model is tunable and unit-testable without a graph; and
the same curve feeds the colors, so cost and color can't drift. Inlining it
would weld the product to the algorithm.

```
  inlined (welded)                 vs   isolated (deep seam)
  ┌──────────────────────┐              ┌──────────┐   ┌──────────┐
  │ search + grade math  │              │ search   │──►│ penalty  │
  │ (can't reuse, can't  │              │ generic  │   │ testable │
  │  test grade alone)   │              └──────────┘   │ tunable  │
  └──────────────────────┘                             └──────────┘
```

**Q: What's the load-bearing part people forget?** The `+ k1 * half` offset on
the quadratic branch (`cost.ts:21`). It's what makes the curve continuous at
`0.5*max`. Forget it and routing jitters near the half-max boundary because a
hair more grade costs disproportionately more. Naming continuity-by-construction
signals you actually thought about the curve, not just "linear then quadratic."

**Anchor:** "The whole product is `penalty(g, max)` — 7 lines, pure, behind the
`CostFn` seam. Downhill free, linear, quadratic-and-continuous, then a finite
cliff."

## Validate

1. **Reconstruct:** write `penalty` from memory — four branches, and the offset
   on the last. Check `cost.ts:16–22`.
2. **Explain:** why `1 + penalty(...)` and not just `penalty(...)` in the
   adapter (`cost.ts:33`)? What would a multiplier < 1 break?
3. **Apply:** add a "soft" mode that's twice as forgiving. Which constant, which
   line? (`k1`/`k2`, defaults at `cost.ts:8–9`.)
4. **Defend:** a teammate wants the over-max branch to `throw` instead of return
   `BLOCKED`. Walk them through what the UI loses. (→ `05`.)

## See also

- `01-parametric-search-over-cost-fns.md` — the engine behind the `CostFn` seam.
- `05-blocked-as-large-finite.md` — the over-max branch as a defined-out error.
- `03-directed-traversal-over-undirected-storage.md` — `directedGrade`.
- `audit.md` Lens 2 (deep), Lens 5 (pull complexity down), Lens 6 (errors).
