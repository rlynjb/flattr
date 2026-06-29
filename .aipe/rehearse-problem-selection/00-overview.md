# Problem Selection — flattr (overview)

> Coach posture. Base persona: `teacher.md` (staff engineer), voice shifted to
> coach for `me.md` (Rein). Diagrams primary, second person, no hedging, no
> marketing. This book justifies **why** flattr deserves investment *before* any
> solution design — and it is brutally honest about what the repo can and cannot
> prove.

## The one thing to internalize before you defend this

You built a router. You did **not** validate a problem. Those are two different
claims, and a sharp reviewer will separate them in the first thirty seconds.
This book makes you the one who separates them first.

Here is the whole brief in one frame. Read the two columns as two different
kinds of truth — one you can point at a file for, one you cannot.

```
  flattr — what the repo proves vs. what it only asserts

  ┌─ EVIDENCE (point at a file) ────────────┐   ┌─ INFERENCE (plausible, unproven) ──┐
  │ • A* == Dijkstra optimality gate        │   │ • that kick-scooter commuters      │
  │     astar.test.ts:38,47,51              │   │     exist in measurable numbers    │
  │ • node-expansion drops (bench harness)  │   │ • that they'd switch from Google   │
  │     bench/run.ts → report.ts            │   │     Maps to a flat-first router     │
  │ • signed directional grade cost         │   │ • that "show me the flat" is a      │
  │     cost.ts penalty()                    │   │     felt pain, not a nice-to-have   │
  │ • honest fallback (BLOCKED finite)      │   │ • that grade ceiling is a hard,     │
  │     cost.ts:6, astar fallback           │   │     non-negotiable need for anyone  │
  │ • free data pipeline runs               │   │ • the AccessMap differentiator      │
  │     pipeline/*.ts, graph.json 544 KB    │   │     ("personalized userMax") matters│
  │ • ships on device (Expo app)            │   │                                     │
  │     mobile/src/MapScreen.tsx            │   │                                     │
  └─────────────────────────────────────────┘   └────────────────────────────────────┘
        ↑ the problem is SOLVABLE                       ↑ the problem is WORTH solving
          (proven, technically)                           (NOT proven — discovery needed)
```

The repo lands the left column hard. The right column is empty of evidence —
there are no users, no logs, no interviews, no waitlist, no analytics, nothing.
`docs/flattr-spec.md` §3 prints a three-row user table; that table is a
**hypothesis written by the author**, not a finding. Treat it as inference.

## The honesty framing this book uses

One sentence, and it runs through every file:

> **flattr proves the problem is technically solvable. It contains zero evidence
> the problem is worth solving. The correct next investment is discovery, not
> features.**

That is not a weakness to hide. Stated first, it reads as senior judgment —
exactly the framing `docs/flattr-spec.md` §15.1 already reaches for about
*scale* ("name the gap before a reviewer does"). This book applies the same move
to *demand*.

## Reading order

```
  00-overview.md                    ← you are here: the EVIDENCE/INFERENCE split
        │
        ▼
  01-problem-brief.md               who hurts · what the repo proves · why now ·
        │                           beneficiaries · constraints (the 10-point core)
        ▼
  02-scope-cuts-and-non-goals.md    the smallest validating slice + what NOT to build
        │
        ▼
  03-options-and-opportunity-cost.md  including `do nothing` as a real option
        │
        ▼
  04-success-metrics-and-feedback-loop.md  metrics available-now vs. needs-users
        │
        ▼
  05-skeptical-reviewer-questions.md  the review-room questions and answers that hold
```

## Constraints baked into every recommendation

These are fixed by the repo and `me.md`; they bound every option in this book.

- **Free-tier data only** — OSM (Overpass) + Open-Meteo elevation. `pipeline/`
  proves it works; Open-Meteo 429s under load (project context, external-data
  caveat).
- **Hand-rolled engine mandate** — no Valhalla / OSRM / GraphHopper. Locked in
  `docs/flattr-spec.md` §14. The graph work *is* the project.
- **Offline client** — graph is a static artifact (`mobile/assets/graph.json`),
  the app only reads it. No live backend, no DB.
- **Single developer** — Rein, solo. Every scope decision is a time decision.

## What this book is NOT

It does not invent a market, a user count, a conversion rate, or an org
constraint. Where demand is asserted, it is labelled INFERENCE and converted
into a **discovery question** (see `05`). If the only honest answer is "we don't
know yet," this book says so and tells you what to go measure.

## Cross-links to the study guides

The 16 study guides under `.aipe/study-*/` prove the *solvability* column. This
book points at them rather than restating:

- `.aipe/study-dsa-foundations/05-graphs-and-traversals.md` — the A* / Dijkstra
  foundation the optimality gate rests on.
- `.aipe/study-system-design/04-honest-fallback-routing.md` — the
  BLOCKED-finite "flat vs. disconnected" distinction.
- `.aipe/study-performance-engineering/02-heuristic-pruning.md` — the
  node-expansion win the bench harness measures.
- `.aipe/study-data-modeling/01-graph-as-the-schema.md` — why the graph artifact
  is the whole data model.
