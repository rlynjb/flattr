# 02 — Penalty as the domain seam

**Industry names:** policy function / domain kernel / information hiding.
**Type label:** Project-specific (the move is universal; the grade model is flattr's).

The entire definition of "flat" — what flattr is *about* — lives in one
five-line function. The search loop never mentions grade.

---

## Zoom out, then zoom in

This is the inner half of the seam `01` introduced. If `01` is "the loop
has a hole," this is "what fills the hole, and why all the domain knowledge
hides inside it."

```
  Zoom out — where the penalty lives

  ┌─ ROUTING CORE ───────────────────────────────────────────────┐
  │  search()  ── costFn ──►  gradeCostDirected   cost.ts:32      │
  │  (grade-blind)               │                                │
  │                              ▼                                │
  │                    ┌──────────────────────┐                   │
  │                    │ ★ penalty(g, max) ★   │  cost.ts:16       │
  │                    │   THE grade model     │  ← we are here    │
  │                    └──────────────────────┘                   │
  └───────────────────────────────────────────────────────────────┘
  ┌─ DISPLAY (parallel users of the same idea, NOT the same fn) ──┐
  │  classifyDirected  classify.ts:33   (color bands, mirrors curve)│
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **domain kernel** — the one function that
encodes the product's core decision, with everything else deferring to
it. You've done this whenever you put all your validation rules in one
`validate()` and let the form, the API, and the test all call it instead
of re-deriving "is this valid." Here the rule is "how much should an
uphill grade cost," and `penalty()` is the single home for it.

---

## Structure pass

**Layers.** Cost function (outer, `gradeCostDirected`) → penalty kernel
(inner, `penalty`). The cost function knows about *edges and length*; the
penalty knows about *grade percentages and the user's max*. Clean split.

**Axis held constant — "where is the grade curve defined?"**

```
  "where does the shape of 'flat' live?" — trace down

  ┌────────────────────────────────────┐
  │ search()        astar.ts:22         │  → not here (grade-blind)
  └────────────────────────────────────┘
      ┌────────────────────────────────┐
      │ gradeCostDirected  cost.ts:32  │  → not here (just multiplies length)
      └────────────────────────────────┘
          ┌────────────────────────────┐
          │ penalty()       cost.ts:16 │  → HERE. the whole curve.
          └────────────────────────────┘
```

**Seam.** `gradeCostDirected │ penalty`. The cost function knows
*nothing about the curve* — it just does `length * (1 + penalty(...))`.
Swap the curve (different bands, different steepness math) and the cost
function, the search, and the callers all stay put. That's the
information-hiding win the audit praises (lens 3).

---

## How it works

### Move 1 — the mental model

The shape: a piecewise function of one signed number. Below zero, free.
Above the user's max, a wall. In between, a curve that bends from gentle
to punishing. Like a tax bracket — flat regions and a progressive ramp —
except the "wall" at the top is finite on purpose (`05`).

```
  Pattern — the penalty curve over signed grade g

  penalty
    │                                   ┌── BLOCKED (1e9) for g > max
    │                              ___/
    │                         __/   ← quadratic (steep band)
    │                    __/
    │              ___/        ← linear (moderate band)
    │     ________/
    │____/______________________________________________ g
    │ downhill/flat   0.5*max        max
    │  (penalty 0)
```

### Move 2 — the walkthrough

**The kernel — five lines, two parameters.** `cost.ts:16-22`:

```ts
// features/routing/cost.ts:16-22
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;                       // downhill/flat: free
  if (g > max) return BLOCKED;                // over the user's max: wall (finite, see 05)
  const half = 0.5 * max;
  if (g <= half) return k1 * g;               // moderate band: linear
  return k2 * (g - half) ** 2 + k1 * half;    // steep band: quadratic, offset to stay continuous
}
```

**Part 1 — the free case.** `if (g <= 0) return 0`. Bridge: this is the
single decision that makes flattr "optimized for flat, not fast" — a
descent or a level edge adds *no* penalty, so the router will happily
take a longer flat path over a shorter steep one. Remove this line and
downhill stretches start costing something and the whole product
character changes.

**Part 2 — the wall.** `if (g > max) return BLOCKED`. An edge steeper
than the user can stand costs a billion. **Boundary condition:** it's
finite, not `Infinity` — that's a whole pattern (`05`), and it's why a
steep-only route still returns rather than reporting "no route."

**Part 3 — the two bands, joined continuously.** Below `0.5*max`: linear
(`k1*g`). Above: quadratic, but offset by `+ k1*half` so the two pieces
*meet* at `g = half`. Check it: at `g = half`, linear gives `k1*half`;
quadratic gives `k2*0 + k1*half = k1*half`. Equal. **The boundary
condition the comment at `cost.ts:13-15` names: C⁰ continuity by
construction.** Drop the `+ k1*half` offset and the cost jumps
discontinuously at the band edge, which would make routes flip
erratically as a grade crosses `0.5*max`. The offset is load-bearing.

**The cost function just wraps it.** `cost.ts:32-33`:

```ts
// features/routing/cost.ts:32-33
export const gradeCostDirected: CostFn = (edge, fromNodeId, userMax) =>
  edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
```

`length * (1 + penalty)` — a flat edge costs its real length (penalty 0
→ ×1), a steep edge costs a multiple. The cost function knows *length*
and *direction* (via `directedGrade`, see `03`); it delegates the entire
"how bad is this grade" question to `penalty`. That delegation is the
seam.

**The abs variant shares the kernel.** `gradeCostAbs` (`cost.ts:28`) calls
the *same* `penalty` with `absGradePct` instead of the directed grade —
symmetric, A→B equals B→A. Two cost functions, one curve. If you change
the curve, both move together correctly *because* they share the kernel.

**Where the seam is honored vs mirrored — an honest note.** The display
layer has its *own* grade classifier, `classifyDirected` (`classify.ts:33`),
with the same band structure (`0`, `0.5*max`, `max`). That's not a leak —
it's a deliberately separate concern (color, not cost) — but it does mean
the band *boundaries* (`0.5*userMax`, `userMax`) appear in two places.
They agree today. If you ever retune where the steep band begins, you'd
touch both `cost.ts:20` and `classify.ts:36`. Worth a shared constant if
the bands ever diverge from the curve; not urgent today.

### Move 3 — the principle

Find the one decision your product is *about* and give it exactly one
home. Everything else — search, rendering, summaries — should *ask* that
home rather than re-encode the rule. The test: when the product
definition changes ("actually, gentle downhills should cost a little to
discourage detours"), you should edit one function, run its unit test,
and be done. flattr passes that test for the cost curve.

---

## Primary diagram

The seam and the kernel together.

```
  Penalty as the domain seam — full recap

  ┌─ search() astar.ts:22 ──────────────────────────────┐
  │  grade-blind; calls costFn(edge, from, userMax)      │
  └──────────────────────┬───────────────────────────────┘
                         │ costFn
  ┌─ cost.ts:32 gradeCostDirected ──────────────────────┐
  │  length * (1 + penalty(directedGrade(edge,from),max))│
  └──────────────────────┬───────────────────────────────┘
                         │ delegates the whole curve to:
  ┌─ cost.ts:16 penalty(g, max) — THE domain kernel ────┐
  │   g≤0      → 0           (free downhill/flat)         │
  │   g>max    → BLOCKED     (finite wall, see 05)        │
  │   g≤½max   → k1·g        (linear moderate)            │
  │   else     → k2(g-½max)²+k1·½max  (quadratic steep,   │
  │                                    continuous at ½max)│
  └──────────────────────────────────────────────────────┘
```

---

## Elaborate

This is information hiding (Parnas, 1972) at its purest: the module that
hides the decision most likely to change. Ousterhout's framing is "design
for the change you expect" — and the grade curve is *exactly* the thing a
routing product re-tunes constantly (different vehicle classes, different
comfort models). Putting it behind one function means those re-tunings
are local. The piecewise-with-continuity construction is standard cost-
shaping (you see it in RL reward design, in image-processing tone curves);
the offset-to-stay-continuous trick is the part people forget, and it's
the thing that keeps the optimizer from oscillating.

---

## Project exercises

### EX-02-A — Make the penalty curve a parameter

- **What to build:** extract the curve into a `PenaltyModel` object
  (`{ free, blocked, band1, band2 }`) so a caller can pass a different
  model without editing `penalty`.
- **Why it earns its place:** turns the kernel into a swappable strategy
  (composes with `01`) and forces you to find every place the band
  boundaries are assumed.
- **Files to touch:** `features/routing/cost.ts`, its test.
- **Done when:** a test routes with a custom model and the default path
  is unchanged.
- **Estimated effort:** 1 hr.

### EX-02-B — Prove C⁰ continuity is load-bearing

- **What to build:** a property test sweeping `g` across `0.5*max` and
  asserting `penalty` has no jump; then a second test that *removes* the
  `+ k1*half` offset and shows the jump appears.
- **Why it earns its place:** makes the most-forgotten line in the kernel
  visible as the thing that prevents route oscillation.
- **Files to touch:** `features/routing/cost.test.ts`.
- **Done when:** both tests pass/fail as designed.
- **Estimated effort:** 45 min.

---

## Interview defense

**Q: Why is the grade logic in its own function instead of inline in the
cost calculation?**

Because the grade curve is the single most-tuned thing in a routing
product, and inlining it spreads that decision across every call site.
One function means re-tuning is one edit plus one unit test. The cost
function (`gradeCostDirected`) stays a one-liner that just multiplies
length by `(1 + penalty)` — it doesn't need to know the curve has bands.

```
  the forgettable part: continuity at the band seam

  at g = ½max:  linear → k1·½max
                quad   → k2·0 + k1·½max  = k1·½max   ✓ equal
  drop the +k1·½max offset → discontinuity → routes oscillate
```

**Q: Why bands at all — why not just linear?** A linear penalty treats a
6% and a 12% grade as merely "twice as bad," but a 12% pitch is
*disproportionately* worse for self-powered travel. The quadratic steep
band encodes "it gets bad fast near your limit." It's a modeling choice,
and isolating it in `penalty` means it's the only place you'd revisit if
that model is wrong.

**Anchor:** "The whole definition of 'flat' is five lines in
`cost.ts:16` — and the offset that keeps the two bands continuous is the
line people forget."

---

## See also

- `01-parametric-search-over-cost-fns.md` — the loop that calls this.
- `03-directed-traversal-over-undirected-storage.md` — `directedGrade`,
  the input to the directed cost.
- `05-blocked-as-large-finite.md` — why the `g > max` wall is finite.
- `audit.md` lens 3 (info hiding praise), lens 5 (the k1/k2 knob).
