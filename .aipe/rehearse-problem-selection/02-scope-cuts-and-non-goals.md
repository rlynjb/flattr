# Scope cuts and non-goals

The skill this file trains is the one that separates people who ship from people who plan: choosing the *narrowest* slice that proves the premise, and writing down everything you deliberately won't build so the scope can't creep. A problem brief without explicit non-goals is a wishlist, and wishlists don't ship.

The premise flattr has to validate is one sentence: **routing can optimize for flat-and-comfortable instead of fast, and the result is visibly different and useful.** Everything that doesn't serve proving *that* is a cut.

```
  SCOPE — the smallest thing that proves the premise

  ┌─ THE VALIDATING SLICE (build this) ──────────────────────┐
  │  one neighborhood, bundled graph                          │
  │  + set two endpoints (type address or tap map)            │
  │  + route optimized for grade via one knob (userMax)       │
  │  + show the route colored by steepness + a climb number   │
  │  + a grade heatmap you can toggle on                      │
  │  = a user can SEE flat-first routing differ from shortest │
  └──────────────────────────┬───────────────────────────────┘
                             │ everything past here is a NON-GOAL
  ┌─ NON-GOALS (explicitly NOT in the slice) ─────────────────┐
  │  turn-by-turn voice nav · global/city-wide coverage ·     │
  │  accounts/saved routes · live re-routing while moving ·   │
  │  multi-modal (transit/car) · social/sharing · offline     │
  │  map tiles · production elevation accuracy                 │
  └───────────────────────────────────────────────────────────┘
```

That bundled-neighborhood slice is the whole bet. If a real scooter rider looks at the colored route and says "yeah, that's the way I'd actually go," the premise holds. Nothing else needs to exist to learn that.

## Why this is the right slice

The validating slice is *small on purpose*. It cuts every feature that's about being a product (accounts, sharing, coverage) and keeps only what's needed to answer the one question — does grade-first routing produce a visibly better route for the target user? A neighborhood graph is enough; a whole city is a scaling problem, not a premise problem. Tap-or-type endpoints are enough; turn-by-turn is navigation polish that doesn't change whether the *route choice* is good.

## The non-goals, and why each is cut

| Non-goal | Why it's cut |
|----------|--------------|
| **City/global coverage** | A scaling problem (spatial index, tiling, CH), not a premise problem. The neighborhood proves the idea; coverage proves nothing new and costs the most. |
| **Turn-by-turn voice nav** | Navigation UX, orthogonal to "is the route choice good?" The thing being validated is the *path*, not the guidance. |
| **Accounts / saved routes / sharing** | Product/retention features. Premature before the core route is proven useful. |
| **Live re-routing while moving** | Real-time tracking is a large surface; the static A→B route is enough to validate flat-first routing. |
| **Multi-modal (transit/car)** | Cars want *fast* — that's the opposite of the premise. Including it dilutes the one thing flattr does differently. |
| **Production-grade elevation accuracy** | The free 90m DEM is "good enough to feel the difference." Finer elevation (paid) is a fidelity upgrade to defer until demand is proven. |

## The cut that hurt (and was right)

The honest one to call out: **city-scale coverage is cut, and it's the cut that makes flattr look like a toy to a casual observer.** It's still right. Proving the premise needs one neighborhood; scaling to a city is months of work (spatial index, tiling, contraction hierarchies) that teaches you *nothing about whether anyone wants flat-first routing*. Spending that effort before validating demand would be optimizing the wrong thing. The cut is defensible precisely because it's sequenced correctly — validate, then scale.

▸ A non-goal isn't a feature you failed to build. It's a feature you decided, on purpose, not to build yet — and can say why.

## One-page summary

**Core claim:** The validating slice is a bundled-neighborhood, two-endpoint, grade-routed map with a visible colored route and a climb number — the smallest thing that proves flat-first routing is different and useful.

- **Build:** bundled graph, set endpoints, route by `userMax`, route colored by grade + climb number, toggleable heatmap.
- **Cut:** city coverage, turn-by-turn, accounts/sharing, live re-route, multi-modal, production elevation accuracy.
- **The hard cut:** city-scale coverage — makes it look small, but scaling teaches nothing about demand, so it's correctly sequenced *after* validation.

┃ "The neighborhood proves the idea; the city proves nothing new and costs the most."
