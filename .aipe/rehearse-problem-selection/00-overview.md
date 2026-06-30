# Problem Selection — flattr (overview)

Coach voice. Same staff engineer from `teacher.md`, shifted to coach
posture (per `rehearse-interview-defense.md`): more direct, "do say this,
don't say that," focused on what survives a review room — not what's
merely true. Calibrated to you (`me.md`): diagrams first, pattern over
vendor, concept → mechanism → your code.

This book is the human layer *before* solution design. It answers one
question and refuses to skip it: **does this problem deserve the
investment you've already poured into it?** You built the engine. This
book makes you defend the choice to build *anything*.

---

## The one thing to internalize first

There are two different claims, and flattr proves exactly one of them.

```
  Two claims — flattr proves the left, not the right

  ┌─ CLAIM A: "this is technically solvable" ─────────────┐
  │  hand-rolled directional A* over free OSM +           │
  │  Open-Meteo data; A*==Dijkstra oracle; bench          │
  │  node-expansion numbers; BLOCKED-finite honest        │
  │  fallback; shipped Expo app on a real neighborhood    │
  │                                                        │
  │  STATUS: ★ PROVEN by the repo ★                        │
  └────────────────────────────────────────────────────────┘

  ┌─ CLAIM B: "people want this enough to switch" ────────┐
  │  demand, adoption, trust, willingness to leave         │
  │  Google Maps / AccessMap for a flatter route           │
  │                                                        │
  │  STATUS: ☐ UNPROVEN — zero users, zero telemetry,      │
  │          zero research anywhere in the repo            │
  └────────────────────────────────────────────────────────┘

  A skeptical reviewer attacks B. Your repo answers A.
  The whole book is about not confusing the two.
```

Grep the repo for `analytics|telemetry|sentry|mixpanel|amplitude|
posthog|survey|user.?research|adoption`. It returns nothing. No
analytics SDK in `mobile/package.json`, no telemetry plugin in
`mobile/app.json`, no deployed web app, no app-store build. The three
user personas in `docs/flattr-spec.md` §3 (kick-scooter commuter,
hill-avoiding pedestrian, wheelchair/stroller user) are *spec personas*,
not interviewed humans.

That is not a weakness to hide. It's the most honest and most
defensible thing about this brief. **You separate what you can prove
from what you're inferring, and you name the cheapest experiment that
would close the gap.** That posture is what a staff reviewer is looking
for — not a fabricated TAM slide.

---

## What the repo actually proves (EVIDENCE)

Every item here is grounded in a file you can open. This is your
ammunition.

```
  Evidence ledger — provable from the repo today

  ┌────────────────────────────┬──────────────────────────────────┐
  │ claim                      │ where it lives                   │
  ├────────────────────────────┼──────────────────────────────────┤
  │ grade-aware A* router      │ features/routing/astar.ts:22-78  │
  │ directional uphill penalty │ features/routing/cost.ts:16-22   │
  │ one knob (userMax)         │ astar.ts:26, cost.ts:28,32       │
  │ A*==Dijkstra oracle        │ astar.test.ts:38-44              │
  │ A* expands ≤ Dijkstra      │ astar.test.ts:47-52              │
  │ bench node-expansion nums  │ bench/run.ts + report.ts         │
  │ BLOCKED finite, not Inf    │ cost.ts:5 (1e9)                  │
  │ steep ≠ disconnected       │ astar.test.ts:82-96              │
  │ free build-time data       │ pipeline/overpass.ts, elevation  │
  │ offline routing hot path   │ mobile/src/loadGraph.ts:1-11     │
  │ shipped neighborhood       │ data/graph.json (Capitol Hill,   │
  │                            │ ~0.35 km², 1621 nodes/1879 edges)│
  └────────────────────────────┴──────────────────────────────────┘
```

## What the repo does NOT prove (INFERENCE)

```
  Inference ledger — plausible, NOT in the repo

  ┌────────────────────────────────────────────────────────┐
  │ • that anyone wants flatter-over-faster routing         │
  │ • that the three personas exist in real numbers         │
  │ • that users would switch from Google Maps / AccessMap  │
  │ • that one preset tap beats AccessMap's fixed thresholds│
  │ • that 90m-DEM grade is accurate enough to be trusted   │
  │ • any market size, adoption rate, or retention number   │
  └────────────────────────────────────────────────────────┘
```

The honest framing throughout this book: **EVIDENCE is anything with a
`file:line`. INFERENCE is everything about humans.** When you speak to
a reviewer, you tag each sentence as one or the other. Never launder an
inference into a fact.

---

## One signal the repo gives you for free

You don't have user research — but you do have a *design decision* that
behaves like a tiny piece of feedback. Commit `b24797c` ("drop the
max-grade slider, keep the preset buttons only") replaced the
continuous 2–15% slider with three fixed presets (kick scooter 5% /
walking 8% / any 15%). The commit message says "Per request."

```
  b24797c — a partial walk-back of "everyone sets their own grade"

  BEFORE (44ca84e)            AFTER (b24797c)
  ┌────────────────┐          ┌────────────────┐
  │ continuous     │          │  🛴 5%          │
  │ slider 2–15%   │   ──►    │  🚶 8%          │
  │ 14 settings    │          │  🏔️ 15%         │
  │ "your number"  │          │  3 presets      │
  └────────────────┘          └────────────────┘

  the core thesis was "one slider, everyone sets where red begins"
  (spec §2). dropping it to 3 buttons narrows that thesis. note it —
  it's the closest thing to a product signal the repo contains.
```

Treat this as a flag, not proof. It's an unforced narrowing of the
central wedge before a single user touched it. A reviewer who knows the
spec will ask about it. Chapter 05 hands you the answer.

---

## How to read this book

```
  Reading order — orient, then defend

  00-overview.md ─────────► you are here (the map)
        │
        ▼
  01-problem-brief.md ────► the 10-point brief: pain, evidence,
        │                   why-now, who, constraints
        ▼
  02-scope-cuts-and-non-goals.md ─► smallest validating slice +
        │                           explicit non-goals
        ▼
  03-options-and-opportunity-cost.md ─► incl. DO NOTHING as a
        │                               real option
        ▼
  04-success-metrics-and-feedback-loop.md ─► available-now vs
        │                                     needs-users
        ▼
  05-skeptical-reviewer-questions.md ─► the review room, answered
```

## Constraints that frame every decision

These are real and visible in the repo. They bound every option in
chapter 03.

```
  ┌─ free-tier data ──────────────────────────────────────┐
  │  OSM/Overpass + Open-Meteo elevation + Nominatim.      │
  │  No paid map/elevation budget. 429s when quota burns.  │
  └────────────────────────────────────────────────────────┘
  ┌─ hand-rolled engine mandate ──────────────────────────┐
  │  no Valhalla/OSRM/GraphHopper. The graph + router IS   │
  │  the project (spec §14). This is a portfolio repo.     │
  └────────────────────────────────────────────────────────┘
  ┌─ offline client ──────────────────────────────────────┐
  │  graph bundled as a static asset; no network in the    │
  │  routing hot path (loadGraph.ts:1-11).                 │
  └────────────────────────────────────────────────────────┘
  ┌─ single developer ────────────────────────────────────┐
  │  you. No team, no PM, no design partner, no user base. │
  └────────────────────────────────────────────────────────┘
```

## Cross-links into the study guides

This book is the *why*. The study guides are the *how*. When a reviewer
pushes on mechanism, you walk them into these:

- **`../study-dsa-foundations/05-graphs-and-traversals.md`** — the A*
  and Dijkstra mechanics the brief keeps invoking.
- **`../study-system-design/04-honest-fallback-routing.md`** — the
  BLOCKED-finite "steep ≠ disconnected" distinction that makes the
  smallest-slice demo honest.
- **`../study-system-design/06-parametric-search-engine.md`** — the one
  engine, four cost/heuristic pairs, that `userMax` keys off.
- **`../study-performance-engineering/01-heuristic-pruning.md`** — where
  the bench node-expansion numbers come from.
- **`../study-testing/01-optimality-oracle.md`** — the A*==Dijkstra
  oracle that is your strongest correctness evidence.
- **`../study-data-modeling/01-graph-as-entity-model.md`** — the shipped
  graph artifact the whole problem stands on.

Now go to `01-problem-brief.md`.
