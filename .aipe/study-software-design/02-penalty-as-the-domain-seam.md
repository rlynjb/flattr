# Penalty as the domain seam

> **Domain isolation / single responsibility / the "knowledge boundary"**
> — Language-agnostic. The "seam where the domain lives" framing is APOSD
> information-hiding applied.

## Zoom out, then zoom in

flattr's entire reason to exist — "optimize for flat, not fast" — is one
idea: penalize uphill grade. The question that decides whether the codebase
is clean or a mess is *where that idea is allowed to live*. flattr's answer:
one file, 33 lines, `cost.ts`. The search loop, the heap, the UI — none of
them know what grade means.

```
  Zoom out — the grade domain is sealed in one box

  ┌─ UI ─────────────────────────────────────────────┐
  │  GradeSlider → userMax (just a number)            │
  └──────────────────────┬─────────────────────────────┘
                         │ userMax
  ┌─ search loop (astar.ts) ──────────────────────────┐
  │  knows: cost = number to minimize                 │  NO grade knowledge
  └──────────────────────┬─────────────────────────────┘
                         │ costFn(edge, from, userMax)
  ┌─ ★ cost.ts ★ ────────▼─────────────────────────────┐
  │  penalty curve · downhill-free · BLOCKED · userMax │ ← THE domain, all here
  └────────────────────────────────────────────────────┘
```

Zoom in: this is **information hiding** in its purest form. The grade model
is the thing most likely to change (different curve, different rider
profile, different bands). APOSD's rule: isolate what changes behind a stable
interface. The interface here is the `CostFn` type; the secret behind it is
the entire penalty model.

## Structure pass

**Layers.** Two, with `cost.ts` as the floor:
- *Above*: `search()` / `bidirectional()` — consume a `number` per edge.
- *The seam*: `CostFn` type (`types.ts:40`).
- *Below*: `cost.ts` — `penalty()` and the three cost functions.

**Axis — "who knows what 'flat' means?"**

```
  axis = "who knows the grade model?"

  GradeSlider  →  search loop  →  cost.ts
  ──────────      ───────────     ───────
  picks a number  minimizes a     KNOWS:
  (userMax)       number          downhill free,
  knows nothing   knows nothing   linear band,
  about curve     about curve     quadratic band,
                                  BLOCKED over max

  all the knowledge sits in ONE box; the rest pass a number through
```

**Seam.** The `CostFn` type is the contract. It promises the search loop one
thing: give me an edge, the node you're leaving from, and the user's max, and
I'll give you back a non-negative number. Everything about *how* that number
encodes "uphill is bad" is hidden. The axis-answer flips hard at this seam —
above it, zero domain knowledge; below it, all of it.

## How it works

### Move 1 — the mental model

Think of a `formatCurrency(amount, locale)` function. The rest of your app
passes around plain numbers; the *one* place that knows about currency
symbols, decimal rules, and thousands separators is that function. Swap it
for a different locale and nothing upstream changes. `cost.ts` is
`formatCurrency` for grade: the rest of the router passes around plain cost
numbers; the one place that knows "uphill is expensive, downhill is free" is
here.

```
  the pattern — knowledge funneled to one point

  many callers ──┐
  (search,       ├──► CostFn seam ──► cost.ts ──► one number
   bidirectional,│         (type)      (the ONLY
   summarizePath)┘                      grade-aware code)
```

In one sentence: **the domain knowledge has exactly one home, and a typed
interface is the only thing that leaves it.**

### Move 2 — the step-by-step walkthrough

#### The penalty curve is the whole domain, in seven lines

```ts
// cost.ts:16-22 — penalty(signedGrade, max), annotated
export function penalty(g, max, k1 = DEFAULT_K1, k2 = DEFAULT_K2) {
  if (g <= 0) return 0;            // downhill or flat is FREE — the core rule
  if (g > max) return BLOCKED;     // over your max → large-finite (pattern 05)
  const half = 0.5 * max;
  if (g <= half) return k1 * g;    // moderate band: linear, gentle
  return k2 * (g - half) ** 2 + k1 * half;  // steep band: quadratic, biting
}
```

Read top to bottom and you've read the entire product philosophy. Downhill is
free (`g <= 0`). A small uphill costs a little (linear). A big uphill costs a
*lot* (quadratic). Past your limit, it's effectively blocked. **What breaks if
this leaks out of `cost.ts`?** The moment a second module re-derives "downhill
is free," the two can disagree — and now `summarizePath` might count an edge
the search loop priced differently. The domain has to have one home or it
desynchronizes.

The continuity detail at `cost.ts:14` ("continuous at the 0.5\*max boundary by
construction") is the kind of decision only a comment can carry: the linear
and quadratic pieces are designed to meet at `half` so there's no cliff at the
band boundary. A reader editing the curve must preserve that.

#### Three cost functions, one shared secret

```ts
// cost.ts:25-33 — three CostFns, annotated
export const distanceCost = (edge) => edge.lengthM;            // no grade at all
export const gradeCostAbs = (edge, _from, max) =>
  edge.lengthM * (1 + penalty(edge.absGradePct, max));        // steepness, symmetric
export const gradeCostDirected = (edge, from, max) =>
  edge.lengthM * (1 + penalty(directedGrade(edge, from), max)); // signed, downhill-free
```

All three satisfy the same `CostFn` type, so the search loop can't tell them
apart — it just calls one. The difference is entirely *which grade* they feed
`penalty`: none (distance), absolute (symmetric steepness), or directed
(signed, free downhill). Note `distanceCost` ignores `from` and `max`
entirely — it still matches the type. **What breaks if the type weren't
shared?** The stage wrappers in pattern `01` couldn't treat them as
interchangeable; you'd lose the one-engine-four-algorithms property.

#### The cost is a multiplier on length, not an additive term

```
  cost = lengthM × (1 + penalty)
         ──────    ───────────────
         real      ≥ 1 always (penalty ≥ 0)
         distance

  flat edge:      cost = lengthM × 1.0   (no detour incentive)
  moderate climb: cost = lengthM × 1.4   (worth a small detour)
  steep climb:    cost = lengthM × 9.0+  (worth a big detour)
  over max:       cost = lengthM × 1e9   (avoid unless it's the only way)
```

Multiplying by `(1 + penalty)` keeps the units honest — cost stays
proportional to distance, so a long gentle hill and a short steep one trade
off the way a rider actually experiences them. **What breaks if it were
additive (`lengthM + penalty`)?** Penalty would dominate or vanish depending
on absolute edge length, and the `≥ 0` admissibility guarantee for A\* (the
penalty only *adds* to the haversine lower bound) would be harder to reason
about. The `(1 + penalty)` form keeps cost `≥ lengthM ≥ haversine`, which is
exactly what pattern `01`'s heuristic needs.

### Move 3 — the principle

Find the thing most likely to change, and give it exactly one home behind a
stable interface. "Uphill is expensive" will get retuned a dozen times;
because it lives only in `cost.ts`, every retune is a one-file diff and the
search loop never recompiles its understanding of the world. The general
lesson: **a clean seam isn't where two modules touch — it's where knowledge
*stops*.** The search loop's knowledge of grade stops at the `CostFn` type.

## Primary diagram

The seam in full: one number crosses up, all the domain stays down.

```
  penalty as the domain seam — complete

  ┌─ UI ──────────────────────────────────────────────┐
  │  GradeSlider → userMax : number                    │
  └──────────────────────┬─────────────────────────────┘
                         │ userMax
  ┌─ search loop / bidirectional / summarizePath ──────┐
  │   for each edge:  n = costFn(edge, from, userMax)  │ ← sees only `n`
  └──────────────────────┬─────────────────────────────┘
                         │ CostFn  (types.ts:40) — the contract
  ┌─ cost.ts (the ONLY grade-aware module) ────────────┐
  │   distanceCost     → lengthM                       │
  │   gradeCostAbs     → lengthM × (1+penalty(abs))    │
  │   gradeCostDirected→ lengthM × (1+penalty(dir))    │
  │        └─ penalty(): downhill 0 | lin | quad | 1e9 │
  └────────────────────────────────────────────────────┘
```

## Elaborate

This is information hiding (Parnas, 1972) and single-responsibility, and it
pairs with the strategy pattern of file `01`: `01` is the *mechanism* for
injecting a cost; `02` is the *discipline* of keeping the domain that
produces that cost in one place. Together they're why you can change the
grade model without touching the algorithm and change the algorithm without
touching the grade model — the two axes are genuinely independent.

The directed grade it depends on (`directedGrade`) is itself a pattern — see
`03`, which keeps the *graph* from having to know about travel direction the
way `cost.ts` keeps the *search loop* from having to know about grade. Same
move, one layer down. For the conceptual depth on information hiding, read
the matching `read-aposd` chapter.

## Interview defense

**Q: "The grade penalty is the core feature. Wouldn't inlining it into the
relaxation step be faster and more obvious — one fewer function call per
edge?"**

The call is trivially cheap and inlining it would scatter the most-changed
logic in the repo across every algorithm that relaxes edges. Right now,
retuning the curve — say, making the steep band bite harder — is a diff to
`penalty()` and nothing else; the four search variants, the bidirectional
search, and the route summarizer all pick it up for free because they all go
through the `CostFn` seam. Inline it and I'd be editing the same formula in
`search()`, in `bidirectional()`'s forward *and* reverse relaxation, and in
`summarizePath` — four places that must stay in sync or the displayed cost
won't match the routed cost.

```
  inlined penalty            vs      sealed in cost.ts
  ┌─────────────────┐                ┌──────────────┐
  │ search relax    │ edit           │  penalty()   │ edit ONCE
  │ bidir fwd relax │ edit           └──────┬───────┘
  │ bidir rev relax │ edit                  │ everyone reads it
  │ summarizePath   │ edit           ┌──────┴────────┐
  └─────────────────┘ (4× drift risk) all 4 callers stay in sync
```

*Anchor: a seam is where knowledge stops — grade knowledge stops at the
`CostFn` type, so the curve has exactly one home.*

**Q: "What's the contract `cost.ts` owes the search loop, and what happens if
it breaks it?"**

Two promises: the returned number is `≥ 0` (penalty never negative), and over
the user's max it's large-but-finite, not `Infinity` (pattern `05`). Break
the first and A\*'s heuristic stops being admissible — suboptimal routes,
silently. Break the second by returning `Infinity` and "the only route is
steep" becomes indistinguishable from "there is no route," so the app can't
honestly tell the user "this is steep but it's your only option."

*Anchor: penalty ≥ 0 keeps A\* optimal; large-finite (not Infinity) keeps
"steep" distinct from "disconnected."*

## See also

- `01-parametric-search-over-cost-fns.md` — the mechanism that injects this.
- `03-directed-traversal-over-undirected-storage.md` — `directedGrade`, the
  same hiding move one layer down.
- `05-blocked-as-large-finite.md` — the BLOCKED contract this seam upholds.
- `audit.md` Lens 3 (information hiding), Lens 6 (errors defined out).
