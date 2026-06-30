# Success Metrics and the Feedback Loop

The trap with metrics is reporting the easy ones as if they answered the
hard question. flattr can compute a lot about itself — correctness,
node-expansion counts, route plausibility — none of which tells you
whether a human wants the route. **Split metrics into "available now"
(provable from the repo) and "needs users" (impossible to fake), and
never let the first stand in for the second.**

---

## The two metric classes

```
  Zoom out — two columns, one wall between them

  ┌─ AVAILABLE NOW (the repo computes these) ─────────────┐
  │  correctness · efficiency · route plausibility         │
  │  → answer "does it work?"                              │
  └────────────────────────────┬───────────────────────────┘
                               │  the wall: no metric on the
                               │  left answers a question on
                               │  the right
  ┌─ NEEDS USERS (only humans produce these) ──────────────┐
  │  adoption · switching · trust · retention              │
  │  → answer "do they want it?"                          │
  └────────────────────────────────────────────────────────┘
```

Everything left of the wall is **EVIDENCE** today. Everything right of
the wall is **INFERENCE** until the chapter-02 experiment runs. The wall
is the honesty line of the whole brief.

---

## Available-now metrics (provable from the repo)

These you can report with a straight face today. They prove the engine,
not the product.

### 1. Optimality oracle — the correctness gate

```
  Oracle metric — A* must equal Dijkstra

  ┌─ Dijkstra (uninformed) ─┐      ┌─ A* (informed) ──────┐
  │  finds optimal cost C    │  ==  │  finds the SAME C    │
  │  expands N nodes         │  ≤   │  expands ≤ N nodes   │
  └──────────────────────────┘      └──────────────────────┘
   astar.test.ts:38-44 (cost, 6dp)   astar.test.ts:47-52 (≤)
```

**The metric:** A* path cost equals Dijkstra path cost to 6 decimals, and
A* expands ≤ Dijkstra's node count, on a 12×12 grid. Pass/fail, in CI.
This is your strongest *available-now* number because it's a proof, not a
sample. → `../study-testing/01-optimality-oracle.md`.

### 2. Node-expansion efficiency — the bench

```
  Bench metric — fewer expansions = the heuristic works

  scenario           dijkstra   astar   ratio
  ───────────────    ────────   ─────   ─────
  grid30 interior      203       32     ~6.3×
  grid40 mid           1079      276    ~3.9×
  grid40 short          74        10    ~7.4×
```

**The metric:** A* expands 3.9–7.4× fewer nodes than Dijkstra on interior
pairs (`bench/run.ts`, `report.ts`). It measures that the admissible
haversine heuristic actually prunes. → `../study-performance-engineering/01-heuristic-pruning.md`.

### 3. Route plausibility — the eyeball check

**The metric:** on the bundled Capitol Hill graph, does the colored path
avoid the red blocks when a flatter alternative exists, and does the
honest fallback fire ("⚠ flattest available + N steep blocks") when none
does? This is qualitative and you run it yourself. It catches "the router
returns a path that's obviously dumb" — but it does **not** tell you a
user would take that path. It's a sanity gate, not a demand signal.

---

## Needs-users metrics (you cannot compute these)

These require the chapter-02 experiment. The repo has *zero*
infrastructure to produce them — no analytics SDK, no telemetry, no
deployment. State that plainly; don't pretend a proxy exists.

```
  Needs-users metrics — and why the repo can't fake them

  ┌─ adoption ────────► how many install / open it?         │
  │  repo has: no app-store build, no analytics, no counter  │
  ├─ switching ───────► do they leave Google Maps/AccessMap? │
  │  repo has: no comparison study, no user, no trial        │
  ├─ trust ───────────► do they believe the grade colors?    │
  │  repo has: no feedback channel, no on-route validation    │
  ├─ retention ───────► do they come back / use it twice?     │
  │  repo has: no sessions, no identity, no history (offline) │
  └──────────────────────────────────────────────────────────┘
```

**The single most important needs-users signal**, and the cheapest:
*would this person take this route?* It's qualitative, it's one
conversation, and it's the gate for every "build more" option in chapter
03. You don't need a dashboard to get it. You need one walker and one
honest question.

---

## The feedback loop

Tie the two columns together: the available-now metrics keep the engine
honest while you go get the needs-users signal.

```
  The loop — prove correctness, then go learn demand

  ┌─ CI / bench (available now) ──────────────────────────┐
  │  oracle stays green · bench ratios don't regress       │
  │  → the engine you'd demo is provably correct           │
  └────────────────────────┬───────────────────────────────┘
                           │  with a trustworthy demo in hand,
                           ▼
  ┌─ chapter-02 experiment (needs users) ─────────────────┐
  │  one real walker · one known route · one question:     │
  │  "is this the path you'd actually take?"               │
  └────────────────────────┬───────────────────────────────┘
                           │  the answer routes you to:
                           ▼
  ┌─ next move (chapter 03) ──────────────────────────────┐
  │  "yes, daily"        → expand coverage (C)             │
  │  "yes but distrust"  → harden DEM accuracy (D)         │
  │  "no, I'd go short"  → do nothing / reframe (A / E)    │
  └────────────────────────────────────────────────────────┘
```

**Why the loop is built this way:** the left box is automatable and free
— keep it green forever, it's table stakes. The right box is the
expensive truth, and it's *qualitative first* because you don't have
enough users for a quantitative read and faking one would be dishonest.
A single good conversation outranks a fabricated funnel.

---

## What you must NOT claim

```
  Banned moves — laundering left-column into right-column

  ┌────────────────────────────────────────────────────────┐
  │  ✗ "the oracle passes, so the routing is good"          │
  │     → correctness ≠ desirability                        │
  │  ✗ "A* is 6× faster, so users will love it"             │
  │     → speed ≠ adoption                                  │
  │  ✗ "the demo looks great, so there's a market"          │
  │     → one plausible route ≠ demand                      │
  └────────────────────────────────────────────────────────┘
```

When a reviewer asks "how do you know it's working?" the honest answer is
two sentences: "The engine is provably correct — oracle and bench, in CI.
Whether anyone *wants* it is unmeasured; the cheapest test is one walker,
one route, one question, and I haven't run it yet." That answer wins the
room precisely because it doesn't overclaim.

Next: `05-skeptical-reviewer-questions.md`.
