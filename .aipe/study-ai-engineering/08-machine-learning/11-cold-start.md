# Cold start — hand-tuned `penalty()` IS the cold-start strategy, switch to learned after data

**Industry name(s):** cold-start problem / bootstrapping. **Type:**
Industry standard (every personalized system faces it).

## Zoom out — flattr ships with zero data, so the formula penalty IS the cold start

Cold start is the gap before you have enough data to personalize: a new
user, a new item, or a brand-new system with no history. flattr is in the
*system* cold-start case permanently-until-launch — no accept/reroute data
exists. And it has the textbook answer already shipped: the hand-tuned
`penalty()` (cost.ts:16) is a sensible default that works on day zero, with
no data. The learned cost is what you *graduate to* once enough events
accumulate. This maps cleanly — it's the strongest "no model yet" story in
the set.

```
  Zoom out — cold start = the formula default, learned cost = the warm path

  DAY 0 (cold)                       AFTER THRESHOLD (warm)
  ┌─ cost.ts penalty() ─┐            ┌─ learned cost ─┐
  │ k1=0.4, k2=1.0       │  ──data──►│ fit to user(s)  │
  │ works with ZERO data │  threshold│ behind penalty()│
  └──────────┬───────────┘           └────────┬────────┘
             └──────────── A* relaxation ──────┘
                          (astar.ts:68 unchanged)
```

The hand-tuned formula isn't a placeholder to be embarrassed about — it's
the *correct* cold-start policy. The switch to learned is gated on data.

## Structure pass

- **Layers:** cold default (rules) → data accumulation → threshold gate →
  warm model → fallback-to-cold when data is thin.
- **Axis — rules vs learned, gated by data volume.** Below the threshold:
  rules. Above: learned. The gate is the whole design.
- **Seam:** `penalty()` (cost.ts:16). The cold default lives there *now*;
  the warm model would replace the body there *later*, behind the same
  signature.

## How it works

### Move 1 — the mental model

You can't personalize from zero examples. So every personalized system
needs a *prior* — a reasonable default that works before any data, which
the model gradually overrides as evidence arrives. flattr's prior is a
physics-ish formula: uphill costs effort, steeper costs more, downhill is
free. That's defensible with zero data, which is exactly what a cold-start
default needs to be.

```
  Pattern — cold-start handoff

  data volume:  0 ──────────────► threshold ──────────► lots
  policy:       hand-tuned rules │ blend?           │ learned model
                (penalty formula)│                  │ (fit per user)
  fallback:     always available ◄── thin data ─────┘
```

### Move 2 — the walkthrough

**Sub-step A — three flavors of cold start, all present in flattr.**

```
  Cold start, three ways

  system cold start  brand-new app, no data anywhere → formula penalty()
  user cold start    new user, no reroute history     → start at a preset
  region cold start  new city's edges, no labels      → formula (domain gap)
```

The user case ties to preset selection (`10-recommender-systems.md`); the
region case ties to domain gap (`06-domain-gap.md`). All three resolve the
same way: fall back to the city-agnostic formula.

**Sub-step B — the gate: when do you switch to learned?**

```
  The data threshold (the design decision)

  too few events  → learned cost overfits one user's noise → STAY cold
  enough events   → learned cost generalizes (held-out user passes) → WARM
  gate on: per-user event count AND held-out-user validation passing
  (ties to 03-train-val-test: can't even hold a user out below N users)
```

You don't flip to learned on a calendar; you flip when the held-out-user
metric beats the formula. Until then the formula wins by default.

**Sub-step C — the formula stays as the floor.**

```
  Learned cost never fully replaces the formula

  user with <N events     → serve formula (cold fallback)
  off-domain city         → serve formula (domain-gap fallback)
  learned model unhealthy → serve formula (safe default)
  the formula is the FLOOR, not a temporary scaffold
```

This is why the admissibility invariants matter even in cold start: the
formula already satisfies them (≥0, monotone, finite BLOCKED), so falling
back to it is always A*-legal.

### Move 3 — the principle

Cold start is solved by a good prior, not by waiting. flattr's hand-tuned
`penalty()` is that prior — defensible from physics, correct on day zero,
and A*-legal by construction. The learned cost is an *upgrade gated on
data*, and the formula remains the permanent fallback for new users, new
regions, and unhealthy models. Designing the handoff — rules now, learned
when the held-out-user metric clears the bar, formula always as the floor
— is the actual engineering.

## Primary diagram

```
  Cold-start handoff for flattr's cost (the strongest "no model yet" map)

  ┌─ COLD (today, real) ────────────────────┐
  │ penalty() formula  [cost.ts:16]          │
  │ k1=0.4 k2=1.0 · zero data · A*-legal      │
  └──────────────┬───────────────────────────┘
                 │ accumulate accept/reroute events
  ┌─ GATE ──────▼───────────────────────────┐
  │ enough events? held-out user beats formula?│
  │   no → STAY cold      yes → go warm        │
  └──────────────┬───────────────────────────┘
  ┌─ WARM (future) ─▼───────────────────────┐
  │ learned cost behind penalty()             │
  │ FALLBACK to formula: new user / new city  │
  └───────────────────────────────────────────┘
```

## Elaborate

The reason this is flattr's cleanest ML story: most "we have no model"
situations are awkward to defend, but cold start *reframes the absence as
the correct first phase*. You're not missing a model — you've implemented
the cold-start policy (a principled formula) and deferred the warm policy
until data justifies it. That's exactly how mature personalized systems
launch: rules first, learning later, rules forever as the floor. The
threshold gate also forces honesty about data volume — flattr won't have
enough users to hold one out for a long time, so "stay cold" is the right
answer for the foreseeable roadmap.

## Project exercises

### COLD.1 — data-gated cost selector

- **Exercise ID:** COLD.1
- **What to build:** a `selectCostFn(userEventCount, learnedReady)` that
  returns `gradeCostDirected` (the formula) below a data threshold and a
  learned cost above it — wiring the cold/warm handoff with the formula as
  the explicit fallback.
- **Why it earns its place:** it implements the handoff design — the actual
  engineering of cold start — and keeps the A*-legal formula as the floor.
- **Files to touch:** new `features/routing/cost-select.ts` (returns a
  `CostFn`), `cost-select.test.ts` (below threshold → formula; above +
  ready → learned; unhealthy learned → formula).
- **Done when:** the selector provably returns the formula for a new user
  and only switches when both the count and a readiness flag are met.
- **Estimated effort:** half a day.

## Interview defense

**Q: flattr has no trained model — isn't that a gap?** Answer: it's the
cold-start phase, and it's handled correctly. The hand-tuned `penalty()`
is a principled prior — uphill costs effort, downhill is free, steeper
costs quadratically more — that works with zero data and is A*-legal by
construction. The learned cost is an upgrade *gated on data*: I switch
only when there are enough per-user events and a held-out user beats the
formula. And the formula stays as the permanent floor for new users, new
cities, and unhealthy models. Rules now, learning later, rules forever as
the fallback — that's how you launch a personalized system.

```
  cold start = good prior, not waiting
  penalty() formula = the prior (A*-legal, zero data)
  switch to learned ONLY when held-out user beats it
```

Anchor: *"the hand-tuned `penalty()` at cost.ts:16 isn't a missing model —
it's the cold-start policy, and the floor the learned cost falls back to."*

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the warm path the gate leads to.
- [03-train-val-test.md](03-train-val-test.md) — too few users to hold one out → stay cold.
- [06-domain-gap.md](06-domain-gap.md) — region cold start = the formula fallback off-domain.
- [10-recommender-systems.md](10-recommender-systems.md) — user cold start = pick a preset.
