# Scope, Cuts, and Non-Goals — flattr

> The narrowest slice that validates the *premise* (not the engine), and an
> explicit list of what NOT to build. Coach posture: prefer a validated slice
> over a feature wishlist. Every cut here is a time-back-to-discovery decision.

## The discipline: validate the premise, not the engine

The engine is done and proven (`01` §2). So the slice is **not** "build more
routing." The slice is the cheapest thing that answers *"does a real
self-powered traveler prefer flattr's flat route over the default route?"* —
which the repo has never tested.

```
  two different "smallest slices" — pick the right one

  ┌─ WRONG slice (more of what's proven) ──────────────────┐
  │  add bidirectional · add k-alternatives · add zones     │  ← engine work,
  │  → proves the engine is better. demand still unknown.   │    zero demand signal
  └─────────────────────────────────────────────────────────┘

  ┌─ RIGHT slice (tests the unproven thing) ───────────────┐
  │  ONE neighborhood, set A→B, colored path + climb number │  ← already built
  │  → put in front of 5 real travelers, measure preference │  ← the NEW work
  └─────────────────────────────────────────────────────────┘
```

## The smallest validating slice — spelled out

Everything in the box already exists in the repo except the last line.

```
  flattr validating slice — bundle once, test with humans

  ┌─ Build (offline, ONCE) ─────────────────────────────────┐
  │  one bbox: a known-hilly neighborhood                    │
  │  (spec §10 Phase 0: downtown + Capitol Hill)             │
  │  pipeline/run-build.ts → graph.json  (bundled, offline)  │  ✓ exists
  └───────────────────────────────┬─────────────────────────┘
                                  │
  ┌─ Client (Expo, on device) ────▼─────────────────────────┐
  │  AddressBar: set start + end (geocoded into the bbox)    │  ✓ exists
  │  MapScreen: draw the route, color segments by            │
  │             directedGrade (green/yellow/red)             │  ✓ exists
  │  RouteSummaryCard: ONE climb number + distance +         │
  │                    steepCount  (summary.ts routeSummary) │  ✓ exists
  └───────────────────────────────┬─────────────────────────┘
                                  │
  ┌─ The actual experiment ───────▼─────────────────────────┐
  │  show 5 real self-powered travelers the same A→B in      │  ✗ NEVER DONE
  │  flattr AND in Google Maps. ask which they'd take and    │     ← this is the
  │  why. record the answer.                                 │       whole slice
  └─────────────────────────────────────────────────────────┘
```

Why this is the right slice:

- **It's bounded.** One bbox keeps `graph.json` small (the shipped artifact is
  already 544 KB for its current extent) and offline. No city-scale pipeline,
  no tiling work, no server.
- **It reuses everything proven.** The colored path comes from
  `grade/classify.ts` over `directedGrade`; the climb number comes from
  `summary.ts` `routeSummary` (`climbM` = sum of positive directed rise). You
  write no new engine code.
- **It targets the empty column.** The output of the experiment is the first
  real demand datum flattr has ever had. That is the entire point.

## What "done" looks like for the slice

You are done when you can answer, with evidence not assertion:

- Did the flat route differ meaningfully from the default route for these A→B
  pairs? (Engine-side, measurable now — see `04`.)
- When shown both, did real travelers prefer flattr's route, and was their
  stated reason "the grade"? (Demand-side, only measurable via the experiment.)

If the answer to the second question is "no" or "they didn't care," that is a
*successful* experiment — it cheaply told you not to invest more.

## Non-goals — what NOT to build (and why)

These are cuts, stated without apology. Each one is hours returned to discovery.
The first group is from `docs/flattr-spec.md` §13; the framing is this book's.

```
  non-goals — each is a deliberate cut, not a missing feature

  ┌───────────────────────┬────────────────────────────────────────┐
  │ NON-GOAL              │ WHY it's cut (now)                      │
  ├───────────────────────┼────────────────────────────────────────┤
  │ city-wide coverage    │ premise is unproven; coverage is a      │
  │                       │ cost you pay AFTER demand, not before.  │
  │                       │ one bbox tests the premise for free.    │
  ├───────────────────────┼────────────────────────────────────────┤
  │ turn-by-turn nav      │ a navigation product, not a routing     │
  │                       │ premise test. huge surface, zero        │
  │                       │ bearing on "is flat-first wanted?"      │
  ├───────────────────────┼────────────────────────────────────────┤
  │ accounts / sync       │ no user → no account. pure overhead     │
  │                       │ until there's someone to save state for.│
  ├───────────────────────┼────────────────────────────────────────┤
  │ multi-modal / transit │ different problem entirely. flattr is   │
  │                       │ self-powered travel; transit dilutes    │
  │                       │ the one thing being tested.             │
  └───────────────────────┴────────────────────────────────────────┘
```

Also explicitly cut for the validating slice (engine-side temptations):

- **Bidirectional A*, k-alternatives, contraction hierarchies** (spec §14.5) —
  search-speed and route-variety refinements. Real DSA depth, zero demand
  signal. They make a *better* engine, not a *validated* problem. Keep them as
  portfolio stretch, not as the next investment.
- **Zone choropleth** (spec §11, `grade/zones.ts`) — nice map polish; doesn't
  test whether a traveler prefers the route.
- **Multi-city pipeline** (spec §10 Phase 4) — pure cost-before-demand.

## The cut that matters most

If you build *anything* before the 5-traveler experiment, you are spending the
one resource you can't get back (solo-dev hours) on the column the repo already
fills. The hardest, most senior cut here is cutting *more engineering*.

## See also

- `03-options-and-opportunity-cost.md` — `do nothing more on features` as a real
  option, with opportunity cost named.
- `04-success-metrics-and-feedback-loop.md` — how to measure the slice.
- `.aipe/study-system-design/00-overview.md` — the build-time/runtime split that
  makes the one-bbox bundle cheap.
- `.aipe/study-data-modeling/05-build-and-evolve-the-artifact.md` — how the
  graph.json artifact is built and bounded.
