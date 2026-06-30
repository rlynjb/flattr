# Scope, Cuts, and Non-Goals

The skill a review room is testing here isn't "can you list features."
It's "can you draw the smallest box that still validates the premise,
and refuse everything outside it?" You're in a strong position: the
smallest box is **already built**. Your job is to name it precisely and
fence it hard.

---

## Where scope sits in the system

```
  Zoom out — the validating slice vs everything around it

  ┌─ what a full product would be (OUT) ───────────────────┐
  │  city coverage · turn-by-turn · accounts · transit     │
  │  ┌─ the validating slice (IN — already built) ───────┐ │
  │  │  one neighborhood · two endpoints · colored path  │ │
  │  │  · climb number                                    │ │
  │  │  ★ THIS is all you defend ★                        │ │
  │  └────────────────────────────────────────────────────┘ │
  └────────────────────────────────────────────────────────┘
```

Everything in the inner box is provable from the repo. Everything in the
outer ring is a non-goal — and naming it as a deliberate cut is the
signal, not an admission.

---

## The smallest useful scope (it ships today)

The narrowest slice that can validate "people want flatter-over-faster"
is one neighborhood, two endpoints, a grade-routed path, and a climb
number. That is exactly what the Expo app does.

```
  The slice — four parts, all live

  ┌─ 1. one bundled neighborhood ─────────────────────────┐
  │  Capitol Hill, ~0.35 km², 1621 nodes / 1879 edges     │
  │  data/graph.json → mobile/assets/graph.json           │
  │  steep area on purpose (spec's Pine St reference)     │
  └────────────────────────┬──────────────────────────────┘
  ┌─ 2. set two endpoints ─▼──────────────────────────────┐
  │  address bar (Nominatim) OR tap map OR "current loc"  │
  │  mobile/src/MapScreen.tsx + AddressBar.tsx            │
  └────────────────────────┬──────────────────────────────┘
  ┌─ 3. grade-routed path ─▼──────────────────────────────┐
  │  directedAstar(graph, startId, endId, userMax)        │
  │  MapScreen.tsx:155 — color-coded green/yellow/red     │
  └────────────────────────┬──────────────────────────────┘
  ┌─ 4. the climb number ──▼──────────────────────────────┐
  │  RouteSummaryCard.tsx:26-27 — distance + climbM       │
  │  "Flat all the way" or "⚠ flattest available + N      │
  │  steep blocks (>userMax%)"                            │
  └────────────────────────────────────────────────────────┘
```

**Why this is the smallest *useful* slice and not smaller:** drop part 4
(the climb number / honest fallback) and the user can't tell "flat
route" from "least-bad route through a hill" — the demo lies. That's why
the BLOCKED-finite distinction matters at the product layer, not just
the algorithm layer. → `../study-system-design/04-honest-fallback-routing.md`.

**What makes it a *validating* slice, not just a demo:** the experiment
it enables is "put this in front of one real walker on a route they know
and ask: is this the path you'd actually take?" One person, one
afternoon, no infrastructure. That single qualitative session moves more
than any number you can compute on your laptop.

---

## The Capitol Hill choice is deliberate

A reviewer might say "you only proved it on a tiny patch." Pre-empt it:
the patch was chosen *because* it's steep.

```
  Why Capitol Hill is the right validating ground

  ┌────────────────────────────────────────────────────────┐
  │  flat neighborhood  →  every route is flat  →  the      │
  │                        product does nothing visible     │
  │                                                          │
  │  steep neighborhood →  grade actually constrains the    │
  │  (Capitol Hill)        path → the router earns its keep │
  │                        AND the honest-fallback fires    │
  │                        ("no flat route exists from      │
  │                         downtown" — spec §12)            │
  └────────────────────────────────────────────────────────┘
```

`pipeline/config.ts` documents the choice: a small steep Capitol Hill
slice, "kept small so the free Open-Meteo build stays under rate limits
and the bundled graph.json stays phone-friendly." That's the free-tier
constraint and the offline constraint shaping scope — name both.

---

## Non-goals — what NOT to build

Four explicit cuts. Each is a deliberate "no," and saying *why* is the
signal.

```
  Non-goals — the fence, with the reason for each post

  ┌─ city / multi-city coverage ──────────────────────────┐
  │  WHY NOT: build is free but rate-limited; offline      │
  │  bundle must stay phone-friendly. Coverage is a SCALE  │
  │  problem you only earn after demand is shown. Spec     │
  │  even diverges here — proposed Next.js web, shipped     │
  │  a one-neighborhood Expo app instead.                  │
  └────────────────────────────────────────────────────────┘
  ┌─ turn-by-turn navigation ─────────────────────────────┐
  │  WHY NOT: the thesis is "show me where flat is," not    │
  │  "guide me step by step." Nav is a different product   │
  │  with GPS-tracking, re-routing, voice. Pure scope creep │
  │  against the wedge.                                    │
  └────────────────────────────────────────────────────────┘
  ┌─ user accounts / history / sync ──────────────────────┐
  │  WHY NOT: spec §13 lists accounts as out of scope. The │
  │  app is offline-first with no backend (no DB, graph is │
  │  a static asset). Accounts add a whole server tier to   │
  │  validate a hypothesis that needs zero of it.          │
  └────────────────────────────────────────────────────────┘
  ┌─ multi-modal / transit routing ───────────────────────┐
  │  WHY NOT: "self-powered travel" is the framing (spec    │
  │  §12). Adding bus/train changes the cost model, the    │
  │  data sources, and the user entirely. Different problem.│
  └────────────────────────────────────────────────────────┘
```

**The discipline here:** every one of these would be *fun* to build, and
every one would let you avoid the uncomfortable question of whether
anyone wants the core thing. That's exactly why they're cuts. You don't
get to add coverage until one real user says "yes, this route is the one
I'd take."

---

## What's tempting but premature

A specific trap worth naming, because the repo already drifted toward it:
**polishing the grade-control UX before validating the grade concept.**

Commit `b24797c` dropped the continuous slider for three presets. That's
a UX refinement on a control whose underlying value (`userMax`) hasn't
been validated with a single user. Refining how someone picks their
threshold, before knowing whether *threshold-based routing* is what they
want, is motion without progress. → chapter 05 has the full read on what
b24797c signals.

---

## Scope in one frame

```
  Scope — the whole decision, one picture

           OUT (non-goals)
   ┌───────────────────────────────────┐
   │ city coverage   turn-by-turn      │
   │   accounts      multi-modal       │
   │   ┌───────────────────────────┐   │
   │   │  IN — and already shipped: │   │
   │   │  1 neighborhood            │   │
   │   │  2 endpoints               │   │
   │   │  grade-routed colored path │   │
   │   │  climb number + honest     │   │
   │   │  fallback                  │   │
   │   └───────────────────────────┘   │
   │  validate the inner box on ONE     │
   │  real user before touching the     │
   │  outer ring.                       │
   └───────────────────────────────────┘
```

Next: `03-options-and-opportunity-cost.md`.
