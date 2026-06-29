# Eval Methods
### industry: *scoring methods* — reference material (the eval ladder)

## Zoom out

```
THE EVAL LADDER — cheap+strict at the bottom, rich+noisy at the top
┌──────────────────────────────────────────────────────────────┐
│  6  HUMAN          gold standard, slow, expensive              │  ▲ richer
│  5  PAIRWISE       "A or B better?" — ranks without absolutes  │  │ noisier
│  4  LLM-AS-JUDGE   a model scores against a rubric             │  │
│  3  RUBRIC         scored checklist (contains X, ≤N sentences) │  │
│  2  FUZZY          similarity / regex / embedding distance     │  │
│  1  EXACT-MATCH    output == expected  (boolean, free)         │  ▼ cheaper
└──────────────────────────────────────────────────────────────┘
        determinism lets you live on rung 1; an LLM shoves you up
```

A "method" is *how you turn an output + expectation into a score*. The ladder is
ordered by a single trade: the more non-deterministic and open-ended the output,
the higher you must climb, paying in cost and noise for the ability to grade
something that has no single right string.

## How it works

**Move 1 — the pattern: pick the lowest rung that can grade your output.**

```
WHAT KIND OF OUTPUT IS IT?
  one correct value, byte-stable ───────────▶ rung 1  exact-match
  correct value, formatting wobble ──────────▶ rung 2  fuzzy
  many acceptable, but with required traits ─▶ rung 3  rubric
  open-ended prose, traits hard to regex ────▶ rung 4  LLM-judge
  "which is better" easier than "how good" ──▶ rung 5  pairwise
  nothing automated is trustworthy ──────────▶ rung 6  human
```

Mental model: you're not choosing a favorite method, you're being *forced upward*
by the output's degrees of freedom. Climbing costs money and adds variance, so the
discipline is to climb only as far as the output demands — never higher.

**Move 2 — why determinism pins you to rung 1.**

```
DETERMINISTIC OUTPUT                 NON-DETERMINISTIC OUTPUT (LLM)
┌──────────────────────┐            ┌──────────────────────────────┐
│ astar(g,S,G)         │            │ narrate(summary) at temp>0     │
│   → cost === 200      │            │   → "A flat-ish 200 m..." OR   │
│   EXACTLY, every run  │            │     "Mostly level, 200 m..."   │
│   ▼                   │            │   same facts, different bytes  │
│ expect(cost).toBe(200)│            │   exact-match → FALSE NEGATIVE │
└──────────────────────┘            │   ▼ must climb to fuzzy/rubric │
   rung 1 is SOUND here             └──────────────────────────────┘
```

If the same input always yields the same bytes, `toBe(...)` is not just adequate —
it's *optimal*: zero cost, zero noise, catches every drift. The instant output
varies legitimately across runs, exact-match starts failing *correct* answers, and
you're forced up to a method that scores *properties* instead of *bytes*.

**Move 3 — principle.** Determinism is an eval superpower; spend it. A problem with
a computable right answer should never be graded by an LLM. The eval method is a
*consequence* of the output's nature, not a stylistic choice.

## In this codebase

**Not yet exercised** for LLM — and that absence is the single cleanest teaching
contrast in this whole guide. flattr's entire eval surface lives on **rung 1**.

```
flattr = 100% rung 1 (exact-match), because routing is DETERMINISTIC
┌──────────────────────────────────────────────────────────────┐
│ summary.test.ts:43   expect(s.climbM).toBe(5)                  │
│ summary.test.ts:42   expect(s.distanceM).toBe(200)            │
│ fixtures.ts:46       "Known: shortest S→G = S,A,G (200)"      │
│ cost.test.ts / astar.test.ts / bidirectional.test.ts → exact  │
└──────────────────────────────────────────────────────────────┘
   every assertion is .toBe(...) — possible ONLY because the
   algorithm returns the same path/cost on every run
```

flattr can live on the cheapest, strictest rung because A* over a fixed graph is a
pure function: identical input, identical bytes. `routeSummary` (summary.ts:11) is
the same — pure arithmetic over the path. That's why `summary.test.ts` asserts exact
numbers and never a tolerance.

**The gap an LLM feature opens — concretely.** Add a narration at `summary.ts:11`
(`RouteSummary` → an English sentence at temp > 0) and `expect(text).toBe("...")`
becomes a flake machine: "A flat 200 m ride" and "Mostly level, 200 m" are both
*correct* and both *fail* exact-match. You are forced up the ladder:

```
narrate.ts forces the climb:
  rung 2 fuzzy   → regex /200\s?m/ , /\b5\s?m\b/ present
  rung 3 rubric  → ✓distance ✓climb ✓≤2 sentences ✓no street not in path
  rung 4 judge   → only if traits resist regex (tone, "is it clear?")
```

flattr has the *muscle* for rungs 1 — co-located vitest, exact fixtures, a habit of
encoding the known answer. It has never had to climb past rung 1 because it has
never produced a non-deterministic output. That climb *is* the LLM-eval discipline.

## See also
- `01-eval-set-types.md` — the datasets these methods score against
- `03-llm-as-judge-bias.md` — what breaks when you reach rung 4
- `features/routing/summary.test.ts`, `features/routing/cost.test.ts` — rung-1 reality
