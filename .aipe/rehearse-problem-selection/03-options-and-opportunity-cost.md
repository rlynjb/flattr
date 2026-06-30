# Options and Opportunity Cost

The mistake here is presenting one option ("build the thing") and calling
it analysis. A staff reviewer wants to see you *consider not building*,
rank the alternatives, and name what each one costs you. `do nothing` is
a real option and it ranks higher than your instinct wants it to —
because the engine is already built, so the marginal value of *more*
building is low until demand is shown.

---

## The options, as a decision shape

```
  Zoom out — five live options, ranked by what they cost a
  single developer with zero demand evidence

  ┌────────────────────────────────────────────────────────┐
  │  A. DO NOTHING / freeze        ← cheap, real, ranked #2 │
  │  B. VALIDATE the built slice   ← cheap, decisive, #1    │
  │  C. EXPAND coverage            ← expensive, premature   │
  │  D. HARDEN grade accuracy      ← medium, only if B says │
  │                                  trust is the blocker    │
  │  E. PIVOT to the algorithm     ← reframe: it's a        │
  │     as the artifact              portfolio piece        │
  └────────────────────────────────────────────────────────┘

  the axis being traced: $ of single-dev time spent BEFORE
  any human says "yes." B spends the least to learn the most.
```

---

## Option A — Do nothing (freeze it where it is)

**What it is:** stop. The engine is built, tested, oracle-correct, and
runs on one neighborhood. Leave it as a finished portfolio artifact and
invest your hours elsewhere.

**Opportunity cost:** you never learn whether the demand is real — but
you also stop pouring single-developer time into an unvalidated
hypothesis. Given zero users and zero telemetry, that's not a weak
option. It's the baseline every other option must beat.

```
  Do-nothing — what you keep, what you forgo

  KEEP (already banked)            FORGO
  ─────────────────────            ─────
  oracle-correct router  ✓         any demand signal
  bench-measured A*      ✓          any path to a product
  shipped on a city      ✓          the answer to "do they
  a clean portfolio piece            want it?"
```

**When A is correct:** if your goal for flattr was always "prove I can
hand-roll a correct, measured graph router" — and `me.md` says you build
fundamentals from scratch to make them real — then A is *already a win*.
The DSA portfolio gained a directional A* with an optimality oracle. Don't
let "ship a product" pressure erase a completed learning artifact.

## Option B — Validate the built slice (recommended)

**What it is:** run the experiment chapter 02 names. One real
self-powered traveler, one known route, one question: "is this the path
you'd actually take?" No code. No infrastructure. An afternoon.

**Opportunity cost:** a few hours of your time and the small ego risk of
hearing "no, I'd just take the short way." That risk *is the value* —
it's the cheapest way to learn the one thing the repo can't tell you.

```
  Option B — the cheapest decisive move

  cost:   ~1 afternoon, 0 lines of code
  learns: the ONE unprovable thing (demand / trust)
  unlocks: a real reason to pick C, D, A, or E next

  every other option is better-informed AFTER B runs.
  that's why it ranks #1.
```

**Why B beats jumping to C or D:** expanding coverage or sharpening grade
accuracy both assume you already know users want this. B is the test of
that assumption. Spend the afternoon before the month.

## Option C — Expand coverage (more neighborhoods / a city)

**What it is:** generalize the pipeline from one bbox to many; ship a
bigger graph or on-device tile rebuilds.

**Opportunity cost:** real engineering against two hard constraints. The
free Open-Meteo tier 429s under heavy elevation sampling
(`pipeline/elevation.ts` has retry/backoff and a flat-0m fallback for
exactly this), and the offline bundle must stay phone-friendly
(`data/graph.json` is already 532 KB for 0.35 km²). You'd spend weeks on
a scale problem to validate a demand hypothesis that one afternoon (B)
answers for free.

```
  Why C is premature — scale before signal

  ┌─ C builds: many neighborhoods ────────────────────────┐
  │  cost: weeks. constraint: free-tier 429s, bundle size  │
  │  validates: nothing new about DEMAND                   │
  │  → you'd have a bigger map nobody's asked for           │
  └────────────────────────────────────────────────────────┘
```

**When C becomes correct:** after B returns "yes, and I'd use it daily if
it covered my commute." Then coverage is the validated next bottleneck.

## Option D — Harden grade accuracy (better DEM)

**What it is:** replace or augment the 90m Open-Meteo DEM with finer
elevation so short steep pitches stop getting smoothed (spec §12 calls
grade accuracy "the whole product").

**Opportunity cost:** likely a paid elevation source — which breaks the
free-tier constraint — or a heavier sampling scheme that strains
build-time rate limits. Medium effort, and only worth it if B reveals
that *distrust of the colors* is what stops users, not lack of interest.

**When D is correct:** B says "I'd use it but I don't trust the green —
that block is steeper than it shows." Then accuracy is the validated
blocker. Not before.

## Option E — Reframe as the algorithm artifact (pivot the goal)

**What it is:** explicitly stop treating flattr as a product-in-waiting
and treat it as what the repo most strongly *is*: a hand-rolled,
oracle-verified, benchmarked directional A* — a portfolio centerpiece
for an AI/systems-engineering pivot.

**Opportunity cost:** you give up the product story. But you gain an
honest, defensible artifact that matches the constraint that's been true
all along — "the graph work is the point" (spec §14).

```
  Option E — what the repo is strongest at being

  product framing            artifact framing
  ───────────────            ────────────────
  needs users to win   →     wins on correctness alone
  demand unproven      →     oracle + bench ARE the proof
  one-dev disadvantage →     one-dev hand-roll is the FLEX
```

This isn't giving up. It's matching the claim to the evidence. The repo
proves Claim A (technically solvable) overwhelmingly; E is the option
that scores entirely on Claim A.

---

## The ranking, and why

```
  Ranked — most leverage per dev-hour, given zero demand data

  #1  B  validate the slice    cheap, decisive, unlocks all else
  #2  A  do nothing            free, banks a finished artifact
  #2  E  reframe as artifact   free, matches evidence to claim
  #4  D  harden accuracy       only if B says "trust" is blocker
  #5  C  expand coverage       only if B says "demand + reach"
```

A and E tie at #2 because they cost nothing and both are *honest landing
spots* — one stops, one re-labels. B is #1 because it's the only option
that buys you the missing information for the price of an afternoon. C
and D are real, but every reason to pick them depends on an answer only
B produces.

**The line you say:** "Before I write another line, I'd run the
afternoon test in option B. If it says no, I take option A or E and call
it a strong portfolio artifact. I don't expand coverage or chase DEM
accuracy until a real user tells me which one is the actual blocker."

That's the whole posture: cheap experiment first, `do nothing` on the
table, no scope spent ahead of signal.

Next: `04-success-metrics-and-feedback-loop.md`.
