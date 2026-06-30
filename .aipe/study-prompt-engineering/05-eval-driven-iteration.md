# 05 · Eval-driven prompt iteration

> Industry name: evals / eval-driven development / golden sets · Type label: Industry standard

> **Status: seam, not feature.** flattr has no prompts to evaluate — but it has the *exact substrate* an eval set is made of. `features/routing/fixtures.ts` is a hand-curated set of graphs with *known correct answers* ("shortest S→G = S,A,G (200)"). That's a golden set. This file maps eval discipline onto Seam 1/Seam 2 using flattr's golden graphs as the model.

## Zoom out — where this concept lives

This is the senior-vs-junior dividing line of prompt work, and flattr already practices its non-LLM twin. Its tests are golden cases with known outputs; its `bench/` harness records comparison metrics across versions. Here's where prompt evals would sit:

```
  Zoom out — evals around a prompt (the iteration loop)

  ┌─ Source ─────────────────────────────────────────────────────┐
  │  describe-prompt.ts  /  parse-destination.ts                 │
  └─────────────────────────┬────────────────────────────────────┘
                            │ change the prompt
  ┌─ Eval harness (SEAM) ───▼────────────────────────────────────┐
  │  ★ THIS FILE ★                                               │ ← we are here
  │  golden set (like fixtures.ts) → run prompt → score → diff   │
  │  keep change only if score ↑ AND no regression               │
  └─────────────────────────┬────────────────────────────────────┘
                            │ ship if green
  ┌─ Production ────────────▼────────────────────────────────────┐
  │  failures captured → added back to golden set, forever       │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **a junior iterates by vibes ("feels better now"); a senior iterates against an eval set — change prompt, run evals, diff outputs, keep the change only if the score improved without regressing a tracked case.** You write the eval *before* you touch the prompt. Let me build the loop.

## Structure pass

**Layers.** Three: the *golden set* (curated input→expected pairs), the *scorer* (how you turn an output into a number), and the *regression suite* (production failures pinned as permanent cases). flattr's `*.test.ts` files are layers 1 and 3 fused — `diamondGraph` asserts `S,A,G` and any router change that breaks it fails CI forever.

**Axis — guarantees (what does a passing run actually promise?).**

```
  One axis — "what does green mean?" — down the layers

  ┌─ golden set ─────────────────┐  → "matches curated expectations"
  └──────────────────────────────┘
      ┌─ scorer ─────────────────┐  → "measures the RIGHT thing?" ← the trap
      └──────────────────────────┘
          ┌─ regression suite ───┐  → "no past failure came back"
          └──────────────────────┘

  the seam: a scorer can be green for 6 months while measuring the
  wrong thing — that flip is invisible until you inspect outputs
```

**Seam.** The load-bearing boundary is *between the score and the truth it's supposed to track*. A rubric can read 4/5 for six months and turn out to have been measuring the wrong thing the whole time. The number flips from "trustworthy" to "lying" without any visible event — which is why you periodically eyeball outputs even when the score is green.

## How it works

### Move 1 — the mental model

You already write a test before you trust a refactor — flattr's `diamondGraph` test exists so that when you rewrite the router, `S,A,G` proves you didn't break it. An eval is that test, for a prompt. The only differences: the output is fuzzy (prose, not a deterministic path), so the scorer is sometimes another model, and you *expect* some noise, so you track score *distributions*, not pass/fail on one case.

```
  The eval-iteration kernel — the loop you never skip

  ┌──────────────────────────────────────────────────┐
  │ 1. write golden set (BEFORE touching the prompt)  │
  │ 2. change prompt                                  │
  │ 3. run prompt over golden set → outputs           │
  │ 4. score outputs → number                         │
  │ 5. diff vs previous: score ↑ AND no regression?   │
  │      yes → keep    no → revert                    │
  └──────────────────────────────────────────────────┘
          ▲                                  │
          └──── add production failures ◄────┘
                back into the golden set
```

### Move 2 — the step-by-step walkthrough

**The golden set — flattr already wrote one.** Look at the comment on `diamondGraph`:

```ts
// features/routing/fixtures.ts:42-46
/**
 * 6-node graph with a known shortest path by distance. Flat (all elevation 0).
 * Known: shortest S->G = S,A,G (200).
 */
export function diamondGraph(): Graph { ... }
```

That `Known: shortest S->G = S,A,G (200)` is a golden case: a curated input (the graph) with a known-correct output (the path). `gradeGraph` (`:70`) adds a flat-vs-steep choice; `directionalGraph` (`:88`) adds directional asymmetry. Three hand-curated cases, each probing a *different behavior*. That is exactly the shape of a prompt golden set: 20-50 hand-picked inputs, each chosen to probe one behavior, each with an expected output. For Seam 2 (NL parse), a golden case is `("flat route near the water" → {placeText:"...", near:"water", preferFlat:true})`. For Seam 1 (describe), it's `(RouteSummary → an acceptable sentence)` — and "acceptable" is where scoring gets interesting.

**The scorer — exact match for parse, judge for prose.** Seam 2's parse is structured (`02`), so the scorer is exact: did the struct match? Cheap and reliable, like asserting `S,A,G`. Seam 1's description is prose — there's no single right sentence — so you need either a rubric (mentions distance? mentions the climb iff `climbM>10`? ≤2 sentences?) or LLM-as-judge (a second model scores against the rubric). LLM-as-judge is appropriate *when the output is fuzzy and a rubric is hard to encode deterministically* — and it has the same blind spots as the model under test, so you validate the judge against human-labeled cases first (Hamel Husain's central point: your judge needs its own eval).

```
  Hop — scoring the two seams differently

  Seam 2 (parse):    output ─► exact match vs expected struct ─► 1/0
                     (deterministic, like asserting S,A,G)

  Seam 1 (describe): output ─► LLM-as-judge vs rubric ─► 0..1
                     (fuzzy — but VALIDATE the judge against humans first)
```

**The regression suite — production failures, pinned forever.** When Seam 1 ships and a real route produces a bad description ("flat" when `steepCount` was 3), that exact case becomes a permanent golden entry. flattr does this already in spirit: its `BLOCKED = 1e9` constant (`cost.ts:5`) and the "no flat route vs no route" distinction exist because someone reasoned through a failure and pinned the behavior. A regression suite is that, accumulated: every bug, once fixed, becomes a test that can never silently return.

**The iteration loop — write the eval first.** The order is the whole discipline. You write the golden set *before* you iterate the prompt, because otherwise you tune the prompt to your vibes and "discover" the cases that justify what you already did. flattr's `diamondGraph` was written knowing `S,A,G` *before* the router was optimized — that's why the optimization is trustworthy. Same here: golden set first, prompt second.

**The specific bug — average up, edge case down.** A "better" prompt improves the *average* score but regresses one critical edge case nobody tracked. This is why the keep-rule is `score ↑ AND no regression`, not `average ↑`. flattr's fixtures encode this exactly: `gradeGraph` exists so a router change that improves distance-routing can't silently break grade-routing. You don't average across `diamondGraph` and `gradeGraph` and call it 0.9 — you require *both* green. Aggregate scores hide the edge-case regression that gets you paged.

```
  Why "no regression" beats "average up"

  prompt v3:  [case A: 1.0][case B: 0.9][edge case C: 1.0]  avg 0.97
  prompt v4:  [case A: 1.0][case B: 1.0][edge case C: 0.2]  avg 0.73? no—
              someone reordered cases, avg LOOKS like 0.97 again...
  rule: track PER-CASE. C dropped 1.0→0.2 → REJECT, regardless of avg.
```

### Move 3 — the principle

Eval-driven iteration is the test-driven development you already do, ported to fuzzy outputs. You write the golden set before the prompt, score per-case not in aggregate, pin every production failure as a permanent case, and require score-up *with* no-regression. Skipping it is not faster — it's slower, because vibes-iteration loops in circles and you re-introduce yesterday's bug. flattr's `fixtures.ts` is the cleanest golden set I've seen in a router; the only thing it's missing is a prompt to point at.

## Primary diagram

The full eval-driven loop, golden set to regression suite, with the scorer-trust seam marked.

```
  Eval-driven iteration — the loop, anchored to fixtures.ts

  ┌─ Golden set (like fixtures.ts) ──────────────────────────────┐
  │ diamondGraph → S,A,G(200)   gradeGraph → flat path           │
  │ directionalGraph → detour   + 17 more curated cases          │
  └─────────────────────────┬────────────────────────────────────┘
        change prompt        │ run prompt over every case
  ┌─ Scorer ★trust seam★ ────▼────────────────────────────────────┐
  │ Seam 2: exact match    Seam 1: LLM-as-judge vs rubric        │
  │ (validate the judge against human labels — Hamel)            │
  └─────────────────────────┬────────────────────────────────────┘
                            │ per-case diff (NOT average)
  ┌─ Keep-rule ─────────────▼────────────────────────────────────┐
  │ score ↑ AND no case regressed?  yes→ship  no→revert          │
  └─────────────────────────┬────────────────────────────────────┘
                            │ prod failure
  ┌─ Regression suite ──────▼────────────────────────────────────┐
  │ every shipped bug → pinned golden case, forever (like BLOCKED)│
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Hamel Husain's writing on evals is the canonical reference and the source of the two hardest-won lessons here: (1) look at your data — eyeball real outputs, don't trust the aggregate score; (2) your LLM-judge needs its own eval against human labels, or you've just moved the trust problem one layer down. This is the discipline that is genuinely non-negotiable for production prompt work — every other concept in this folder is a technique, but evals are the *measurement* that tells you whether a technique helped. flattr is an unusually good teacher for it because its `fixtures.ts` already demonstrates the golden-set shape (curated input + known output + one-behavior-per-case) without any LLM in the picture — the discipline is visible in isolation.

## Project exercises

### EX-EVAL-1 — Golden set + judge for Seam 1 descriptions

- **Exercise ID:** EX-EVAL-1
- **What to build:** A golden set of `(RouteSummary → acceptable-sentence)` cases derived from `fixtures.ts` graphs, plus an LLM-as-judge scorer with a rubric (mentions distance, mentions climb iff `climbM>10`, ≤2 sentences), and a per-case keep-rule.
- **Why it earns its place:** Forces the judge-validation step (does the judge agree with you on 10 hand-labeled cases?) and the per-case-not-average discipline.
- **Files to touch:** new `features/routing/describe.eval.ts`; sources `RouteSummary` from `summary.ts`, graphs from `fixtures.ts`.
- **Done when:** a prompt change that improves average but regresses one case is correctly rejected.
- **Estimated effort:** 4-6 hours.

## Interview defense

**Q: How do you iterate on a prompt without going in circles?**

Write a golden set *before* touching the prompt, then loop: change → run over the set → score per-case → keep only if score up with no regression. Vibes-iteration loops forever because there's no ground truth; the golden set is the ground truth.

```
  junior:  change → "feels better" → ship → regress → repeat
  senior:  golden set FIRST → change → score → diff → keep iff no regression
```

Anchor: flattr's `diamondGraph` asserts `S,A,G` *before* the router is optimized — that's why the optimization is trustworthy. Same order for prompts.

**Q: A new prompt raised the average score. Ship it?**

Not on average alone. Check per-case — a higher average can hide a critical edge-case regression. The keep-rule is score-up *and* no tracked case regressed. And periodically eyeball outputs, because a green score can measure the wrong thing for months.

## See also

- `02-structured-outputs.md` — exact-match scoring for the parse seam
- `03-prompts-as-code.md` — the eval run a prompt PR must trigger
- `09-chain-of-thought.md` — evals tell you if CoT actually helped or just cost tokens
- `10-self-critique.md` — self-critique's gains are claimed only if evals confirm them
