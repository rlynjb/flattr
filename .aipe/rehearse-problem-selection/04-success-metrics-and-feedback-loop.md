# Success Metrics and Feedback Loop — flattr

> Two buckets, kept strictly apart: metrics you can produce **today** from the
> repo (engine truth) and metrics that **need users** (demand truth). The
> dishonest move is to dress an available-now metric up as proof of demand. This
> file refuses to do that.

## The split that keeps you honest

```
  flattr metrics — two buckets, never conflated

  ┌─ AVAILABLE NOW (engine truth) ──────────┐   ┌─ NEEDS USERS (demand truth) ──────┐
  │ measurable from the repo, today          │   │ measurable only with the           │
  │                                          │   │ discovery slice (02)               │
  │ • A* == Dijkstra optimality (oracle)     │   │ • adoption: do people use it twice?│
  │ • node-expansion ratio (bench harness)   │   │ • switching: flattr route chosen   │
  │ • route plausibility (gentler than the   │   │     over the default route?        │
  │     straight line on known-hilly A→B)    │   │ • trust: do they believe the       │
  │ • honest-fallback correctness            │   │     colors / climb number?         │
  │     (flat-flag vs. null)                  │   │                                    │
  └──────────────────────────────────────────┘   └────────────────────────────────────┘
        proves the thing WORKS                          proves the thing is WANTED
        (you have this)                                  (you do NOT have this)
```

A green left bucket tells you the engine is correct. It tells you **nothing**
about whether to keep building. Only the right bucket does.

## Bucket 1 — available now (you can run these today)

Each is producible from the repo with no users.

### 1a. A* == Dijkstra optimality (the oracle metric)

- **What:** for every fixed (start, goal) pair, A*'s path cost equals Dijkstra's,
  and A* expands no more nodes than Dijkstra.
- **Where it's already checked:** `features/routing/astar.test.ts:38`
  (`toBeCloseTo` on cost) and `:47,:51` (`toBeLessThanOrEqual` on
  `nodesExpanded`). Dijkstra is the ground-truth oracle.
- **Pass bar:** equal cost to 6 digits; A* expansions ≤ Dijkstra on every pair.
- **What it proves:** the heuristic is admissible and the router is optimal.
  Nothing about demand.

### 1b. Node-expansion / work ratio (the bench metric)

- **What:** per (start, goal), per algorithm — `nodesExpanded`, `pushes`,
  `pops`, `ms`, `cost`. The A*/Dijkstra expansion *ratio* is the headline.
- **Where:** `bench/run.ts` runs the stages over interior pairs;
  `bench/report.ts` `formatTable` prints the comparison. `npm run bench`.
- **Pass bar:** A* expands materially fewer nodes than Dijkstra for the same
  cost; bidirectional fewer still on the distance problem.
- **What it proves:** the refinements pay off — the spec §15.2 progression story
  is real and measured, not asserted.

### 1c. Route plausibility (the domain-sanity metric)

- **What:** on a *known-hilly* A→B, the grade-routed path has lower total climb
  (`climbM`) than the shortest path, at the cost of some extra distance — i.e.
  the router actually trades distance for flatness.
- **Where:** `summary.ts` `routeSummary` returns `{distanceM, climbM,
  steepCount}`; compare grade-routed vs. distance-only over the same pair.
- **Pass bar:** grade route's `climbM` < distance route's `climbM` on pitches
  that exceed `userMax`. This is the "Pike Place → Broadway returns a gentler
  path" check from spec §10 Phase 2.
- **Honesty caveat:** plausibility is gated by elevation accuracy. Spec §12 —
  coarse elevation makes the map "lie about the steep blocks." So this metric is
  only as trustworthy as the free Open-Meteo data feeding it. State that.

### 1d. Honest-fallback correctness

- **What:** an only-steep route returns a *flagged* path (not `null`); a
  genuinely disconnected pair returns `null`.
- **Where:** `cost.ts:6` `BLOCKED = 1e9` (finite) drives this; the distinction is
  walked in `.aipe/study-system-design/04-honest-fallback-routing.md`.
- **Pass bar:** the two states never collapse into one.

## Bucket 2 — needs users (you cannot fake these)

These require the discovery slice from `02`. Until it runs, every one of these is
**unknown**, and saying otherwise is the dishonesty this book exists to prevent.

```
  the demand feedback loop — only the slice closes it

  ┌─ show A→B in flattr + Google Maps ─┐
  │  to a real self-powered traveler    │
  └─────────────────┬───────────────────┘
                    │  observe + ask
                    ▼
  ┌─ record 3 things ──────────────────┐
  │  1. SWITCHING: which route chosen?  │
  │  2. REASON: was "grade" the reason? │
  │  3. TRUST: did they believe the     │
  │     colors / climb number?          │
  └─────────────────┬───────────────────┘
                    │  repeat ×5 travelers
                    ▼
  ┌─ decide ───────────────────────────┐
  │  ≥3/5 prefer flattr FOR the grade   │
  │    → demand signal, consider more   │
  │  <3/5 or "didn't care"              │
  │    → premise weak, stop / pivot     │
  └─────────────────────────────────────┘
```

- **Adoption** — would they use it again for their real commute? (Binary,
  per-person. No infrastructure needed — just ask.)
- **Switching** — shown both routes, do they pick flattr's? This is *the* metric.
  It directly tests the spec §1 premise that Google Maps under-serves them.
- **Trust** — do they believe the colored grades and the climb number, or do they
  override it with local knowledge? (If they don't trust it, accuracy — bucket
  1c — is the real blocker.)

**Deliberately not invented:** no DAU/MAU, no retention curve, no conversion
rate, no NPS, no market size. There is no product live, so there is no funnel.
Putting a number on any of these now would be fabrication.

## The one rule for using these metrics

When you present flattr, lead with bucket 1 framed as *"the engine is provably
correct"* and bucket 2 framed as *"demand is unmeasured — here's exactly the
experiment that would measure it."* Never let a green bucket-1 metric stand in
for a bucket-2 answer. That conflation is the single trap a sharp reviewer is
listening for.

## See also

- `02-scope-cuts-and-non-goals.md` — the slice that produces bucket-2 metrics.
- `05-skeptical-reviewer-questions.md` — handling "your metrics don't prove
  anyone wants this."
- `.aipe/study-performance-engineering/02-heuristic-pruning.md` — the
  node-expansion win behind metric 1b.
- `.aipe/study-testing/` — where the oracle-gate tests (metric 1a) live.
